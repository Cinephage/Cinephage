import { strmService, StrmService, getStreamingBaseUrl } from '#lib/server/streaming/index.js';
import { getOwnerStreamingApiKey } from '#lib/server/auth/index.js';
import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import { mediaInfoService } from '#lib/server/library/media-info.js';
import { getLibraryRelativePath } from '#lib/server/library/media-paths.js';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { searchSubtitlesForNewMedia } from '#lib/server/subtitles/services/SubtitleImportService.js';
import { fileExists, importService } from '#lib/server/downloadClients/import/index.js';
import { deletePhysicalFile } from '#lib/server/downloadClients/import/FileTransfer.js';
import { getFileManagementSettings } from '#lib/server/settings/file-management.js';
import { eventBuffer } from '#lib/server/sse/EventBuffer.js';
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
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveMovieMultiQuality } from '#lib/server/quality/movie-buckets.js';
import {
	computeMovieReplacement,
	computeEpisodeReplacement
} from '#lib/server/downloadClients/import/replacement.js';
import type { Resolution } from '#lib/server/indexers/parser/types.js';
import type { GrabRequest, ResolvedContext, HandlerResult } from '../grab-types.js';

const logger = createChildLogger({ module: 'StreamingHandler' });
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

export class StreamingHandler {
	private streamingKeyCache: { available: boolean; checkedAt: number } | null = null;
	private streamingKeyWarned = false;
	private static readonly STREAMING_KEY_CACHE_TTL_MS = 60_000;

	private async isStreamingKeyAvailable(): Promise<boolean> {
		const now = Date.now();
		if (
			this.streamingKeyCache &&
			now - this.streamingKeyCache.checkedAt < StreamingHandler.STREAMING_KEY_CACHE_TTL_MS
		) {
			return this.streamingKeyCache.available;
		}

		try {
			const key = await getOwnerStreamingApiKey();
			const available = !!key;
			this.streamingKeyCache = { available, checkedAt: now };
			if (available) {
				this.streamingKeyWarned = false;
			}
			return available;
		} catch {
			this.streamingKeyCache = { available: false, checkedAt: now };
			return false;
		}
	}

	async handle(request: GrabRequest, resolved: ResolvedContext): Promise<HandlerResult> {
		const { release } = request;
		const { movieId, seriesId, seasonNumber, mediaType } = resolved;

		if (!(await this.isStreamingKeyAvailable())) {
			if (!this.streamingKeyWarned) {
				logger.warn(
					'Streaming API key not configured - skipping streaming releases. Generate API keys in Settings > System.'
				);
				this.streamingKeyWarned = true;
			}
			return {
				success: false,
				error: 'Streaming API key not configured. Generate API keys in Settings > System.'
			};
		}

		const parsed = StrmService.parseStreamUrl(release.downloadUrl ?? '');
		if (!parsed) {
			return { success: false, error: `Invalid streaming URL: ${release.downloadUrl}` };
		}

		const baseUrl = await getStreamingBaseUrl('http://localhost:5173');

		if (parsed.isCompleteSeries && mediaType === 'tv' && seriesId) {
			return this.handleCompleteSeries(request, resolved, parsed, baseUrl);
		}

		if (parsed.isSeasonPack && mediaType === 'tv' && seriesId && parsed.season !== undefined) {
			return this.handleSeasonPack(request, resolved, parsed, baseUrl);
		}

		const result = await strmService.createStrmFile({
			mediaType,
			tmdbId: parsed.tmdbId,
			movieId,
			seriesId,
			season: parsed.season ?? seasonNumber,
			episode: parsed.episode,
			baseUrl
		});

		if (!result.success || !result.filePath) {
			return { success: false, error: result.error };
		}

		return this.importStreamingFile(request, resolved, parsed, result.filePath);
	}

