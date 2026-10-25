import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { db } from '#lib/server/db/index.js';
import {
	downloadClients,
	downloadHistory,
	downloadQueue,
	episodeFiles,
	episodes,
	movieFiles,
	movies,
	rootFolders,
	series
} from '#lib/server/db/schema.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { eventBuffer } from '#lib/server/sse/EventBuffer.js';
import { downloadMonitor } from '../monitoring/DownloadMonitorService';
import { ImportService } from '../import/ImportService';
import { computeMovieReplacement, computeEpisodeReplacement } from '../import/replacement.js';
import { resolveMovieMultiQuality } from '#lib/server/quality/movie-buckets.js';
import type { Resolution } from '#lib/server/indexers/parser/types.js';

const logger = createChildLogger({ logDomain: 'imports' as const });
type Quality = { resolution?: string; source?: string; codec?: string; hdr?: string };
type MediaInfo = { width?: number; height?: number; videoCodec?: string };

interface FinalizerFile {
	plan: { fileName: string; relativePath: string; finalPath: string };
	receipt: {
		finalPath: string;
		sizeBytes: number;
		createdByAttempt: boolean;
		replacedExisting: boolean;
		signedUrl?: string;
	};
	metadata: {
		sourcePath: string;
		sceneName: string;
		releaseGroup: string;
		edition?: string;
		seasonNumber?: number;
		episodeIds?: string[];
		releaseType?: string;
		quality: Quality;
		mediaInfo: MediaInfo;
	};
}

export interface DebridImportFinalizerInput {
	queueItemId: string;
	mediaType: 'movie' | 'series';
	movieId?: string;
	seriesId?: string;
	files: FinalizerFile[];
	recycleEnabled?: boolean;
}

interface RegisteredFile {
	relativePath: string;
	finalPath: string;
	movieFileId?: string;
	episodeFileId?: string;
	seasonNumber?: number;
	episodeIds?: string[];
	sceneName?: string;
	releaseGroup?: string;
	quality?: Quality;
	mediaInfo?: MediaInfo;
	edition?: string;
	releaseType?: string;
	sizeBytes: number;
	dateAdded: string;
	wasUpgrade: boolean;
	retiredFileIds: string[];
}

interface PreparedFile {
	input: FinalizerFile;
	id: string;
	episodeIds: string[];
	seasonNumber?: number;
	retireIds: string[];
}

