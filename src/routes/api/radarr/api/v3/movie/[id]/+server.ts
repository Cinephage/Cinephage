import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildMovieByArrId } from '#lib/server/arr/movies.js';
import { updateMovieFromArr, deleteMovieFromArr } from '#lib/server/arr/libraryWrite.js';
import { withForwardedApiKey } from '#lib/server/arr/internalFetch.js';

/** GET /api/radarr/api/v3/movie/{id} */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const id = Number.parseInt(event.params.id, 10);
	if (Number.isNaN(id)) error(400, 'Invalid movie id');

	const movie = await buildMovieByArrId(id);
	if (!movie) error(404, 'Movie not found');

	return Response.json(movie);
};

/** PUT /api/radarr/api/v3/movie/{id} - update monitored/quality profile/availability. */
export const PUT: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const id = Number.parseInt(event.params.id, 10);
	if (Number.isNaN(id)) error(400, 'Invalid movie id');

	const body = await event.request.json().catch(() => ({}));
	const result = await updateMovieFromArr(withForwardedApiKey(event), id, body);
	return Response.json(result.body, { status: result.status });
};

/** DELETE /api/radarr/api/v3/movie/{id}?deleteFiles=true - remove from library. */
export const DELETE: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const id = Number.parseInt(event.params.id, 10);
	if (Number.isNaN(id)) error(400, 'Invalid movie id');

	const deleteFiles = event.url.searchParams.get('deleteFiles') === 'true';
	const result = await deleteMovieFromArr(withForwardedApiKey(event), id, { deleteFiles });
	return Response.json(result.body, { status: result.status });
};
