import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { series } from '#lib/server/db/schema.js';
import { inArray } from 'drizzle-orm';
import { bulkAddSeriesSchema } from '#lib/validation/schemas.js';
import { addSeriesToLibrary } from '#lib/server/library/add/add-series.js';
import { validateRootFolder } from '#lib/server/library/LibraryAddService.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { ValidationError } from '#lib/errors/index.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibrarySeriesBulkApi', logDomain: 'scans' });

interface BulkAddResult {
	added: number;
	skipped: number;
	errors: { tmdbId: number; title?: string; error: string }[];
	series: { id: string; tmdbId: number; title: string }[];
}

/**
 * POST /api/library/series/bulk
 * Add multiple TV series to the library by TMDB IDs. Thin batching layer over
 * addSeriesToLibrary — the single-add implementation stays the only writer.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const body = await event.request.json();
		const result = bulkAddSeriesSchema.safeParse(body);

		if (!result.success) {
			throw new ValidationError('Validation failed', {
				details: result.error.flatten()
			});
		}

		const {
			tmdbIds,
			rootFolderId,
			scoringProfileId,
			monitored,
			seriesType,
			monitorType,
			monitorNewItems,
			monitorSpecials,
			seasonFolder,
			searchOnAdd: shouldSearch,
			wantsSubtitles
		} = result.data;

		// Validate once up front (fails fast on a bad root folder); each item
		// re-validates internally against its own anime detection.
		await validateRootFolder(rootFolderId, 'tv', { requireWritable: true });

		const existingSeries = await db
			.select({ tmdbId: series.tmdbId })
			.from(series)
			.where(inArray(series.tmdbId, tmdbIds));
		const existingTmdbIds = new Set(existingSeries.map((s) => s.tmdbId));
		const seriesToAdd = tmdbIds.filter((id) => !existingTmdbIds.has(id));

		const results: BulkAddResult = {
			added: 0,
			skipped: existingTmdbIds.size,
			errors: [],
			series: []
		};

		for (const tmdbId of seriesToAdd) {
			try {
				const addResult = await addSeriesToLibrary({
					tmdbId,
					rootFolderId,
					scoringProfileId,
					monitored,
					seriesType,
					monitorType,
					monitorNewItems,
					monitorSpecials,
					seasonFolder,
					searchOnAdd: shouldSearch,
					wantsSubtitles
				});

				if (addResult.outcome === 'exists') {
					results.skipped++;
					continue;
				}

				results.added++;
				results.series.push({
					id: addResult.seriesId,
					tmdbId: addResult.tmdbId,
					title: addResult.title
				});
			} catch (error) {
				logger.error(
					{
						err: error instanceof Error ? error : undefined,
						tmdbId
					},
					'[API] Error adding series in bulk'
				);
				results.errors.push({
					tmdbId,
					error: error instanceof Error ? error.message : 'Failed to add series'
				});
			}
		}

		if (results.added > 0) {
			libraryMediaEvents.emitLibraryDataChanged({
				source: 'series',
				reason: 'bulk-series-added'
			});
		}

		return Response.json({
			success: true,
			...results
		});
	} catch (error) {
		logger.error('[API] Error in bulk series add', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to add series'
			},
			{ status: 500 }
		);
	}
};
