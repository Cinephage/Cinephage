import { and, asc, eq, isNotNull, notExists } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { movies, releaseEvents } from '#lib/server/db/schema.js';
import { getAvailabilityService } from '#lib/server/availability/AvailabilityService.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';
import { TaskCancelledException } from '#lib/server/tasks/TaskCancelledException.js';

const logger = createChildLogger({ module: 'ReleaseEventBackfillTask', logDomain: 'monitoring' });

export interface ReleaseEventBackfillOptions {
	/** Max movies per run. Each run is resumable, so a low cap is safe. */
	limit?: number;
	/** Delay between TMDB requests, in ms. */
	paceMs?: number;
}

/**
 * Populate `release_events` for movies that have none.
 *
 * Selection is "movies with zero events" rather than a cursor, so the task is
 * naturally resumable: every run continues where the previous one stopped, and
 * a cancelled run simply leaves the remainder for next time. Movies added by
 * smartlists or imports never had release dates written at all, so the backfill
 * fetches from TMDB instead of copying the legacy columns.
 */
export async function executeReleaseEventBackfillTask(
	ctx: TaskExecutionContext | null,
	options: ReleaseEventBackfillOptions = {}
): Promise<TaskResult> {
	const executedAt = new Date();
	const limit = options.limit ?? 250;
	const paceMs = options.paceMs ?? 250;
	const service = getAvailabilityService();

	logger.info({ limit, paceMs }, '[ReleaseEventBackfill] Starting');

	let itemsProcessed = 0;
	let itemsUpdated = 0;
	let itemsSkipped = 0;
	let errors = 0;

	try {
		ctx?.checkCancelled();

		const pending = await db
			.select({ id: movies.id, tmdbId: movies.tmdbId })
			.from(movies)
			.where(
				and(
					isNotNull(movies.tmdbId),
					notExists(
						db
							.select({ id: releaseEvents.id })
							.from(releaseEvents)
							.where(
								and(
									eq(releaseEvents.mediaType, 'movie'),
									eq(releaseEvents.mediaId, movies.id)
								)
							)
					)
				)
			)
			.orderBy(asc(movies.id))
			.limit(limit);

		logger.info({ count: pending.length }, '[ReleaseEventBackfill] Movies without events');

		for await (const movie of ctx?.iterate?.(pending) ?? pending) {
			ctx?.checkCancelled();

			try {
				const result = await service.refreshMovie({ id: movie.id, tmdbId: movie.tmdbId });
				if (result.written > 0) itemsUpdated++;
				else itemsSkipped++;
			} catch (err) {
				errors++;
				logger.error(
					{ err, movieId: movie.id, tmdbId: movie.tmdbId },
					'[ReleaseEventBackfill] Movie failed'
				);
			}

			itemsProcessed++;
			if (itemsProcessed % 50 === 0) {
				logger.info(
					{ itemsProcessed, itemsUpdated, itemsSkipped, errors },
					'[ReleaseEventBackfill] Progress'
				);
			}

			await ctx?.delay(paceMs);
		}

		logger.info(
			{ itemsProcessed, itemsUpdated, itemsSkipped, errors },
			'[ReleaseEventBackfill] Completed'
		);

		return {
			taskType: 'release-event-backfill',
			itemsProcessed,
			itemsGrabbed: itemsUpdated,
			errors,
			executedAt
		};
	} catch (error) {
		if (TaskCancelledException.isTaskCancelled(error)) {
			logger.info({ itemsProcessed }, '[ReleaseEventBackfill] Cancelled');
		} else {
			logger.error({ err: error }, '[ReleaseEventBackfill] Failed');
		}
		throw error;
	}
}
