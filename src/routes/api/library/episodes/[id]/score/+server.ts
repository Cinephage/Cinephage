import type { RequestHandler } from './$types.js';
import { computeEpisodeFileScore } from '#lib/server/scoring/file-scorer.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryEpisodeScoreApi', logDomain: 'scans' });

/**
 * GET /api/library/episodes/[id]/score
 * Get the score details for an episode's file
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const result = await computeEpisodeFileScore(params.id);

		if (!result) {
			return Response.json(
				{
					success: false,
					error: 'Episode not found or has no file'
				},
				{ status: 404 }
			);
		}

		return Response.json({
			success: true,
			score: result
		});
	} catch (error) {
		logger.error('[API] Error computing episode score', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to compute score'
			},
			{ status: 500 }
		);
	}
};
