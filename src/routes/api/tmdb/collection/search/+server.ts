import type { RequestHandler } from './$types';
import { tmdb } from '#lib/server/tmdb.js';

/**
 * GET /api/tmdb/collection/search?q=query
 * Search TMDB collections by name.
 */
export const GET: RequestHandler = async ({ url }) => {
	const q = url.searchParams.get('q')?.trim() ?? '';
	if (!q) {
		return Response.json([]);
	}

	const results = await tmdb.searchCollections(q);
	return Response.json(results);
};
