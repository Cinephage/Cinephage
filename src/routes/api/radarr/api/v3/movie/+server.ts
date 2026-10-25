import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildMovies } from '#lib/server/arr/movies.js';
import { addMovieFromArr, updateMovieFromArr } from '#lib/server/arr/libraryWrite.js';
import { withForwardedApiKey } from '#lib/server/arr/internalFetch.js';

/** GET /api/radarr/api/v3/movie */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	return Response.json(await buildMovies());
};

/**
 * POST /api/radarr/api/v3/movie - the actual "Request" action: add a movie
 * to the library. See libraryWrite.ts for the real add flow this reuses.
 */
export const POST: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json().catch(() => ({}));
	const result = await addMovieFromArr(withForwardedApiKey(event), body);
	return Response.json(result.body, { status: result.status });
};

/**
 * PUT /api/radarr/api/v3/movie - real Radarr accepts an update at the
 * collection root (id in the body, not the URL): Seerr's addMovie() PUTs
 * here directly (not /movie/{id}) whenever getMovieByTmdbId finds the
 * movie already exists but unmonitored, to flip it to monitored.
 */
export const PUT: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json().catch(() => ({}));
	const id = Number(body.id);
	if (!Number.isInteger(id)) return Response.json({ message: 'id is required' }, { status: 400 });

	const result = await updateMovieFromArr(withForwardedApiKey(event), id, body);
	return Response.json(result.body, { status: result.status });
};
