/**
 * Upgrade Monitor Task
 *
 * Searches for better quality releases for ALL existing files.
 * Runs periodically (default: weekly) to find any possible upgrades,
 * regardless of whether the current file has met the quality cutoff.
 *
 * Note: This differs from CutoffUnmetTask which only searches items
 * that are below the target quality cutoff.
 */

import { db } from '#lib/server/db/index.js';
import { monitoringHistory, episodes } from '#lib/server/db/schema.js';
import { inArray } from 'drizzle-orm';
import { monitoringSearchService } from '../search/MonitoringSearchService.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';

const logger = createChildLogger({ module: 'UpgradeMonitorTask', logDomain: 'monitoring' });

/**
 * Execute upgrade search task
 * @param ctx - Execution context for cancellation support and activity tracking
 */
export async function executeUpgradeMonitorTask(
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
	logger.info({ taskHistoryId }, '[UpgradeMonitorTask] Starting upgrade search');

	let itemsProcessed: number;
	let itemsGrabbed: number;
	let errors: number;

	try {
		// Check for cancellation before starting
		ctx?.checkCancelled();

		// Search for ALL potential upgrades (both movies and episodes)
		// cutoffUnmetOnly: false means we search everything, not just items below cutoff
		const upgradeResults = await monitoringSearchService.searchForUpgrades({
			cutoffUnmetOnly: false,
			ignoreCooldown,
			cooldownHours,
			signal: ctx?.abortSignal
		});

		itemsProcessed = upgradeResults.summary.searched;
		itemsGrabbed = upgradeResults.summary.grabbed;
		errors = upgradeResults.summary.errors;

		logger.info(
			{
				searched: upgradeResults.summary.searched,
				grabbed: upgradeResults.summary.grabbed,
				errors: upgradeResults.summary.errors
			},
			'[UpgradeMonitorTask] Upgrade search completed'
		);

		// Batch-fetch seriesId for episode items so history rows are correctly linked
		const episodeIds = upgradeResults.items
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
			for await (const item of ctx.iterate(upgradeResults.items)) {
				if (!item.searched && item.skipped) continue;

				await db.insert(monitoringHistory).values({
					taskHistoryId,
					taskType: 'upgrade',
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
			for (const item of upgradeResults.items) {
				if (!item.searched && item.skipped) continue;

				await db.insert(monitoringHistory).values({
					taskHistoryId,
					taskType: 'upgrade',
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
			'[UpgradeMonitorTask] Upgrade monitor task completed'
		);

		return {
			taskType: 'upgrade',
			itemsProcessed,
			itemsGrabbed,
			errors,
			executedAt
		};
	} catch (error) {
		logger.error({ err: error }, '[UpgradeMonitorTask] Task failed');
		throw error;
	}
}
