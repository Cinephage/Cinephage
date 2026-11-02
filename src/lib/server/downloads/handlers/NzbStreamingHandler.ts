import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { getNzbMountManager } from '#lib/server/streaming/nzb/index.js';
import { strmService, getStreamingBaseUrl } from '#lib/server/streaming/index.js';
import { getUsenetStreamService } from '#lib/server/streaming/usenet/UsenetStreamService.js';
import { mediaInfoService } from '#lib/server/library/media-info.js';
import { getLibraryRelativePath } from '#lib/server/library/media-paths.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { createChildLogger } from '#lib/logging/index.js';
import { db } from '#lib/server/db/index.js';
import {
	movies,
	movieFiles,
	series,
	episodes,
	episodeFiles,
	downloadHistory
} from '#lib/server/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { GrabRequest, ResolvedContext, HandlerResult } from '../grab-types.js';

const logger = createChildLogger({ module: 'NzbStreamingHandler' });
const parser = new ReleaseParser();

type EpisodeFileUpsertInput = Omit<typeof episodeFiles.$inferInsert, 'id'> & { id?: string };

async function upsertEpisodeFileByPath(record: EpisodeFileUpsertInput): Promise<string> {
	const { id: requestedId, ...values } = record;

	const existing = await db
		.select({ id: episodeFiles.id })
		.from(episodeFiles)
		.where(
			and(
				eq(episodeFiles.seriesId, record.seriesId),
				eq(episodeFiles.relativePath, record.relativePath)
			)
		)
		.limit(1);

	if (existing.length > 0) {
		await db.update(episodeFiles).set(values).where(eq(episodeFiles.id, existing[0].id));
		return existing[0].id;
	}

	const id = requestedId ?? randomUUID();
	await db
		.insert(episodeFiles)
		.values({ id, ...values })
		.onConflictDoNothing();
	return id;
}

