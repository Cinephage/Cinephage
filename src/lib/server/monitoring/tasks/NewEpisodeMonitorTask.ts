/**
 * New Episode Monitor Task
 *
 * Searches for episodes that have recently aired.
 * Runs periodically (default: hourly) to grab new episodes as they become available.
 */

import { db } from '#lib/server/db/index.js';
import { monitoringHistory, episodes } from '#lib/server/db/schema.js';
import { inArray } from 'drizzle-orm';
import { monitoringSearchService } from '../search/MonitoringSearchService.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';

const logger = createChildLogger({ module: 'NewEpisodeMonitorTask', logDomain: 'monitoring' });

/**
 * Execute new episode search task
 * @param intervalHours - The interval in hours for determining "recently aired"
 * @param ctx - Execution context for cancellation support and activity tracking
 */
export async function executeNewEpisodeMonitorTask(
	intervalHours: number,
	ctx: TaskExecutionContext | null
): Promise<TaskResult> {
	const executedAt = new Date();
	const taskHistoryId = ctx?.historyId;
	logger.info(
		{
			intervalHours,
			taskHistoryId
		},
		'[NewEpisodeMonitorTask] Starting new episode search'
	);

	let itemsProcessed: number;
	let itemsGrabbed: number;
	let errors: number;

	try {
		// Check for cancellation before starting
		ctx?.checkCancelled();

		// Search for newly aired episodes
		const episodeResults = await monitoringSearchService.searchNewEpisodes(
			intervalHours,
			ctx?.abortSignal
		);

		itemsProcessed = episodeResults.summary.searched;
		itemsGrabbed = episodeResults.summary.grabbed;
		errors = episodeResults.summary.errors;

		logger.info(
			{
				searched: episodeResults.summary.searched,
				grabbed: episodeResults.summary.grabbed,
				errors: episodeResults.summary.errors
			},
			'[NewEpisodeMonitorTask] New episode search completed'
		);

		// Batch-fetch seriesId for episode items so history rows are correctly linked
		const episodeIds = episodeResults.items
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

		// Record history for each episode (with cancellation checks)
		if (ctx) {
			for await (const item of ctx.iterate(episodeResults.items)) {
				if (!item.searched && item.skipped) continue;

				await db.insert(monitoringHistory).values({
					taskHistoryId,
					taskType: 'new_episode',
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
					isUpgrade: false,
					errorMessage: item.error,
					executedAt: executedAt.toISOString()
				});
			}
		} else {
			for (const item of episodeResults.items) {
				if (!item.searched && item.skipped) continue;

				await db.insert(monitoringHistory).values({
					taskHistoryId,
					taskType: 'new_episode',
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
					isUpgrade: false,
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
			'[NewEpisodeMonitorTask] New episode monitor task completed'
		);

		return {
			taskType: 'new_episode',
			itemsProcessed,
			itemsGrabbed,
			errors,
			executedAt
		};
	} catch (error) {
		logger.error({ err: error }, '[NewEpisodeMonitorTask] Task failed');
		throw error;
	}
}
