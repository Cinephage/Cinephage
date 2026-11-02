/**
 * PendingReleaseTask
 *
 * Processes releases that have been waiting for their delay period to expire.
 * Part of the delay profiles feature that allows waiting for better releases.
 *
 * Runs periodically to:
 * 1. Check for pending releases past their processAt time
 * 2. Verify the release is still the best option
 * 3. Grab the release if appropriate
 * 4. Clean up expired/superseded entries
 */

import { db } from '#lib/server/db/index.js';
import { pendingReleases, movies, series, episodes } from '#lib/server/db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { delayProfileService } from '../specifications/DelaySpecification.js';
import { blocklistService } from '../specifications/BlocklistSpecification.js';
import { grabService } from '#lib/server/downloads/GrabService.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';

const logger = createChildLogger({ module: 'PendingReleaseTask', logDomain: 'monitoring' });

/**
 * Statistics for pending release processing
 */
interface ProcessingStats {
	processed: number;
	grabbed: number;
	expired: number;
	superseded: number;
	failed: number;
}

/**
 * Execute the pending release processing task
 * @param ctx - Execution context for cancellation support and activity tracking
 */
export async function executePendingReleaseTask(
	ctx: TaskExecutionContext | null
): Promise<TaskResult> {
	const startTime = Date.now();
	const taskHistoryId = ctx?.historyId;
	logger.info({ taskHistoryId }, '[PendingReleaseTask] Starting pending release processing');

	const stats: ProcessingStats = {
		processed: 0,
		grabbed: 0,
		expired: 0,
		superseded: 0,
		failed: 0
	};

	try {
		// Check for cancellation before starting
		ctx?.checkCancelled();

		// Get releases ready to process
		const readyReleases = await delayProfileService.getReadyReleases();
		logger.info({ count: readyReleases.length }, '[PendingReleaseTask] Found ready releases');

		// Process releases with cancellation support
		const releases = ctx ? ctx.iterate(readyReleases) : readyReleases;
		for await (const release of releases) {
			stats.processed++;

			try {
				const result = await processRelease(release);
				if (result.grabbed) {
					stats.grabbed++;
				} else if (result.expired) {
					stats.expired++;
				} else if (result.superseded) {
					stats.superseded++;
				}
			} catch (error) {
				stats.failed++;
				logger.error(
					{
						id: release.id,
						title: release.title,
						error
					},
					'[PendingReleaseTask] Failed to process release'
				);
			}
		}

		// Cleanup old releases (older than 72 hours)
		await delayProfileService.cleanupOldReleases(72);

		const duration = Date.now() - startTime;
		logger.info({ stats, durationMs: duration }, '[PendingReleaseTask] Completed');

		return {
			taskType: 'pendingRelease',
			itemsProcessed: stats.processed,
			itemsGrabbed: stats.grabbed,
			errors: stats.failed,
			executedAt: new Date(startTime)
		};
	} catch (error) {
		const duration = Date.now() - startTime;
		logger.error({ err: error, durationMs: duration }, '[PendingReleaseTask] Task failed');

		return {
			taskType: 'pendingRelease',
			itemsProcessed: stats.processed,
			itemsGrabbed: stats.grabbed,
			errors: stats.failed + 1,
			executedAt: new Date(startTime)
		};
	}
}

/**
 * Process a single pending release
 */
