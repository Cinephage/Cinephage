import type { RequestHandler } from './$types';
import { getCaptchaSolver } from '#lib/server/captcha/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'CaptchaSolverHealthApi', logDomain: 'indexers' });

/**
 * GET /api/captcha-solver/health
 * Returns health status and statistics for the captcha solver
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	try {
		const solver = getCaptchaSolver();
		const health = solver.getHealth();

		return Response.json({
			success: true,
			health
		});
	} catch (error) {
		logger.error(
			'[API] Failed to get captcha solver health',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to get captcha solver health'
			},
			{ status: 500 }
		);
	}
};

/**
 * DELETE /api/captcha-solver/health
 * Resets statistics and clears the cache
 */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	try {
		const solver = getCaptchaSolver();
		solver.resetStats();
		solver.clearCache();

		return Response.json({
			success: true,
			message: 'Cache cleared and statistics reset'
		});
	} catch (error) {
		logger.error(
			'[API] Failed to reset captcha solver stats',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to reset captcha solver stats'
			},
			{ status: 500 }
		);
	}
};
