/**
 * Subtitle Sync Service
 *
 * Uses the native TypeScript subtitle sync engine (inspired by alass) for
 * automatic subtitle timing correction. Syncs subtitles against video audio
 * track or reference subtitle file.
 *
 * This replaces the previous implementation that shelled out to the alass-cli binary.
 */

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { db } from '#lib/server/db/index.js';
import {
	subtitles,
	subtitleHistory,
	movies,
	series,
	episodes,
	movieFiles,
	episodeFiles,
	rootFolders
} from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { getMediaBrowserNotifier } from '#lib/server/notifications/mediabrowser/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });
import type { SubtitleSyncResult } from '../types';
import { syncSubtitles } from '../sync/index.js';
import {
	openPathWithinBase,
	resolveCanonicalRegularPathWithinBase,
	resolveDestructivePathWithinBase,
	resolvePathWithinBase,
	resolveStoredSubtitlePath
} from '../subtitle-paths.js';

/** Sync options for subtitle synchronization */
export interface SyncOptions {
	/** Reference type: 'video' (audio track) or 'subtitle' (another subtitle file) */
	referenceType?: 'video' | 'subtitle';
	/** Path to reference subtitle (if referenceType is 'subtitle') */
	referencePath?: string;
	/**
	 * Split penalty controls how aggressively the engine introduces or removes breaks.
	 * Value between 0 and 1000 (default 7). Values 5-20 are most useful.
	 * Higher values avoid introducing splits; lower values allow more splits.
	 */
	splitPenalty?: number;
	/**
	 * When true, only apply a constant offset without introducing splits.
	 * This is very fast and useful for simple timing corrections.
	 */
	noSplits?: boolean;
}

/**
 * Service for syncing subtitle timing using the native sync engine
 */
export class SubtitleSyncService {
	private static instance: SubtitleSyncService | null = null;
	private static readonly DEFAULT_SPLIT_PENALTY = 7;

	private constructor() {}

	static getInstance(): SubtitleSyncService {
		if (!SubtitleSyncService.instance) {
			SubtitleSyncService.instance = new SubtitleSyncService();
		}
		return SubtitleSyncService.instance;
	}

	/**
	 * Check if the sync engine is available.
	 * The native engine is always available — no external binary needed.
	 */
	async isAvailable(): Promise<boolean> {
		return true;
	}

	/**
	 * Sync a subtitle by ID
	 */
	async syncSubtitle(subtitleId: string, options?: SyncOptions): Promise<SubtitleSyncResult> {
		// Get subtitle record
		const subtitle = await db.select().from(subtitles).where(eq(subtitles.id, subtitleId)).limit(1);
		if (!subtitle[0]) {
			return {
				success: false,
				offsetMs: 0,
				error: `Subtitle not found: ${subtitleId}`
			};
		}

		if (await this.isStreamerProfileSubtitle(subtitle[0])) {
			return {
				success: false,
				offsetMs: 0,
				error: 'Subtitle sync is not available for Streamer profile media.'
			};
		}

		// Get paths
		const { subtitlePath, videoPath, subtitleBasePath, videoBasePath } =
			await this.getSubtitlePaths(subtitle[0]);
		if (!subtitlePath || !existsSync(subtitlePath)) {
			return {
				success: false,
				offsetMs: 0,
				error: 'Subtitle file not found'
			};
		}

		if (!videoPath || !existsSync(videoPath)) {
			return {
				success: false,
				offsetMs: 0,
				error: 'Video file not found for syncing'
			};
		}

		// Perform sync
		const result = await this.performSync(subtitlePath, videoPath, options, {
			subtitleBasePath,
			videoBasePath
		});

		// Update database if successful
		if (result.success) {
			await db
				.update(subtitles)
				.set({
					syncOffset: result.offsetMs,
					wasSynced: true
				})
				.where(eq(subtitles.id, subtitleId));

			// Log to history
			await db.insert(subtitleHistory).values({
				movieId: subtitle[0].movieId,
				episodeId: subtitle[0].episodeId,
				action: 'synced',
				language: subtitle[0].language,
				providerId: subtitle[0].providerId,
				matchScore: subtitle[0].matchScore
			});

			logger.info(
				{
					subtitleId,
					offsetMs: result.offsetMs
				},
				'Subtitle synced successfully'
			);

			await this.emitMediaUpdatedForSubtitle(subtitle[0]);
			// The sidecar content changed on disk; tell media servers to re-read it.
			getMediaBrowserNotifier().queueUpdate(subtitlePath, 'Modified', 'upgrade');
		}

		return result;
	}

