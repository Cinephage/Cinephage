import type { RequestHandler } from './$types.js';
import { computeMovieFileScore } from '#lib/server/scoring/file-scorer.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryMovieScoreApi', logDomain: 'scans' });

/**
 * GET /api/library/movies/[id]/score
 * Get the score details for a movie's primary file
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const result = await computeMovieFileScore(params.id);

		if (!result) {
			return Response.json(
				{
					success: false,
					error: 'Movie not found or has no files'
				},
				{ status: 404 }
			);
		}

		return Response.json({
			success: true,
			score: result
		});
	} catch (error) {
		logger.error('[API] Error computing movie score', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to compute score'
			},
			{ status: 500 }
		);
	}
};