	private async importStreamingFile(
		request: GrabRequest,
		resolved: ResolvedContext,
		parsedStream: NonNullable<ReturnType<typeof StrmService.parseStreamUrl>>,
		filePath: string
	): Promise<HandlerResult> {
		const { release, options } = request;
		const { movieId, seriesId, mediaType } = resolved;
		const isUpgrade = options.isUpgrade;

		try {
			const stats = statSync(filePath);
			const fileSize = Number(stats.size);
			let allowStrmProbe = true;
			if (mediaType === 'movie' && movieId) {
				const movie = await db.query.movies.findFirst({ where: eq(movies.id, movieId) });
				allowStrmProbe = movie?.scoringProfileId !== 'streamer';
			} else if (mediaType === 'tv' && seriesId) {
				const show = await db.query.series.findFirst({ where: eq(series.id, seriesId) });
				allowStrmProbe = show?.scoringProfileId !== 'streamer';
			}
			const mediaInfo = await mediaInfoService.extractMediaInfo(filePath, { allowStrmProbe });

			const parsedRelease = parser.parse(release.title);
			const quality = {
				resolution: parsedRelease.resolution ?? '1080p',
				source: 'Streaming',
				codec: 'HLS',
				hdr: undefined
			};

			if (mediaType === 'movie' && movieId) {
				return this.importStreamingMovie(release, {
					movieId,
					filePath,
					fileSize,
					mediaInfo,
					quality,
					parsedRelease,
					isUpgrade
				});
			} else if (
				mediaType === 'tv' &&
				seriesId &&
				parsedStream.season !== undefined &&
				parsedStream.episode !== undefined
			) {
				return this.importStreamingEpisode(release, {
					seriesId,
					season: parsedStream.season,
					episode: parsedStream.episode,
					filePath,
					fileSize,
					mediaInfo,
					quality,
					parsedRelease,
					isUpgrade
				});
			}

			return { success: false, error: 'Invalid media type or missing required IDs' };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return { success: false, error: `Database error: ${message}` };
		}
	}

	private async importStreamingMovie(
		release: GrabRequest['release'],
		options: {
			movieId: string;
			filePath: string;
			fileSize: number;
			mediaInfo: Awaited<ReturnType<typeof mediaInfoService.extractMediaInfo>>;
			quality: { resolution: string; source: string; codec: string; hdr: undefined };
			parsedRelease: ReturnType<typeof parser.parse>;
			isUpgrade?: boolean;
		}
	): Promise<HandlerResult> {
		const { movieId, filePath, fileSize, mediaInfo, quality, parsedRelease, isUpgrade } = options;

		const movie = await db.query.movies.findFirst({
			where: eq(movies.id, movieId),
			with: { rootFolder: true }
		});

		if (!movie || !movie.rootFolder) {
			return { success: false, error: 'Movie or root folder not found' };
		}

		const relativePath = getLibraryRelativePath(movie.rootFolder.path, movie.path, filePath);

		// Resolve multi-quality context so a streaming grab only replaces the file
		// in the same resolution bucket, never the other tiers.
		const { multiQuality } = await resolveMovieMultiQuality(
			movie.desiredQualities,
			movie.scoringProfileId
		);
		const newResolution = quality.resolution as Resolution | undefined;

		// .strm destinations are deterministic (title/year/tmdbId): an existing
		// row for the same path is updated in place, so re-grabs never create
		// duplicates and never unlink their own file (self-deletion bug).
		const samePathRow = await db.query.movieFiles.findFirst({
			where: and(eq(movieFiles.movieId, movieId), eq(movieFiles.relativePath, relativePath))
		});

		const fileId = samePathRow?.id ?? randomUUID();
		if (samePathRow) {
			await db
				.update(movieFiles)
				.set({
					size: fileSize,
					dateAdded: new Date().toISOString(),
					sceneName: release.title,
					releaseGroup: parsedRelease.releaseGroup ?? 'Streaming',
					edition: parsedRelease.edition ?? undefined,
					quality,
					mediaInfo
				})
				.where(eq(movieFiles.id, fileId));
		} else {
			await db.insert(movieFiles).values({
				id: fileId,
				movieId,
				relativePath,
				size: fileSize,
				dateAdded: new Date().toISOString(),
				sceneName: release.title,
				releaseGroup: parsedRelease.releaseGroup ?? 'Streaming',
				edition: parsedRelease.edition ?? undefined,
				quality,
				mediaInfo
			});
		}

		await db.update(movies).set({ hasFile: true }).where(eq(movies.id, movieId));

		// Retire AFTER registration, selected from current state via the
		// shared policy. The just-written row is excluded by id — the old
		// delete-before-insert order unlinked the fresh .strm.
		await this.retireMovieFiles(movieId, movie.rootFolder.path, movie.path, {
			multiQuality,
			newResolution,
			keepFileIds: [fileId]
		});

		await db.insert(downloadHistory).values({
			title: release.title,
			indexerId: release.indexerId,
			indexerName: release.indexerName,
			protocol: 'streaming',
			movieId,
			status: 'streaming',
			size: fileSize,
			quality,
			importedPath: filePath,
			movieFileId: fileId,
			grabbedAt: new Date().toISOString(),
			importedAt: new Date().toISOString()
		});

		libraryMediaEvents.emitMovieUpdated(movieId);

		const movieEvent = {
			mediaType: 'movie' as const,
			movieId,
			importedPath: filePath,
			file: {
				id: fileId,
				relativePath,
				size: fileSize,
				dateAdded: new Date().toISOString(),
				sceneName: release.title,
				releaseGroup: parsedRelease.releaseGroup ?? 'Streaming',
				quality,
				mediaInfo
			},
			wasUpgrade: isUpgrade ?? false,
			timestamp: Date.now()
		};
		importService.emit('file:imported', movieEvent);
		eventBuffer.add(movieEvent);

		void this.triggerSubtitleSearch('movie', movieId);

		return {
			success: true,
			queueId: fileId,
			clientId: 'streaming',
			clientName: 'Streaming',
			category: 'movies'
		};
	}