	/**
	 * Sync a subtitle file directly (without database record)
	 */
	async syncFile(
		subtitlePath: string,
		videoPath: string,
		options?: SyncOptions
	): Promise<SubtitleSyncResult> {
		return this.performSync(subtitlePath, videoPath, options);
	}

	/**
	 * Apply a manual offset to a subtitle file
	 */
	async applyManualOffset(subtitleId: string, offsetMs: number): Promise<SubtitleSyncResult> {
		// Get subtitle record
		const subtitle = await db.select().from(subtitles).where(eq(subtitles.id, subtitleId)).limit(1);
		if (!subtitle[0]) {
			return {
				success: false,
				offsetMs: 0,
				error: `Subtitle not found: ${subtitleId}`
			};
		}

		// Get path
		const { subtitlePath, subtitleBasePath } = await this.getSubtitlePaths(subtitle[0]);
		if (!subtitlePath || !existsSync(subtitlePath)) {
			return {
				success: false,
				offsetMs: 0,
				error: 'Subtitle file not found'
			};
		}

		let subtitleHandle;
		try {
			subtitleHandle = await openPathWithinBase(subtitleBasePath!, subtitlePath, 'r+');
			// Read and shift subtitle through the opened handle, not the pathname.
			const content = await subtitleHandle.readFile('utf-8');
			const shifted = this.shiftSrtTiming(content, offsetMs);
			await subtitleHandle.truncate(0);
			const shiftedBuffer = Buffer.from(shifted, 'utf-8');
			await subtitleHandle.write(shiftedBuffer, 0, shiftedBuffer.length, 0);

			// Update database
			await db
				.update(subtitles)
				.set({
					syncOffset: offsetMs,
					wasSynced: true
				})
				.where(eq(subtitles.id, subtitleId));

			// Log to history
			await db.insert(subtitleHistory).values({
				movieId: subtitle[0].movieId,
				episodeId: subtitle[0].episodeId,
				action: 'synced',
				language: subtitle[0].language,
				providerId: subtitle[0].providerId,
				matchScore: subtitle[0].matchScore
			});

			await this.emitMediaUpdatedForSubtitle(subtitle[0]);
			getMediaBrowserNotifier().queueUpdate(subtitlePath, 'Modified', 'upgrade');

			return {
				success: true,
				offsetMs
			};
		} catch (error) {
			return {
				success: false,
				offsetMs: 0,
				error: error instanceof Error ? error.message : String(error)
			};
		} finally {
			await subtitleHandle?.close().catch(() => undefined);
		}
	}

