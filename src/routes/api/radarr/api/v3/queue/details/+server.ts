import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildQueueDetails } from '#lib/server/arr/queue.js';

/**
 * GET /api/radarr/api/v3/queue/details
 * Same queue records as /queue, unpaginated and optionally filtered to a
 * single movie.
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const movieIdParam = event.url.searchParams.get('movieId');
	const movieId = movieIdParam ? Number.parseInt(movieIdParam, 10) : undefined;

	return Response.json(await buildQueueDetails('Radarr', { movieId }));
};
