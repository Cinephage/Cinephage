import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildMovieRename } from '#lib/server/arr/rename.js';

/** GET /api/radarr/api/v3/rename?movieId=... */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const movieId = Number.parseInt(event.url.searchParams.get('movieId') ?? '', 10);
	if (Number.isNaN(movieId)) return Response.json([]);

	return Response.json(await buildMovieRename(movieId));
};