	private async importStreamingEpisode(
		release: GrabRequest['release'],
		options: {
			seriesId: string;
			season: number;
			episode: number;
			filePath: string;
			fileSize: number;
			mediaInfo: Awaited<ReturnType<typeof mediaInfoService.extractMediaInfo>>;
			quality: { resolution: string; source: string; codec: string; hdr: undefined };
			parsedRelease: ReturnType<typeof parser.parse>;
			isUpgrade?: boolean;
		}
	): Promise<HandlerResult> {
		const {
			seriesId,
			season,
			episode,
			filePath,
			fileSize,
			mediaInfo,
			quality,
			parsedRelease,
			isUpgrade
		} = options;

		const show = await db.query.series.findFirst({
			where: eq(series.id, seriesId),
			with: { rootFolder: true }
		});

		if (!show || !show.rootFolder) {
			return { success: false, error: 'Series or root folder not found' };
		}

		const episodeRow = await db.query.episodes.findFirst({
			where: and(
				eq(episodes.seriesId, seriesId),
				eq(episodes.seasonNumber, season),
				eq(episodes.episodeNumber, episode)
			)
		});

		if (!episodeRow) {
			return { success: false, error: `Episode S${season}E${episode} not found` };
		}

		const relativePath = getLibraryRelativePath(show.rootFolder.path, show.path, filePath);

		const fileId = await upsertEpisodeFileByPath({
			seriesId,
			seasonNumber: season,
			episodeIds: [episodeRow.id],
			relativePath,
			size: fileSize,
			dateAdded: new Date().toISOString(),
			sceneName: release.title,
			releaseGroup: parsedRelease.releaseGroup ?? 'Streaming',
			edition: parsedRelease.edition ?? undefined,
			quality,
			mediaInfo
		});

		await db.update(episodes).set({ hasFile: true }).where(eq(episodes.id, episodeRow.id));

		// Register-then-retire: overlapping files are selected from current
		// state after the new row exists (coverage rule, self-deletion guard).
		await this.retireEpisodeFiles(seriesId, [episodeRow.id], show.rootFolder.path, show.path, {
			keepFileIds: [fileId]
		});

		await db.insert(downloadHistory).values({
			title: release.title,
			indexerId: release.indexerId,
			indexerName: release.indexerName,
			protocol: 'streaming',
			seriesId,
			episodeIds: [episodeRow.id],
			seasonNumber: season,
			status: 'streaming',
			size: fileSize,
			quality,
			importedPath: filePath,
			episodeFileIds: [fileId],
			grabbedAt: new Date().toISOString(),
			importedAt: new Date().toISOString()
		});

		libraryMediaEvents.emitSeriesUpdated(seriesId);

		const episodeEvent = {
			mediaType: 'episode' as const,
			seriesId,
			episodeIds: [episodeRow.id],
			seasonNumber: season,
			importedPath: filePath,
			file: {
				id: fileId,
				relativePath,
				size: fileSize,
				dateAdded: new Date().toISOString(),
				sceneName: release.title,
				releaseGroup: parsedRelease.releaseGroup ?? 'Streaming',
				quality,
				mediaInfo
			},
			wasUpgrade: isUpgrade ?? false,
			timestamp: Date.now()
		};
		importService.emit('file:imported', episodeEvent);
		eventBuffer.add(episodeEvent);

		void this.triggerSubtitleSearch('episode', episodeRow.id);

		return {
			success: true,
			queueId: fileId,
			clientId: 'streaming',
			clientName: 'Streaming',
			category: 'tv'
		};
	}

