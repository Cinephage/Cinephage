/**
 * Cutoff Unmet Task
 *
 * Searches for content with files that are below the profile's quality cutoff.
 * Runs periodically (default: daily) to upgrade content that hasn't reached target quality.
 *
 * Note: This differs from UpgradeMonitorTask which searches ALL items for potential upgrades.
 * CutoffUnmetTask ONLY searches items that are below their target quality cutoff.
 */

import { db } from '#lib/server/db/index.js';
import { monitoringHistory, episodes } from '#lib/server/db/schema.js';
import { inArray } from 'drizzle-orm';
import { monitoringSearchService } from '../search/MonitoringSearchService.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';

const logger = createChildLogger({ module: 'CutoffUnmetTask', logDomain: 'monitoring' });

/**
 * Execute cutoff unmet search task
 * @param ctx - Execution context for cancellation support and activity tracking
 */
export async function executeCutoffUnmetTask(
	ctx: TaskExecutionContext | null,
	options: {
		ignoreCooldown?: boolean;
		cooldownHours?: number;
	} = {}
): Promise<TaskResult> {
	const executedAt = new Date();
	const taskHistoryId = ctx?.historyId;
	const ignoreCooldown = options.ignoreCooldown ?? false;
	const cooldownHours = options.cooldownHours;
	logger.info({ taskHistoryId }, '[CutoffUnmetTask] Starting cutoff unmet search');

	let itemsProcessed: number;
	let itemsGrabbed: number;
	let errors: number;

	try {
		// Check for cancellation before starting
		ctx?.checkCancelled();

		// Search for items below quality cutoff only
		// cutoffUnmetOnly: true means we only search items that haven't reached target quality
		const cutoffResults = await monitoringSearchService.searchForUpgrades({
			cutoffUnmetOnly: true,
			ignoreCooldown,
			cooldownHours,
			signal: ctx?.abortSignal
		});

		itemsProcessed = cutoffResults.summary.searched;
		itemsGrabbed = cutoffResults.summary.grabbed;
		errors = cutoffResults.summary.errors;

		logger.info(
			{
				searched: cutoffResults.summary.searched,
				grabbed: cutoffResults.summary.grabbed,
				errors: cutoffResults.summary.errors
			},
			'[CutoffUnmetTask] Cutoff unmet search completed'
		);

		// Batch-fetch seriesId for episode items so history rows are correctly linked
		const episodeIds = cutoffResults.items
			.filter((i) => i.itemType === 'episode')
			.map((i) => i.itemId);
		const episodeSeriesMap =
			episodeIds.length > 0
				? new Map(
						(
							await db
								.select({ id: episodes.id, seriesId: episodes.seriesId })
								.from(episodes)
								.where(inArray(episodes.id, episodeIds))
								.all()
						).map((e) => [e.id, e.seriesId])
					)
				: new Map<string, string>();

		// Record history for each item (with cancellation checks)
		if (ctx) {
			for await (const item of ctx.iterate(cutoffResults.items)) {
				if (!item.searched && item.skipped) continue;

				await db.insert(monitoringHistory).values({
					taskHistoryId,
					taskType: 'cutoffUnmet',
					movieId: item.itemType === 'movie' ? item.itemId : undefined,
					episodeId: item.itemType === 'episode' ? item.itemId : undefined,
					seriesId:
						item.itemType === 'episode'
							? (episodeSeriesMap.get(item.itemId) ?? undefined)
							: undefined,
					status: item.grabbed
						? 'grabbed'
						: item.error
							? 'error'
							: item.releasesFound > 0
								? 'found'
								: 'no_results',
					releasesFound: item.releasesFound,
					releaseGrabbed: item.grabbedRelease,
					queueItemId: item.queueItemId,
					isUpgrade: true,
					errorMessage: item.error,
					executedAt: executedAt.toISOString()
				});
			}
		} else {
			for (const item of cutoffResults.items) {
				if (!item.searched && item.skipped) continue;

				await db.insert(monitoringHistory).values({
					taskHistoryId,
					taskType: 'cutoffUnmet',
					movieId: item.itemType === 'movie' ? item.itemId : undefined,
					episodeId: item.itemType === 'episode' ? item.itemId : undefined,
					seriesId:
						item.itemType === 'episode'
							? (episodeSeriesMap.get(item.itemId) ?? undefined)
							: undefined,
					status: item.grabbed
						? 'grabbed'
						: item.error
							? 'error'
							: item.releasesFound > 0
								? 'found'
								: 'no_results',
					releasesFound: item.releasesFound,
					releaseGrabbed: item.grabbedRelease,
					queueItemId: item.queueItemId,
					isUpgrade: true,
					errorMessage: item.error,
					executedAt: executedAt.toISOString()
				});
			}
		}

		logger.info(
			{
				totalProcessed: itemsProcessed,
				totalGrabbed: itemsGrabbed,
				totalErrors: errors
			},
			'[CutoffUnmetTask] Cutoff unmet task completed'
		);

		return {
			taskType: 'cutoff_unmet',
			itemsProcessed,
			itemsGrabbed,
			errors,
			executedAt
		};
	} catch (error) {
		logger.error({ err: error }, '[CutoffUnmetTask] Task failed');
		throw error;
	}
}