export class NzbStreamingHandler {
	async handle(request: GrabRequest, resolved: ResolvedContext): Promise<HandlerResult> {
		const { release } = request;
		const { movieId, seriesId, episodeIds, seasonNumber, mediaType } = resolved;

		if (!release.downloadUrl) {
			return { success: false, error: 'Download URL required for NZB streaming' };
		}

		const indexerManager = await getIndexerManager();
		const indexer = release.indexerId
			? await indexerManager.getIndexerInstance(release.indexerId)
			: null;

		let nzbContent: Buffer | null = null;

		if (indexer && indexer.downloadTorrent) {
			try {
				const result = await indexer.downloadTorrent(release.downloadUrl, {
					releaseDetailsUrl: release.commentsUrl
				});
				if (result.success && result.data) {
					nzbContent = result.data;
				}
			} catch (fetchError) {
				const message = fetchError instanceof Error ? fetchError.message : 'Unknown error';
				return { success: false, error: `Error fetching NZB: ${message}` };
			}
		}

		if (!nzbContent) {
			try {
				const response = await fetch(release.downloadUrl);
				if (response.ok) {
					nzbContent = Buffer.from(await response.arrayBuffer());
				}
			} catch {
				// fallback fetch failed
			}
		}

		if (!nzbContent || nzbContent.length === 0) {
			return { success: false, error: 'Failed to fetch NZB content' };
		}

		const nzbMountManager = getNzbMountManager();
		let mount;

		try {
			mount = await nzbMountManager.createMount({
				nzbContent,
				title: release.title,
				indexerId: release.indexerId,
				downloadUrl: release.downloadUrl,
				movieId,
				seriesId,
				seasonNumber,
				episodeIds
			});
		} catch (mountError) {
			const message = mountError instanceof Error ? mountError.message : 'Unknown error';
			return { success: false, error: `Failed to create stream mount: ${message}` };
		}

		const streamService = getUsenetStreamService();
		const streamability = await streamService.checkStreamability(mount.id);

		if (!streamability.canStream) {
			await nzbMountManager.deleteMount(mount.id);
			return {
				success: false,
				error: streamability.error || 'Cannot stream this release'
			};
		}

		const baseUrl = await getStreamingBaseUrl('http://localhost:5173');

		const parsedRelease = parser.parse(release.title);
		const quality = {
			resolution: parsedRelease.resolution ?? undefined,
			source: parsedRelease.source ?? 'Usenet',
			codec: parsedRelease.codec ?? undefined,
			hdr: parsedRelease.hdr ?? undefined
		};

		const createdFiles: string[] = [];

		if (mediaType === 'movie' && movieId) {
			const movie = await db.query.movies.findFirst({
				where: eq(movies.id, movieId),
				with: { rootFolder: true }
			});

			if (!movie || !movie.rootFolder) {
				return { success: false, error: 'Movie or root folder not found' };
			}
			const allowStrmProbe = movie.scoringProfileId !== 'streamer';

			if (mount.mediaFiles.length > 0) {
				const mediaFile = mount.mediaFiles[0];
				const strmResult = await strmService.createNzbStrmFile({
					mountId: mount.id,
					fileIndex: mediaFile.index,
					movieId,
					baseUrl
				});

				if (strmResult.success && strmResult.filePath) {
					const stats = statSync(strmResult.filePath);
					const mediaInfo = await mediaInfoService.extractMediaInfo(strmResult.filePath, {
						allowStrmProbe
					});
					const relativePath = getLibraryRelativePath(
						movie.rootFolder.path,
						movie.path,
						strmResult.filePath
					);

					// Upsert by (movieId, relativePath): .strm destinations are
					// deterministic, so re-grabs update the existing row instead
					// of stacking duplicates (movieFiles has a unique index).
					const fileValues = {
						movieId,
						relativePath,
						size: stats.size,
						dateAdded: new Date().toISOString(),
						sceneName: release.title,
						releaseGroup: parsedRelease.releaseGroup ?? 'NZB',
						edition: parsedRelease.edition ?? undefined,
						quality,
						mediaInfo
					};
					let fileId: string;
					const existingRow = await db.query.movieFiles.findFirst({
						where: and(eq(movieFiles.movieId, movieId), eq(movieFiles.relativePath, relativePath))
					});
					if (existingRow) {
						fileId = existingRow.id;
						await db.update(movieFiles).set(fileValues).where(eq(movieFiles.id, fileId));
					} else {
						fileId = randomUUID();
						await db.insert(movieFiles).values({ id: fileId, ...fileValues });
					}

					await db.update(movies).set({ hasFile: true }).where(eq(movies.id, movieId));

					await db.insert(downloadHistory).values({
						title: release.title,
						indexerId: release.indexerId,
						indexerName: release.indexerName,
						protocol: 'usenet',
						movieId,
						status: 'streaming',
						size: mount.totalSize,
						quality,
						importedPath: strmResult.filePath,
						movieFileId: fileId,
						grabbedAt: new Date().toISOString(),
						importedAt: new Date().toISOString()
					});

					createdFiles.push(fileId);
				}
			}
		} else if (mediaType === 'tv' && seriesId) {
			const show = await db.query.series.findFirst({
				where: eq(series.id, seriesId),
				with: { rootFolder: true }
			});

			if (!show || !show.rootFolder) {
				return { success: false, error: 'Series or root folder not found' };
			}
			const allowStrmProbe = show.scoringProfileId !== 'streamer';

			for (const mediaFile of mount.mediaFiles) {
				const fileParsed = parser.parse(mediaFile.name);
				const season = fileParsed.episode?.season ?? seasonNumber;
				const episode = fileParsed.episode?.episodes?.[0];

				if (season === undefined || episode === undefined) continue;

				const episodeRow = await db.query.episodes.findFirst({
					where: and(
						eq(episodes.seriesId, seriesId),
						eq(episodes.seasonNumber, season),
						eq(episodes.episodeNumber, episode)
					)
				});

				if (!episodeRow) continue;

				const strmResult = await strmService.createNzbStrmFile({
					mountId: mount.id,
					fileIndex: mediaFile.index,
					seriesId,
					seasonNumber: season,
					episodeId: episodeRow.id,
					baseUrl
				});

				if (strmResult.success && strmResult.filePath) {
					const stats = statSync(strmResult.filePath);
					const mediaInfo = await mediaInfoService.extractMediaInfo(strmResult.filePath, {
						allowStrmProbe
					});
					const relativePath = getLibraryRelativePath(
						show.rootFolder.path,
						show.path,
						strmResult.filePath
					);

					const fileId = await upsertEpisodeFileByPath({
						seriesId,
						seasonNumber: season,
						episodeIds: [episodeRow.id],
						relativePath,
						size: stats.size,
						dateAdded: new Date().toISOString(),
						sceneName: release.title,
						releaseGroup: parsedRelease.releaseGroup ?? 'NZB',
						edition: parsedRelease.edition ?? undefined,
						quality,
						mediaInfo
					});

					await db.update(episodes).set({ hasFile: true }).where(eq(episodes.id, episodeRow.id));

					createdFiles.push(fileId);
				}
			}

			if (createdFiles.length > 0) {
				await db.insert(downloadHistory).values({
					title: release.title,
					indexerId: release.indexerId,
					indexerName: release.indexerName,
					protocol: 'usenet',
					seriesId,
					episodeIds: episodeIds ?? [],
					seasonNumber,
					status: 'streaming',
					size: mount.totalSize,
					quality,
					episodeFileIds: createdFiles,
					grabbedAt: new Date().toISOString(),
					importedAt: new Date().toISOString()
				});
			}
		}

		if (createdFiles.length === 0) {
			return { success: false, error: 'Failed to create any .strm files' };
		}

		logger.info(
			{
				title: release.title,
				mountId: mount.id,
				filesCreated: createdFiles.length
			},
			'NZB streaming grab completed'
		);

		if (mediaType === 'movie' && movieId) {
			libraryMediaEvents.emitMovieUpdated(movieId);
		} else if (mediaType === 'tv' && seriesId) {
			libraryMediaEvents.emitSeriesUpdated(seriesId);
		}

		return {
			success: true,
			queueId: mount.id,
			hash: mount.nzbHash,
			clientId: 'nzb-streaming',
			clientName: 'NZB Streaming',
			category: mediaType === 'movie' ? 'movies' : 'tv'
		};
	}
}
