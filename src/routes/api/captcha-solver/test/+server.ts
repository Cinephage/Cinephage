import type { RequestHandler } from './$types';
import { getCaptchaSolver } from '#lib/server/captcha/index.js';
import { captchaSolverTestSchema } from '#lib/validation/schemas.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'CaptchaSolverTestApi', logDomain: 'indexers' });

/**
 * POST /api/captcha-solver/test
 * Test captcha solving for a URL
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	try {
		const body = await request.json();
		const validation = captchaSolverTestSchema.safeParse(body);

		if (!validation.success) {
			return Response.json(
				{
					success: false,
					error: 'Invalid request body',
					details: validation.error.issues
				},
				{ status: 400 }
			);
		}

		const { url } = validation.data;
		const solver = getCaptchaSolver();

		// First, test if there's a challenge
		logger.info({ url }, '[API] Testing for challenge');
		const testResult = await solver.test(url);

		if (!testResult.hasChallenge) {
			return Response.json({
				success: true,
				hasChallenge: false,
				message: 'No challenge detected for this URL'
			});
		}

		// Try to solve it
		logger.info(
			{
				url,
				type: testResult.type,
				confidence: testResult.confidence
			},
			'[API] Challenge detected, attempting solve'
		);

		const solveResult = await solver.solve({ url });

		return Response.json({
			success: solveResult.success,
			hasChallenge: true,
			challengeType: testResult.type,
			confidence: testResult.confidence,
			solveTimeMs: solveResult.solveTimeMs,
			cookiesObtained: solveResult.cookies.length,
			userAgent: solveResult.userAgent,
			error: solveResult.error
		});
	} catch (error) {
		logger.error('[API] Failed to test captcha solver', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to test captcha solver'
			},
			{ status: 500 }
		);
	}
};
