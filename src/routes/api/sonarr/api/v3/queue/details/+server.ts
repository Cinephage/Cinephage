import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildQueueDetails } from '#lib/server/arr/queue.js';

/**
 * GET /api/sonarr/api/v3/queue/details
 * Same queue records as /queue, unpaginated and optionally filtered to a
 * series or a set of episode IDs.
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const seriesIdParam = event.url.searchParams.get('seriesId');
	const seriesId = seriesIdParam ? Number.parseInt(seriesIdParam, 10) : undefined;
	const episodeIds = event.url.searchParams
		.getAll('episodeIds')
		.map((value) => Number.parseInt(value, 10))
		.filter((value) => !Number.isNaN(value));

	return Response.json(await buildQueueDetails('Sonarr', { seriesId, episodeIds }));
};
