import { db } from '#lib/server/db/index.js';
import { movies, series } from '#lib/server/db/schema.js';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { tmdb } from '#lib/server/tmdb.js';
import { resolveLanguageForFetch } from '#lib/server/metadata/metadata-refresh.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';
import { TaskCancelledException } from '#lib/server/tasks/TaskCancelledException.js';

const logger = createChildLogger({
	module: 'OriginalLanguageBackfillTask',
	logDomain: 'monitoring'
});

/**
 * Backfill the nullable `original_language` column for movies and series that
 * predate its introduction (folder-scan imports, older rows). Resumable by
 * design: only rows with a NULL original_language (and a known tmdbId) are
 * selected, so re-running the task continues where a previous run stopped.
 */
export async function executeOriginalLanguageBackfillTask(
	ctx: TaskExecutionContext | null
): Promise<TaskResult> {
	const executedAt = new Date();
	logger.info('[OriginalLanguageBackfillTask] Starting original language backfill');

	let itemsProcessed = 0;
	let itemsUpdated = 0;
	let errors = 0;

	try {
		ctx?.checkCancelled();

		const moviesToBackfill = await db
			.select({
				id: movies.id,
				tmdbId: movies.tmdbId,
				title: movies.title,
				metadataLanguageMode: movies.metadataLanguageMode,
				metadataLanguageValue: movies.metadataLanguageValue
			})
			.from(movies)
			.where(and(isNull(movies.originalLanguage), isNotNull(movies.tmdbId)));

		logger.info(
			{ count: moviesToBackfill.length },
			'[OriginalLanguageBackfillTask] Found movies missing original_language'
		);

		for await (const movie of ctx?.iterate?.(moviesToBackfill) ?? moviesToBackfill) {
			try {
				// Per-item language resolution, mirroring metadata refresh: explicit
				// overrides are honored; 'original' resolves to the global locale here
				// because the whole point is that the original language is unknown.
				const lang = resolveLanguageForFetch(
					movie.metadataLanguageMode,
					movie.metadataLanguageValue,
					null
				);
				const details = await tmdb.getMovie(movie.tmdbId, lang);
				const originalLanguage = details.original_language || null;
				if (originalLanguage) {
					await db.update(movies).set({ originalLanguage }).where(eq(movies.id, movie.id));
					itemsUpdated++;
				} else {
					logger.debug(
						{ movieId: movie.id, tmdbId: movie.tmdbId },
						'[OriginalLanguageBackfillTask] TMDB response carried no original_language; will retry'
					);
				}
			} catch (err) {
				errors++;
				logger.error(
					{ err, movieId: movie.id, tmdbId: movie.tmdbId },
					'[OriginalLanguageBackfillTask] Failed to backfill movie'
				);
			}

			itemsProcessed++;

			if (itemsProcessed % 50 === 0) {
				logger.info(
					{ itemsProcessed, itemsUpdated, errors, total: moviesToBackfill.length },
					'[OriginalLanguageBackfillTask] Progress (movies)'
				);
			}

			await ctx?.delay(250);
		}

		ctx?.checkCancelled();

		const seriesToBackfill = await db
			.select({
				id: series.id,
				tmdbId: series.tmdbId,
				title: series.title,
				metadataLanguageMode: series.metadataLanguageMode,
				metadataLanguageValue: series.metadataLanguageValue
			})
			.from(series)
			.where(and(isNull(series.originalLanguage), isNotNull(series.tmdbId)));

		logger.info(
			{ count: seriesToBackfill.length },
			'[OriginalLanguageBackfillTask] Found series missing original_language'
		);

		for await (const s of ctx?.iterate?.(seriesToBackfill) ?? seriesToBackfill) {
			try {
				const lang = resolveLanguageForFetch(s.metadataLanguageMode, s.metadataLanguageValue, null);
				const details = await tmdb.getTVShow(s.tmdbId, lang);
				const originalLanguage = details.original_language || null;
				if (originalLanguage) {
					await db.update(series).set({ originalLanguage }).where(eq(series.id, s.id));
					itemsUpdated++;
				} else {
					logger.debug(
						{ seriesId: s.id, tmdbId: s.tmdbId },
						'[OriginalLanguageBackfillTask] TMDB response carried no original_language; will retry'
					);
				}
			} catch (err) {
				errors++;
				logger.error(
					{ err, seriesId: s.id, tmdbId: s.tmdbId },
					'[OriginalLanguageBackfillTask] Failed to backfill series'
				);
			}

			itemsProcessed++;

			if (itemsProcessed % 50 === 0) {
				logger.info(
					{ itemsProcessed, itemsUpdated, errors },
					'[OriginalLanguageBackfillTask] Progress (series)'
				);
			}

			await ctx?.delay(250);
		}

		logger.info(
			{ itemsProcessed, itemsUpdated, errors },
			'[OriginalLanguageBackfillTask] Original language backfill completed'
		);

		return {
			taskType: 'original-language-backfill',
			itemsProcessed,
			itemsGrabbed: itemsUpdated,
			errors,
			executedAt
		};
	} catch (error) {
		if (TaskCancelledException.isTaskCancelled(error)) {
			logger.info({ itemsProcessed }, '[OriginalLanguageBackfillTask] Task cancelled');
		} else {
			logger.error(
				{ err: error },
				'[OriginalLanguageBackfillTask] Original language backfill failed'
			);
		}
		throw error;
	}
}