	/**
	 * Complete-series (`stream://tv/{id}/all`) grabs: expand into per-season
	 * packs and import each, so indexer results that emit `/all` are handled
	 * instead of failing the single-episode path.
	 */
	private async handleCompleteSeries(
		request: GrabRequest,
		resolved: ResolvedContext,
		parsedStream: NonNullable<ReturnType<typeof StrmService.parseStreamUrl>>,
		baseUrl: string
	): Promise<HandlerResult> {
		const { seriesId } = resolved;
		if (!seriesId) {
			return { success: false, error: 'seriesId is required for a complete-series grab' };
		}

		const show = await db.query.series.findFirst({
			where: eq(series.id, seriesId)
		});
		if (!show) {
			return { success: false, error: 'Series not found' };
		}

		const seriesEpisodes = await db.query.episodes.findMany({
			where: eq(episodes.seriesId, seriesId)
		});
		const seasonNumbers = [...new Set(seriesEpisodes.map((episode) => episode.seasonNumber))]
			.filter((seasonNumber) => seasonNumber > 0) // Season 0 (specials) is excluded
			.sort((a, b) => a - b);

		if (seasonNumbers.length === 0) {
			return { success: false, error: 'Series has no episodes to stream' };
		}

		let successResult: HandlerResult | null = null;
		let lastError: string | undefined;

		for (const seasonNumber of seasonNumbers) {
			const seasonResult = await this.handleSeasonPack(
				request,
				resolved,
				parsedStream,
				baseUrl,
				seasonNumber
			);
			if (seasonResult.success) {
				successResult ??= seasonResult;
			} else {
				lastError = seasonResult.error;
			}
		}

		return successResult ?? { success: false, error: lastError ?? 'Failed to create .strm files' };
	}