export class DebridImportFinalizer {
	async finalize(
		input: DebridImportFinalizerInput
	): Promise<{ success: boolean; idempotent?: boolean }> {
		if (!input.files.length) throw new Error('Library registration requires at least one file');
		const [queue] = await db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, input.queueItemId))
			.limit(1);
		if (!queue) throw new Error(`Queue item not found: ${input.queueItemId}`);
		if (queue.status === 'imported') return { success: true, idempotent: true };
		if (
			(input.mediaType === 'movie' && (!input.movieId || queue.movieId !== input.movieId)) ||
			(input.mediaType === 'series' && (!input.seriesId || queue.seriesId !== input.seriesId))
		) {
			throw new Error('Queue media does not match library registration input');
		}

		const media = await this.mediaPath(input);
		const mediaRoot = resolve(media.rootPath, media.relativePath);
		for (const file of input.files) await this.validateFile(file, mediaRoot);
		const sorted = [...input.files].sort((a, b) =>
			a.plan.relativePath.localeCompare(b.plan.relativePath)
		);
		const existing =
			input.mediaType === 'movie'
				? await db.select().from(movieFiles).where(eq(movieFiles.movieId, input.movieId!))
				: await db.select().from(episodeFiles).where(eq(episodeFiles.seriesId, input.seriesId!));

		// Replacement policy is computed from CURRENT rows (acquisition
		// redesign) — the grab-time isUpgrade flag never retires files.
		let movieMultiQuality = false;
		let movieResolution: Resolution | undefined;
		if (input.mediaType === 'movie') {
			const movieRow = await db
				.select({ desiredQualities: movies.desiredQualities, profileId: movies.scoringProfileId })
				.from(movies)
				.where(eq(movies.id, input.movieId!))
				.limit(1);
			const { multiQuality } = await resolveMovieMultiQuality(
				movieRow[0]?.desiredQualities,
				movieRow[0]?.profileId
			);
			movieMultiQuality = multiQuality;
			movieResolution = sorted[0]?.metadata.quality?.resolution as Resolution | undefined;
		}

		const prepared = sorted.map((file): PreparedFile => {
			const current = existing.find((row) => row.relativePath === file.plan.relativePath);
			const episodeIds = file.metadata.episodeIds ?? queue.episodeIds ?? [];
			const seasonNumber = file.metadata.seasonNumber ?? queue.seasonNumber ?? undefined;
			if (input.mediaType === 'series' && (!episodeIds.length || seasonNumber === undefined)) {
				throw new Error('Episode registration requires episode and season identifiers');
			}
			let retireIds: string[];
			if (input.mediaType === 'movie') {
				retireIds = computeMovieReplacement({
					existingFiles: existing,
					newResolution: movieResolution,
					multiQuality: movieMultiQuality,
					retire: true,
					keepFileIds: [current?.id ?? '']
				});
			} else {
				retireIds = computeEpisodeReplacement({
					existingFiles: existing as unknown as Parameters<
						typeof computeEpisodeReplacement
					>[0]['existingFiles'],
					incomingEpisodeIds: episodeIds,
					retireStrmPlaceholders: true
				}).filter((id) => id !== current?.id);
			}
			return { input: file, id: current?.id ?? randomUUID(), episodeIds, seasonNumber, retireIds };
		});
		const importedAt = new Date().toISOString();
		const representativePath = prepared[0].input.plan.finalPath;
		const registered = db.transaction((tx) => {
			const results: RegisteredFile[] = [];
			for (const file of prepared) {
				const common = {
					relativePath: file.input.plan.relativePath,
					size: file.input.receipt.sizeBytes,
					dateAdded: importedAt,
					sceneName: file.input.metadata.sceneName,
					releaseGroup: file.input.metadata.releaseGroup,
					edition: file.input.metadata.edition,
					quality: file.input.metadata.quality,
					mediaInfo: file.input.metadata.mediaInfo,
					infoHash: queue.infoHash ?? undefined
				};
				if (input.mediaType === 'movie') {
					tx.insert(movieFiles)
						.values({ id: file.id, movieId: input.movieId!, ...common })
						.onConflictDoUpdate({ target: movieFiles.id, set: common })
						.run();
					tx.update(movies).set({ hasFile: true }).where(eq(movies.id, input.movieId!)).run();
				} else {
					const episodeData = {
						...common,
						seriesId: input.seriesId!,
						seasonNumber: file.seasonNumber!,
						episodeIds: file.episodeIds,
						releaseType:
							file.input.metadata.releaseType ??
							(file.episodeIds.length > 1 ? 'multiEpisode' : 'singleEpisode')
					};
					tx.insert(episodeFiles)
						.values({ id: file.id, ...episodeData })
						.onConflictDoUpdate({ target: episodeFiles.id, set: episodeData })
						.run();
					for (const id of file.episodeIds) {
						tx.update(episodes).set({ hasFile: true }).where(eq(episodes.id, id)).run();
					}
				}
				results.push({
					relativePath: file.input.plan.relativePath,
					finalPath: file.input.plan.finalPath,
					...(input.mediaType === 'movie'
						? { movieFileId: file.id }
						: {
								episodeFileId: file.id,
								episodeIds: file.episodeIds,
								seasonNumber: file.seasonNumber
							}),
					sizeBytes: file.input.receipt.sizeBytes,
					dateAdded: importedAt,
					wasUpgrade: Boolean(queue.isUpgrade),
					retiredFileIds: file.retireIds,
					...file.input.metadata
				});
			}

			const history = tx
				.select({ id: downloadHistory.id })
				.from(downloadHistory)
				.where(
					and(
						eq(downloadHistory.status, 'imported'),
						eq(downloadHistory.downloadId, queue.downloadId),
						eq(downloadHistory.importedPath, representativePath)
					)
				)
				.get();
			if (!history) {
				const [client] = queue.downloadClientId
					? tx
							.select({ name: downloadClients.name })
							.from(downloadClients)
							.where(eq(downloadClients.id, queue.downloadClientId))
							.limit(1)
							.all()
					: [];
				tx.insert(downloadHistory)
					.values({
						downloadClientId: queue.downloadClientId,
						downloadClientName: client?.name,
						downloadId: queue.downloadId,
						infoHash: queue.infoHash,
						title: queue.title,
						protocol: queue.protocol,
						movieId: queue.movieId,
						seriesId: queue.seriesId,
						episodeIds: queue.episodeIds ?? undefined,
						seasonNumber: queue.seasonNumber,
						status: 'imported',
						size: queue.size,
						quality: queue.quality ?? undefined,
						releaseGroup: queue.releaseGroup,
						importedPath: representativePath,
						movieFileId: results[0]?.movieFileId,
						episodeFileIds: results.flatMap((result) =>
							result.episodeFileId ? [result.episodeFileId] : []
						),
						grabbedAt: queue.addedAt,
						completedAt: queue.completedAt,
						importedAt
					})
					.run();
			}
			tx.update(downloadQueue)
				.set({
					status: 'imported',
					importedPath: representativePath,
					importedAt,
					errorMessage: null
				})
				.where(eq(downloadQueue.id, queue.id))
				.run();
			return results;
		});

		await downloadMonitor
			.markImported(queue.id, representativePath, 'debrid')
			.catch((error) =>
				logger.warn({ queueItemId: queue.id, error }, 'Imported notification failed')
			);
		const imports = ImportService.getInstance();
		for (const file of registered) {
			for (const retiredId of file.retiredFileIds) {
				if (input.mediaType === 'movie')
					await imports.deleteMovieFile(retiredId, input.movieId!, input.recycleEnabled);
				else await imports.deleteEpisodeFile(retiredId, input.seriesId!, input.recycleEnabled);
			}
			const importedFile = {
				relativePath: file.relativePath,
				size: file.sizeBytes,
				dateAdded: file.dateAdded,
				sceneName: file.sceneName,
				releaseGroup: file.releaseGroup,
				edition: file.edition,
				releaseType: file.releaseType,
				quality: file.quality ?? null,
				mediaInfo: file.mediaInfo ?? null
			};
			const event =
				input.mediaType === 'movie'
					? {
							mediaType: 'movie' as const,
							movieId: input.movieId!,
							file: { id: file.movieFileId!, ...importedFile },
							importedPath: file.finalPath,
							wasUpgrade: file.wasUpgrade,
							replacedFileIds: file.retiredFileIds,
							timestamp: Date.now()
						}
					: {
							mediaType: 'episode' as const,
							seriesId: input.seriesId!,
							episodeIds: file.episodeIds!,
							seasonNumber: file.seasonNumber!,
							file: { id: file.episodeFileId!, ...importedFile },
							importedPath: file.finalPath,
							wasUpgrade: file.wasUpgrade,
							replacedFileIds: file.retiredFileIds,
							timestamp: Date.now()
						};
			imports.emit('file:imported', event);
			eventBuffer.add(event);
		}
		if (input.mediaType === 'movie') {
			libraryMediaEvents.emitMovieUpdated(input.movieId!);
			void imports.triggerSubtitleSearch('movie', input.movieId!);
		} else {
			libraryMediaEvents.emitSeriesUpdated(input.seriesId!);
			await imports.updateSeriesStats(input.seriesId!);
			void imports.triggerSubtitleSearchForEpisodeFiles(
				registered.flatMap((file) => (file.episodeFileId ? [file.episodeFileId] : []))
			);
		}
		return { success: true };
	}

	private async mediaPath(
		input: DebridImportFinalizerInput
	): Promise<{ rootPath: string; relativePath: string }> {
		const [media] =
			input.mediaType === 'movie'
				? await db.select().from(movies).where(eq(movies.id, input.movieId!)).limit(1)
				: await db.select().from(series).where(eq(series.id, input.seriesId!)).limit(1);
		if (!media?.rootFolderId) throw new Error('Library media path is unavailable');
		const [root] = await db
			.select()
			.from(rootFolders)
			.where(eq(rootFolders.id, media.rootFolderId))
			.limit(1);
		if (!root) throw new Error('Library root is unavailable');
		return { rootPath: root.path, relativePath: media.path };
	}

	private async validateFile(file: FinalizerFile, mediaRoot: string): Promise<void> {
		if (
			file.receipt.signedUrl ||
			file.receipt.finalPath !== file.plan.finalPath ||
			basename(file.plan.finalPath) !== file.plan.fileName
		) {
			throw new Error('Materialization receipt does not match destination plan');
		}
		const expected = resolve(mediaRoot, file.plan.relativePath);
		const child = relative(mediaRoot, expected);
		if (
			expected !== resolve(file.plan.finalPath) ||
			child === '..' ||
			child.startsWith(`..${sep}`) ||
			isAbsolute(child)
		) {
			throw new Error('Library destination escapes the media path');
		}
		const stats = await stat(file.plan.finalPath);
		if (!stats.isFile() || stats.size !== file.receipt.sizeBytes) {
			throw new Error('Materialized file does not match its receipt');
		}
	}
}