	/**
	 * Perform the actual sync using the native subtitle sync engine.
	 *
	 * Uses the TypeScript port of the alass alignment algorithm:
	 * - Parses both subtitle files to extract time spans
	 * - For video references, extracts audio via ffmpeg and runs VAD
	 * - Runs the alignment algorithm (nosplit or split-aware)
	 * - Applies computed deltas to the subtitle file
	 */
	private async performSync(
		subtitlePath: string,
		videoPath: string,
		options?: SyncOptions,
		paths?: { subtitleBasePath?: string | null; videoBasePath?: string | null }
	): Promise<SubtitleSyncResult> {
		const splitPenalty = options?.splitPenalty ?? SubtitleSyncService.DEFAULT_SPLIT_PENALTY;
		const noSplits = options?.noSplits ?? false;

		try {
			if (!paths?.subtitleBasePath || !paths.videoBasePath) {
				throw new Error('Subtitle sync requires validated media paths');
			}

			const safeSubtitlePath = await resolveDestructivePathWithinBase(
				paths.subtitleBasePath,
				subtitlePath
			);
			if (!safeSubtitlePath) throw new Error('Refusing to sync a symlinked subtitle file');

			const safeVideoPath = await resolveCanonicalRegularPathWithinBase(
				paths.videoBasePath,
				videoPath
			);
			if (!safeVideoPath) throw new Error('Video reference path is outside the allowed base');

			const referenceType = options?.referenceType ?? 'video';
			const referencePath =
				referenceType === 'subtitle'
					? await resolveCanonicalRegularPathWithinBase(
							paths.subtitleBasePath,
							options?.referencePath ?? ''
						)
					: safeVideoPath;
			if (!referencePath) throw new Error('Subtitle reference path is outside the allowed base');

			const outputPath = `${safeSubtitlePath}.${randomUUID()}.sync.tmp`;

			logger.debug(
				{
					subtitlePath,
					referencePath,
					referenceType,
					splitPenalty,
					noSplits
				},
				'Running native subtitle sync'
			);

			const result = await syncSubtitles({
				referenceType,
				referencePath,
				subtitlePath: safeSubtitlePath,
				outputPath,
				splitPenalty,
				noSplits
			});

			if (!result.success) {
				await unlink(outputPath).catch(() => undefined);
				logger.error({ error: result.error }, 'Native subtitle sync failed');
				return {
					success: false,
					offsetMs: 0,
					error: this.toUserFriendlySyncError(result.error ?? 'Sync failed')
				};
			}

			const safeFinalPath = await resolveDestructivePathWithinBase(
				paths.subtitleBasePath,
				safeSubtitlePath
			);
			if (!safeFinalPath) {
				await unlink(outputPath).catch(() => undefined);
				throw new Error('Refusing to replace a retargeted subtitle symlink');
			}
			await rename(outputPath, safeFinalPath);

			logger.info(
				{
					offsetMs: result.offsetMs,
					splitCount: result.splitCount,
					score: result.score,
					alignmentTimeMs: result.alignmentTimeMs
				},
				'Native subtitle sync completed'
			);

			return {
				success: true,
				offsetMs: result.offsetMs
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error({ err: error }, 'Subtitle sync failed');

			return {
				success: false,
				offsetMs: 0,
				error: this.toUserFriendlySyncError(errorMsg)
			};
		}
	}

	private toUserFriendlySyncError(error: string): string {
		const normalized = error.toLowerCase();
		if (normalized.includes('subtitle sync is not available for streamer profile media')) {
			return 'Subtitle sync is not available for Streamer profile media.';
		}
		if (normalized.includes('strm file has no url')) {
			return 'Subtitle sync failed: the .strm file has no stream URL.';
		}
		if (normalized.includes('strm file contains an invalid url')) {
			return 'Subtitle sync failed: the .strm file contains an invalid URL.';
		}
		if (normalized.includes("strm url protocol '")) {
			return 'Subtitle sync failed: the .strm URL protocol is not supported.';
		}
		if (normalized.includes('could not read a valid media stream from the source')) {
			return 'Subtitle sync failed: could not read a valid media stream from the source.';
		}
		if (normalized.includes('audio extraction timed out')) {
			return 'Subtitle sync failed: audio extraction timed out.';
		}
		if (normalized.includes('command failed:')) {
			return 'Subtitle sync failed while extracting reference audio.';
		}

		return error.length > 220 ? `${error.slice(0, 217)}...` : error;
	}

	/**
	 * Shift SRT timing by offset (for manual sync)
	 */
	private shiftSrtTiming(content: string, offsetMs: number): string {
		// SRT timestamp format: 00:00:00,000 --> 00:00:00,000
		const timestampRegex = /(\d{2}):(\d{2}):(\d{2}),(\d{3})/g;

		return content.replace(timestampRegex, (match, hours, minutes, seconds, ms) => {
			const totalMs =
				parseInt(hours) * 3600000 +
				parseInt(minutes) * 60000 +
				parseInt(seconds) * 1000 +
				parseInt(ms);

			const newTotalMs = Math.max(0, totalMs + offsetMs);

			const newHours = Math.floor(newTotalMs / 3600000);
			const newMinutes = Math.floor((newTotalMs % 3600000) / 60000);
			const newSeconds = Math.floor((newTotalMs % 60000) / 1000);
			const newMs = newTotalMs % 1000;

			return `${newHours.toString().padStart(2, '0')}:${newMinutes.toString().padStart(2, '0')}:${newSeconds.toString().padStart(2, '0')},${newMs.toString().padStart(3, '0')}`;
		});
	}

	/**
	 * Get full paths for a subtitle record
	 */
	private async getSubtitlePaths(subtitle: typeof subtitles.$inferSelect): Promise<{
		subtitlePath: string | null;
		videoPath: string | null;
		subtitleBasePath: string | null;
		videoBasePath: string | null;
	}> {
		if (subtitle.movieId) {
			const movie = await db.select().from(movies).where(eq(movies.id, subtitle.movieId)).limit(1);
			if (!movie[0]) {
				return { subtitlePath: null, videoPath: null, subtitleBasePath: null, videoBasePath: null };
			}

			const files = await db
				.select()
				.from(movieFiles)
				.where(eq(movieFiles.movieId, subtitle.movieId));
			// Use the specific file the subtitle is linked to when set (multi-quality
			// support), otherwise fall back to the first file (legacy behavior).
			const file = subtitle.movieFileId
				? files.find((f) => f.id === subtitle.movieFileId)
				: files[0];

			const rootFolder = movie[0].rootFolderId
				? await db
						.select()
						.from(rootFolders)
						.where(eq(rootFolders.id, movie[0].rootFolderId))
						.limit(1)
				: null;

			const rootPath = rootFolder?.[0]?.path || '';
			const mediaPath = join(rootPath, movie[0].path);

			return {
				subtitlePath: await resolveStoredSubtitlePath(subtitle),
				videoPath: file ? await resolvePathWithinBase(mediaPath, file.relativePath) : null,
				subtitleBasePath: mediaPath,
				videoBasePath: mediaPath
			};
		}

		if (subtitle.episodeId) {
			const episode = await db
				.select()
				.from(episodes)
				.where(eq(episodes.id, subtitle.episodeId))
				.limit(1);
			if (!episode[0]) {
				return { subtitlePath: null, videoPath: null, subtitleBasePath: null, videoBasePath: null };
			}

			const seriesData = await db
				.select()
				.from(series)
				.where(eq(series.id, episode[0].seriesId))
				.limit(1);
			if (!seriesData[0]) {
				return { subtitlePath: null, videoPath: null, subtitleBasePath: null, videoBasePath: null };
			}

			const files = await db
				.select()
				.from(episodeFiles)
				.where(eq(episodeFiles.seriesId, episode[0].seriesId));
			const file = files.find((f) => {
				const ids = f.episodeIds as string[] | null;
				return ids?.includes(subtitle.episodeId!);
			});

			const rootFolder = seriesData[0].rootFolderId
				? await db
						.select()
						.from(rootFolders)
						.where(eq(rootFolders.id, seriesData[0].rootFolderId))
						.limit(1)
				: null;

			const rootPath = rootFolder?.[0]?.path || '';
			const mediaPath = file
				? join(rootPath, seriesData[0].path, dirname(file.relativePath))
				: join(rootPath, seriesData[0].path);

			return {
				subtitlePath: await resolveStoredSubtitlePath(subtitle),
				videoPath: file
					? await resolvePathWithinBase(mediaPath, basename(file.relativePath))
					: null,
				subtitleBasePath: mediaPath,
				videoBasePath: mediaPath
			};
		}

		return { subtitlePath: null, videoPath: null, subtitleBasePath: null, videoBasePath: null };
	}

	private async isStreamerProfileSubtitle(
		subtitle: typeof subtitles.$inferSelect
	): Promise<boolean> {
		if (subtitle.movieId) {
			const movie = await db.select().from(movies).where(eq(movies.id, subtitle.movieId)).limit(1);
			return movie[0]?.scoringProfileId === 'streamer';
		}

		if (subtitle.episodeId) {
			const episode = await db
				.select()
				.from(episodes)
				.where(eq(episodes.id, subtitle.episodeId))
				.limit(1);
			if (!episode[0]) return false;

			const seriesData = await db
				.select()
				.from(series)
				.where(eq(series.id, episode[0].seriesId))
				.limit(1);
			return seriesData[0]?.scoringProfileId === 'streamer';
		}

		return false;
	}

	private async emitMediaUpdatedForSubtitle(
		subtitle: typeof subtitles.$inferSelect
	): Promise<void> {
		try {
			if (subtitle.movieId) {
				libraryMediaEvents.emitMovieUpdated(subtitle.movieId);
				return;
			}

			if (!subtitle.episodeId) {
				return;
			}

			const episode = await db
				.select({ seriesId: episodes.seriesId })
				.from(episodes)
				.where(eq(episodes.id, subtitle.episodeId))
				.limit(1)
				.then((rows) => rows[0]);

			if (episode?.seriesId) {
				libraryMediaEvents.emitSeriesUpdated(episode.seriesId);
			}
		} catch (error) {
			logger.warn(
				{
					subtitleId: subtitle.id,
					movieId: subtitle.movieId,
					episodeId: subtitle.episodeId,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to emit library media update after subtitle sync'
			);
		}
	}
}

/**
 * Get the singleton SubtitleSyncService
 */
export function getSubtitleSyncService(): SubtitleSyncService {
	return SubtitleSyncService.getInstance();
}
