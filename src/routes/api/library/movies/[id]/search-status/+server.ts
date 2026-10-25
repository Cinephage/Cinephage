import type { RequestHandler } from './$types.js';
import { isMovieSearching } from '#lib/server/library/ActiveSearchTracker.js';

/**
 * GET /api/library/movies/[id]/search-status
 * Check if a search is currently running for this movie
 */
export const GET: RequestHandler = async ({ params }) => {
	const movieId = params.id;

	const isSearching = isMovieSearching(movieId);

	return Response.json({
		isSearching,
		movieId
	});
};
