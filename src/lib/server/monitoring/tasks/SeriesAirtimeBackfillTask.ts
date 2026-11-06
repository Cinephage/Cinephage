import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { series } from '#lib/server/db/schema.js';
import { timezoneForCountry, tvdbClient } from '#lib/server/availability/providers/tvdb.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';
import { TaskCancelledException } from '#lib/server/tasks/TaskCancelledException.js';

const logger = createChildLogger({ module: 'SeriesAirtimeBackfillTask', logDomain: 'monitoring' });

export interface SeriesAirtimeBackfillOptions {
	limit?: number;
	paceMs?: number;
}

/**
 * Fill `series.air_time` / `airs_days` / `air_tz` from TVDB.
 *
 * TMDB has no broadcast time, so this is the only source for "21:00 Wednesdays".
 * Selection is "series with a tvdb id and no air_time yet", which makes the task
 * resumable and safe to re-run; a series TVDB has no schedule for simply stays
 * null and gets retried on a later run.
 */
export async function executeSeriesAirtimeBackfillTask(
	ctx: TaskExecutionContext | null,
	options: SeriesAirtimeBackfillOptions = {}
): Promise<TaskResult> {
	const executedAt = new Date();
	const limit = options.limit ?? 200;
	const paceMs = options.paceMs ?? 300;

	logger.info({ limit, paceMs }, '[SeriesAirtimeBackfill] Starting');

	let itemsProcessed = 0;
	let itemsUpdated = 0;
	let itemsSkipped = 0;
	let errors = 0;

	try {
		ctx?.checkCancelled();

		if (!(await tvdbClient.isConfigured())) {
			logger.warn('[SeriesAirtimeBackfill] TVDB API key not configured - nothing to do');
			return {
				taskType: 'series-airtime-backfill',
				itemsProcessed: 0,
				itemsGrabbed: 0,
				errors: 0,
				executedAt
			};
		}

		const pending = await db
			.select({ id: series.id, tvdbId: series.tvdbId, title: series.title })
			.from(series)
			.where(and(isNotNull(series.tvdbId), isNull(series.airTime)))
			.orderBy(asc(series.id))
			.limit(limit);

		logger.info({ count: pending.length }, '[SeriesAirtimeBackfill] Series without air time');

		for await (const show of ctx?.iterate?.(pending) ?? pending) {
			ctx?.checkCancelled();

			try {
				const schedule = show.tvdbId ? await tvdbClient.getSeriesSchedule(show.tvdbId) : null;

				if (!schedule?.airTime) {
					itemsSkipped++;
				} else {
					await db
						.update(series)
						.set({
							airTime: schedule.airTime,
							airsDays: schedule.airsDays.length > 0 ? JSON.stringify(schedule.airsDays) : null,
							airTz: timezoneForCountry(schedule.country)
						})
						.where(eq(series.id, show.id));
					itemsUpdated++;
				}
			} catch (err) {
				errors++;
				logger.error(
					{ err, seriesId: show.id, tvdbId: show.tvdbId },
					'[SeriesAirtimeBackfill] Series failed'
				);
			}

			itemsProcessed++;
			if (itemsProcessed % 50 === 0) {
				logger.info(
					{ itemsProcessed, itemsUpdated, itemsSkipped, errors },
					'[SeriesAirtimeBackfill] Progress'
				);
			}

			await ctx?.delay(paceMs);
		}

		logger.info(
			{ itemsProcessed, itemsUpdated, itemsSkipped, errors },
			'[SeriesAirtimeBackfill] Completed'
		);

		return {
			taskType: 'series-airtime-backfill',
			itemsProcessed,
			itemsGrabbed: itemsUpdated,
			errors,
			executedAt
		};
	} catch (error) {
		if (TaskCancelledException.isTaskCancelled(error)) {
			logger.info({ itemsProcessed }, '[SeriesAirtimeBackfill] Cancelled');
		} else {
			logger.error({ err: error }, '[SeriesAirtimeBackfill] Failed');
		}
		throw error;
	}
}