async function processRelease(
	release: typeof pendingReleases.$inferSelect
): Promise<{ grabbed: boolean; expired: boolean; superseded: boolean }> {
	const result = { grabbed: false, expired: false, superseded: false };

	// Check if content still exists and needs the file
	if (release.movieId) {
		const movie = await db.query.movies.findFirst({
			where: eq(movies.id, release.movieId)
		});

		if (!movie) {
			logger.debug(
				{
					releaseId: release.id
				},
				'[PendingReleaseTask] Movie no longer exists, expiring release'
			);
			await delayProfileService.markAsExpired(release.id);
			result.expired = true;
			return result;
		}

		// Check if movie already has a file
		if (movie.hasFile) {
			logger.debug(
				{
					releaseId: release.id,
					movieId: movie.id
				},
				'[PendingReleaseTask] Movie already has file, expiring release'
			);
			await delayProfileService.markAsExpired(release.id);
			result.expired = true;
			return result;
		}

		// Check if not monitored anymore
		if (!movie.monitored) {
			logger.debug(
				{
					releaseId: release.id
				},
				'[PendingReleaseTask] Movie no longer monitored, expiring release'
			);
			await delayProfileService.markAsExpired(release.id);
			result.expired = true;
			return result;
		}
	}

	if (release.seriesId) {
		const seriesData = await db.query.series.findFirst({
			where: eq(series.id, release.seriesId)
		});

		if (!seriesData) {
			logger.debug(
				{
					releaseId: release.id
				},
				'[PendingReleaseTask] Series no longer exists, expiring release'
			);
			await delayProfileService.markAsExpired(release.id);
			result.expired = true;
			return result;
		}

		// Check episode status if episode IDs provided
		if (release.episodeIds && release.episodeIds.length > 0) {
			const episodeData = await db.query.episodes.findMany({
				where: inArray(episodes.id, release.episodeIds)
			});

			// Check if all episodes already have files
			const allHaveFiles = episodeData.every((e) => e.hasFile);
			if (allHaveFiles) {
				logger.debug(
					{
						releaseId: release.id
					},
					'[PendingReleaseTask] All episodes already have files, expiring release'
				);
				await delayProfileService.markAsExpired(release.id);
				result.expired = true;
				return result;
			}
		}
	}

	// Check blocklist
	const blocklistResult = await blocklistService.isBlocklisted(
		{
			title: release.title,
			score: release.score,
			infoHash: release.infoHash ?? undefined
		},
		{
			movieId: release.movieId ?? undefined,
			seriesId: release.seriesId ?? undefined
		}
	);

	if (blocklistResult.blocked) {
		logger.debug(
			{
				releaseId: release.id,
				reason: blocklistResult.reason
			},
			'[PendingReleaseTask] Release is now blocklisted, expiring'
		);
		await delayProfileService.markAsExpired(release.id);
		result.expired = true;
		return result;
	}

	// Try to grab the release
	const grabResult = await grabPendingRelease(release);

	if (grabResult.success) {
		await delayProfileService.markAsGrabbed(release.id);
		result.grabbed = true;
		logger.info(
			{
				releaseId: release.id,
				title: release.title
			},
			'[PendingReleaseTask] Successfully grabbed pending release'
		);
	} else {
		// If grab failed, add to blocklist and expire
		await blocklistService.addToBlocklist(
			{
				title: release.title,
				infoHash: release.infoHash ?? undefined,
				indexerId: release.indexerId ?? undefined,
				quality: release.quality ?? undefined,
				size: release.size ?? undefined,
				protocol: release.protocol
			},
			{
				movieId: release.movieId ?? undefined,
				seriesId: release.seriesId ?? undefined,
				episodeIds: release.episodeIds ?? undefined,
				reason: 'download_failed',
				message: grabResult.error,
				expiresInHours: 24 // Short expiry for transient errors
			}
		);

		await delayProfileService.markAsExpired(release.id);
		result.expired = true;
		logger.warn(
			{
				releaseId: release.id,
				error: grabResult.error
			},
			'[PendingReleaseTask] Failed to grab pending release, blocklisted'
		);
	}

	return result;
}

/**
 * Attempt to grab a pending release via the full GrabService pipeline (with delay skipped).
 */
async function grabPendingRelease(
	release: typeof pendingReleases.$inferSelect
): Promise<{ success: boolean; error?: string }> {
	try {
		if (!release.downloadUrl && !release.magnetUrl) {
			return { success: false, error: 'No download URL or magnet for release' };
		}

		// Build the grab target from stored IDs
		let target: import('#lib/server/downloads/grab-types.js').GrabTarget;
		if (release.movieId) {
			target = { type: 'movie', movieId: release.movieId };
		} else if (release.seriesId && release.episodeIds && release.episodeIds.length > 0) {
			// Preserve the FULL delayed scope: collapsing a season/multi-episode
			// pack to its first episode weakens identity checks and lets sibling
			// episodes be grabbed concurrently for what is one acquisition.
			target =
				release.episodeIds.length === 1
					? { type: 'episode', episodeId: release.episodeIds[0], seriesId: release.seriesId }
					: { type: 'series', seriesId: release.seriesId, episodeIds: release.episodeIds };
		} else if (release.seriesId) {
			target = { type: 'series', seriesId: release.seriesId, episodeIds: [] };
		} else {
			return { success: false, error: 'No media target for pending release' };
		}

		const result = await grabService.grab({
			release: {
				title: release.title,
				infoHash: release.infoHash ?? undefined,
				downloadUrl: release.downloadUrl ?? undefined,
				magnetUrl: release.magnetUrl ?? undefined,
				indexerId: release.indexerId ?? undefined,
				size: release.size ?? undefined,
				protocol: (release.protocol as 'torrent' | 'usenet' | 'streaming') ?? 'torrent',
				publishDate: release.publishDate ? new Date(release.publishDate) : undefined
			},
			target,
			options: {
				force: false,
				skipBlocklist: false,
				allowSidegrade: false,
				isAutomatic: true,
				skipDelay: true
			}
		});

		if (result.success) {
			logger.info(
				{ title: release.title },
				'[PendingReleaseTask] Successfully grabbed pending release'
			);
			return { success: true };
		}

		return { success: false, error: result.decision?.reason ?? result.error ?? 'Grab rejected' };
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return { success: false, error: message };
	}
}
