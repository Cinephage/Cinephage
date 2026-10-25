import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildEpisodesForSeries, buildEpisodesByArrIds } from '#lib/server/arr/episodes.js';
import { getEntityIdForArrId } from '#lib/server/arr/ArrIdMappingService.js';

/**
 * GET /api/sonarr/api/v3/episode
 * Real Sonarr requires either seriesId or episodeIds - matching that here
 * rather than returning the whole library's episodes unfiltered.
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const { url } = event;
	const episodeIds = url.searchParams
		.getAll('episodeIds')
		.map((v) => Number.parseInt(v, 10))
		.filter((v) => !Number.isNaN(v));
	if (episodeIds.length > 0) {
		return Response.json(await buildEpisodesByArrIds(episodeIds));
	}

	const seriesIdParam = url.searchParams.get('seriesId');
	const seriesArrId = seriesIdParam ? Number.parseInt(seriesIdParam, 10) : undefined;
	if (seriesArrId === undefined || Number.isNaN(seriesArrId)) {
		error(400, 'seriesId or episodeIds is required');
	}

	const seriesId = await getEntityIdForArrId('series', seriesArrId);
	if (!seriesId) return Response.json([]);

	const seasonNumberParam = url.searchParams.get('seasonNumber');
	const seasonNumber = seasonNumberParam ? Number.parseInt(seasonNumberParam, 10) : undefined;

	return Response.json(await buildEpisodesForSeries({ seriesArrId, seriesId, seasonNumber }));
};
