import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { series, rootFolders } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { addSeriesSchema } from '#lib/validation/schemas.js';
import { addSeriesToLibrary } from '#lib/server/library/add/add-series.js';
import { ValidationError, isAppError } from '#lib/errors/index.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibrarySeriesApi', logDomain: 'scans' });

/**
 * Generate a folder name for a series using the naming service
 * Uses database naming configuration instead of defaults
 */
/**
 * GET /api/library/series
 * List all series in the library
 */
export const GET: RequestHandler = async (event) => {
	// Require authentication
	const authError = requireAuth(event);
	if (authError) return authError;

	try {
		const allSeries = await db
			.select({
				id: series.id,
				tmdbId: series.tmdbId,
				tvdbId: series.tvdbId,
				imdbId: series.imdbId,
				title: series.title,
				originalTitle: series.originalTitle,
				year: series.year,
				overview: series.overview,
				posterPath: series.posterPath,
				backdropPath: series.backdropPath,
				status: series.status,
				network: series.network,
				genres: series.genres,
				path: series.path,
				rootFolderId: series.rootFolderId,
				rootFolderPath: rootFolders.path,
				rootFolderMediaType: rootFolders.mediaType,
				scoringProfileId: series.scoringProfileId,
				monitored: series.monitored,
				seasonFolder: series.seasonFolder,
				added: series.added,
				episodeCount: series.episodeCount,
				episodeFileCount: series.episodeFileCount
			})
			.from(series)
			.leftJoin(rootFolders, eq(series.rootFolderId, rootFolders.id));

		// Calculate percentages and format data
		const seriesWithStats = allSeries.map((s) => ({
			...s,
			missingRootFolder: !s.rootFolderId || !s.rootFolderPath || s.rootFolderMediaType !== 'tv',
			percentComplete:
				s.episodeCount && s.episodeCount > 0
					? Math.round(((s.episodeFileCount || 0) / s.episodeCount) * 100)
					: 0
		}));

		return Response.json({
			success: true,
			series: seriesWithStats,
			total: seriesWithStats.length
		});
	} catch (error) {
		logger.error('[API] Error fetching series', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to fetch series'
			},
			{ status: 500 }
		);
	}
};

/**
 * POST /api/library/series
 * Add a TV series to the library by TMDB ID
 */
export const POST: RequestHandler = async (event) => {
	const { request } = event;

	// Require authentication
	const authError = requireAuth(event);
	if (authError) return authError;

	try {
		const body = await request.json();
		const result = addSeriesSchema.safeParse(body);

		if (!result.success) {
			throw new ValidationError('Validation failed', {
				details: result.error.flatten()
			});
		}

		const addResult = await addSeriesToLibrary(result.data);

		if (addResult.outcome === 'exists') {
			return Response.json(
				{
					success: false,
					error: 'Series already exists in library',
					seriesId: addResult.seriesId
				},
				{ status: 409 }
			);
		}

		return Response.json({
			success: true,
			series: {
				id: addResult.seriesId,
				tmdbId: addResult.tmdbId,
				title: addResult.title,
				year: addResult.year,
				path: addResult.path,
				monitored: addResult.monitored,
				episodeCount: addResult.episodeCount,
				searchTriggered: addResult.searchTriggered,
				searchWarning: addResult.searchWarning
			}
		});
	} catch (error) {
		logger.error('[API] Error adding series', error instanceof Error ? error : undefined);

		if (isAppError(error)) {
			return Response.json(
				{
					success: false,
					...error.toJSON()
				},
				{ status: error.statusCode }
			);
		}

		if (error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message)) {
			return Response.json(
				{
					success: false,
					error:
						'The selected root folder or one of its linked library settings is no longer valid. Refresh the page and try again.',
					code: 'LIBRARY_CONFIGURATION_STALE'
				},
				{ status: 409 }
			);
		}

		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to add series'
			},
			{ status: 500 }
		);
	}
};
