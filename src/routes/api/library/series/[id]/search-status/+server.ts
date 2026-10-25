import type { RequestHandler } from './$types.js';
import { isSeriesSearching } from '#lib/server/library/ActiveSearchTracker.js';

/**
 * GET /api/library/series/[id]/search-status
 * Check if a search is currently running for this series
 */
export const GET: RequestHandler = async ({ params }) => {
	const seriesId = params.id;

	const isSearching = isSeriesSearching(seriesId);

	return Response.json({
		isSearching,
		seriesId
	});
};