	private async handleSeasonPack(
		request: GrabRequest,
		resolved: ResolvedContext,
		parsedStream: NonNullable<ReturnType<typeof StrmService.parseStreamUrl>>,
		baseUrl: string,
		seasonNumberOverride?: number
	): Promise<HandlerResult> {
		const { release, options } = request;
		const { seriesId } = resolved;
		const seasonNumber = seasonNumberOverride ?? parsedStream.season!;
		const isUpgrade = options.isUpgrade;

		if (!seriesId) {
			return { success: false, error: 'seriesId is required for season pack' };
		}

		const show = await db.query.series.findFirst({
			where: eq(series.id, seriesId),
			with: { rootFolder: true }
		});

		if (!show || !show.rootFolder) {
			return { success: false, error: 'Series or root folder not found' };
		}
		const allowStrmProbe = show.scoringProfileId !== 'streamer';

		const seasonEpisodes = await db.query.episodes.findMany({
			where: and(eq(episodes.seriesId, seriesId), eq(episodes.seasonNumber, seasonNumber))
		});
		const episodesNeedingFiles = isUpgrade
			? seasonEpisodes
			: seasonEpisodes.filter((ep) => !ep.hasFile);

		if (episodesNeedingFiles.length === 0) {
			return {
				success: true,
				queueId: 'streaming',
				clientId: 'streaming',
				clientName: 'Streaming',
				category: 'tv'
			};
		}

		const strmResult = await strmService.createSeasonStrmFiles({
			seriesId,
			seasonNumber,
			tmdbId: parsedStream.tmdbId,
			baseUrl,
			episodeIds: episodesNeedingFiles.map((ep) => ep.id)
		});

		if (!strmResult.success || strmResult.results.length === 0) {
			return { success: false, error: strmResult.error || 'Failed to create .strm files' };
		}

		const parsedRelease = parser.parse(release.title);
		const quality = {
			resolution: parsedRelease.resolution ?? '1080p',
			source: 'Streaming',
			codec: 'HLS',
			hdr: undefined
		};

		const episodeFileData: Array<{
			episodeId: string;
			episodeNumber: number;
			filePath: string;
			fileSize: number;
			relativePath: string;
			mediaInfo: Awaited<ReturnType<typeof mediaInfoService.extractMediaInfo>>;
		}> = [];

		for (const epResult of strmResult.results) {
			if (!epResult.filePath) continue;

			try {
				const stats = statSync(epResult.filePath);
				const mediaInfo = await mediaInfoService.extractMediaInfo(epResult.filePath, {
					allowStrmProbe
				});
				const relativePath = getLibraryRelativePath(
					show.rootFolder!.path,
					show.path,
					epResult.filePath
				);

				episodeFileData.push({
					episodeId: epResult.episodeId,
					episodeNumber: epResult.episodeNumber,
					filePath: epResult.filePath,
					fileSize: Number(stats.size),
					relativePath,
					mediaInfo
				});
			} catch (error) {
				logger.error(
					{
						episodeId: epResult.episodeId,
						err: error
					},
					'Failed to get file info for episode'
				);
			}
		}

		if (episodeFileData.length === 0) {
			return { success: false, error: 'Failed to get file info for any episodes' };
		}

		const createdEpisodeIds: string[] = [];
		const createdFileIds: string[] = [];
		let totalSize = 0;

		try {
			for (const epData of episodeFileData) {
				const existingFile = await db.query.episodeFiles.findFirst({
					where: eq(episodeFiles.relativePath, epData.relativePath)
				});

				if (existingFile && !isUpgrade) {
					createdFileIds.push(existingFile.id);
					createdEpisodeIds.push(epData.episodeId);
					totalSize += epData.fileSize;
					continue;
				}

				const fileId = await upsertEpisodeFileByPath({
					seriesId,
					seasonNumber,
					episodeIds: [epData.episodeId],
					relativePath: epData.relativePath,
					size: epData.fileSize,
					dateAdded: new Date().toISOString(),
					sceneName: release.title,
					releaseGroup: parsedRelease.releaseGroup ?? 'Streaming',
					quality,
					mediaInfo: epData.mediaInfo
				});

				await db.update(episodes).set({ hasFile: true }).where(eq(episodes.id, epData.episodeId));

				// Register-then-retire with the coverage rule; the just-upserted
				// row is excluded (same path → updated in place, never deleted).
				await this.retireEpisodeFiles(
					seriesId,
					[epData.episodeId],
					show.rootFolder!.path,
					show.path,
					{ keepFileIds: [fileId] }
				);

				createdEpisodeIds.push(epData.episodeId);
				createdFileIds.push(fileId);
				totalSize += epData.fileSize;
			}

			if (createdFileIds.length > 0) {
				await db.insert(downloadHistory).values({
					title: release.title,
					indexerId: release.indexerId,
					indexerName: release.indexerName,
					protocol: 'streaming',
					seriesId,
					episodeIds: createdEpisodeIds,
					seasonNumber,
					status: 'streaming',
					size: totalSize,
					quality,
					episodeFileIds: createdFileIds,
					grabbedAt: new Date().toISOString(),
					importedAt: new Date().toISOString()
				});
			}
		} catch (dbError) {
			return {
				success: false,
				error: dbError instanceof Error ? dbError.message : 'Database operation failed'
			};
		}

		if (createdFileIds.length === 0) {
			return { success: false, error: 'Failed to create any episode file records' };
		}

		libraryMediaEvents.emitSeriesUpdated(seriesId);
		void this.triggerSubtitleSearchForEpisodes(createdEpisodeIds);

		return {
			success: true,
			queueId: createdFileIds[0],
			clientId: 'streaming',
			clientName: 'Streaming',
			category: 'tv'
		};
	}

