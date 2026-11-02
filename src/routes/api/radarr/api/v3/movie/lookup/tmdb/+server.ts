import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildMovieLookupByTmdbId } from '#lib/server/arr/movies.js';

/** GET /api/radarr/api/v3/movie/lookup/tmdb?tmdbId=... */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const tmdbId = Number.parseInt(event.url.searchParams.get('tmdbId') ?? '', 10);
	if (Number.isNaN(tmdbId)) error(400, 'tmdbId is required');

	let movie;
	try {
		movie = await buildMovieLookupByTmdbId(tmdbId);
	} catch (err) {
		// Anything other than a genuine "no such TMDB id" (see
		// buildMovieLookupByTmdbId) - surface the real cause (e.g. TMDB API
		// key not configured) instead of a misleading 404.
		error(502, err instanceof Error ? err.message : 'TMDB lookup failed');
	}
	if (!movie) error(404, 'Movie not found');

	return Response.json(movie);
};
