/**
 * Missing Content Task
 *
 * Searches for monitored movies and episodes that don't have files yet.
 * Runs periodically (default: daily) to find and grab missing content.
 */

import { db } from '#lib/server/db/index.js';
import { monitoringHistory, episodes } from '#lib/server/db/schema.js';
import { inArray } from 'drizzle-orm';
import { monitoringSearchService } from '../search/MonitoringSearchService.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';

const logger = createChildLogger({ module: 'MissingContentTask', logDomain: 'monitoring' });

interface MissingContentTaskOptions {
	/**
	 * When true, bypass per-item cooldown checks.
	 * Used for manual "run now" executions.
	 */
	ignoreCooldown?: boolean;
	/**
	 * Per-item cooldown in hours for this run.
	 * Typically derived from scheduled interval.
	 */
	cooldownHours?: number;
}

/**
 * Execute missing content search task
 * @param ctx - Execution context for cancellation support and activity tracking
 */
export async function executeMissingContentTask(
	ctx: TaskExecutionContext | null,
	options: MissingContentTaskOptions = {}
): Promise<TaskResult> {
	const executedAt = new Date();
	const taskHistoryId = ctx?.historyId;
	logger.info({ taskHistoryId }, '[MissingContentTask] Starting missing content search');

	let itemsProcessed = 0;
	let itemsGrabbed = 0;
	let errors = 0;

	try {
		// Check for cancellation before starting
		ctx?.checkCancelled();

		// Search for missing movies
		logger.info('[MissingContentTask] Searching for missing movies');
		const movieResults = await monitoringSearchService.searchMissingMovies(ctx?.abortSignal, {
			ignoreCooldown: options.ignoreCooldown,
			cooldownHours: options.cooldownHours
		});

		itemsProcessed += movieResults.summary.searched;
		itemsGrabbed += movieResults.summary.grabbed;
		errors += movieResults.summary.errors;

		logger.info(
			{
				searched: movieResults.summary.searched,
				grabbed: movieResults.summary.grabbed,
				errors: movieResults.summary.errors,
				rejectionBreakdown: movieResults.summary.rejectionBreakdown
			},
			'[MissingContentTask] Missing movies search completed'
		);

		// Record history for each movie (with cancellation checks)
		if (ctx) {
			for await (const item of ctx.iterate(movieResults.items)) {
				// Skipped items ARE recorded: without this, eligibility-skipped movies
				// (availability gates, cooldowns) are invisible in monitoring history
				// and look like "never searched" to users debugging matching.
				if (!item.searched && item.skipped) {
					await db.insert(monitoringHistory).values({
						taskHistoryId,
						taskType: 'missing',
						movieId: item.itemType === 'movie' ? item.itemId : undefined,
						episodeId: item.itemType === 'episode' ? item.itemId : undefined,
						status: 'skipped',
						errorMessage: item.skipReason,
						executedAt: executedAt.toISOString()
					});
					continue;
				}

				await db.insert(monitoringHistory).values({
					taskHistoryId,
					taskType: 'missing',
					movieId: item.itemType === 'movie' ? item.itemId : undefined,
					status:
						item.grabbed || item.grabbedRelease
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
			// No context - record without cancellation checks
			for (const item of movieResults.items) {
				if (!item.searched && item.skipped) continue;

				await db.insert(monitoringHistory).values({
					taskHistoryId,
					taskType: 'missing',
					movieId: item.itemType === 'movie' ? item.itemId : undefined,
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

		// Check for cancellation before episode search
		ctx?.checkCancelled();

		// Search for missing episodes
		logger.info('[MissingContentTask] Searching for missing episodes');
		const episodeResults = await monitoringSearchService.searchMissingEpisodes(ctx?.abortSignal, {
			ignoreCooldown: options.ignoreCooldown,
			cooldownHours: options.cooldownHours
		});

		itemsProcessed += episodeResults.summary.searched;
		itemsGrabbed += episodeResults.summary.grabbed;
		errors += episodeResults.summary.errors;

		logger.info(
			{
				searched: episodeResults.summary.searched,
				grabbed: episodeResults.summary.grabbed,
				errors: episodeResults.summary.errors,
				rejectionBreakdown: episodeResults.summary.rejectionBreakdown
			},
			'[MissingContentTask] Missing episodes search completed'
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
					taskType: 'missing',
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
					taskType: 'missing',
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
			'[MissingContentTask] Missing content task completed'
		);

		return {
			taskType: 'missing',
			itemsProcessed,
			itemsGrabbed,
			errors,
			executedAt
		};
	} catch (error) {
		logger.error({ err: error }, '[MissingContentTask] Task failed');
		throw error;
	}
}