	private async triggerSubtitleSearch(
		mediaType: 'movie' | 'episode',
		mediaId: string
	): Promise<void> {
		try {
			const settings = await monitoringScheduler.getSettings();
			if (!settings.subtitleSearchOnImportEnabled) return;
			await searchSubtitlesForNewMedia(mediaType, mediaId);
		} catch (error) {
			logger.warn({ mediaType, mediaId, err: error }, 'Subtitle search on import failed');
		}
	}

	private async triggerSubtitleSearchForEpisodes(episodeIds: string[]): Promise<void> {
		if (episodeIds.length === 0) return;
		try {
			const settings = await monitoringScheduler.getSettings();
			if (!settings.subtitleSearchOnImportEnabled) return;
			await Promise.allSettled(episodeIds.map((id) => searchSubtitlesForNewMedia('episode', id)));
		} catch (error) {
			logger.warn({ total: episodeIds.length, err: error }, 'Subtitle search failed for episodes');
		}
	}

	/**
	 * Retire existing movie files per the shared state-based policy. Runs
	 * AFTER the new row is registered; `keepFileIds` excludes it. Physical
	 * deletion failure keeps the DB row (scan re-discovery guard).
	 */
	private async retireMovieFiles(
		movieId: string,
		rootFolderPath: string,
		moviePath: string,
		options: {
			multiQuality: boolean;
			newResolution?: Resolution;
			keepFileIds: string[];
		}
	): Promise<void> {
		const existingFiles = await db.query.movieFiles.findMany({
			where: eq(movieFiles.movieId, movieId)
		});

		const replaceIds = new Set(
			computeMovieReplacement({
				existingFiles,
				newResolution: options.newResolution,
				multiQuality: options.multiQuality,
				retire: true,
				keepFileIds: options.keepFileIds
			})
		);
		if (replaceIds.size === 0) return;

		const { recycleEnabled } = await getFileManagementSettings();

		for (const oldFile of existingFiles) {
			if (!replaceIds.has(oldFile.id)) continue;
			const oldFilePath = join(rootFolderPath, moviePath, oldFile.relativePath);
			try {
				await deletePhysicalFile(oldFilePath, recycleEnabled, rootFolderPath);
			} catch (error) {
				logger.warn(
					{ fileId: oldFile.id, path: oldFilePath, err: error },
					'Failed to delete old streaming movie file - keeping DB row'
				);
				continue;
			}
			await db.delete(movieFiles).where(eq(movieFiles.id, oldFile.id));
		}
	}

	/**
	 * Retire episode files overlapping `episodeId` per the coverage rule:
	 * multi-episode files survive unless the incoming set preserves every
	 * episode they hold; .strm placeholders always yield to real files.
	 */
	private async retireEpisodeFiles(
		seriesId: string,
		incomingEpisodeIds: string[],
		rootFolderPath: string,
		seriesPath: string,
		options?: { keepFileIds?: string[] }
	): Promise<void> {
		const allSeriesFiles = await db.query.episodeFiles.findMany({
			where: eq(episodeFiles.seriesId, seriesId)
		});

		const replaceIds = new Set(
			computeEpisodeReplacement({
				existingFiles: allSeriesFiles,
				incomingEpisodeIds,
				keepFileIds: options?.keepFileIds,
				retireStrmPlaceholders: true
			})
		);
		if (replaceIds.size === 0) return;

		for (const oldFile of allSeriesFiles) {
			if (!replaceIds.has(oldFile.id)) continue;
			const oldFilePath = join(rootFolderPath, seriesPath, oldFile.relativePath);
			try {
				if (await fileExists(oldFilePath)) {
					await unlink(oldFilePath);
				}
			} catch (error) {
				logger.warn(
					{ fileId: oldFile.id, path: oldFilePath, err: error },
					'Failed to delete old streaming episode file - keeping DB row'
				);
				continue;
			}
			await db.delete(episodeFiles).where(eq(episodeFiles.id, oldFile.id));
		}
	}
}
