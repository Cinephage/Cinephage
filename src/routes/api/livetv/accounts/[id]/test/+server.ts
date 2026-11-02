/**
 * Test Existing Live TV Account API
 *
 * POST /api/livetv/accounts/[id]/test - Test an existing account connection
 */

import type { RequestHandler } from './$types';
import { getLiveTvAccountManager } from '#lib/server/livetv/LiveTvAccountManager.js';
import { createChildLogger } from '#lib/logging/index.js';
import { toFriendlyLiveTvTestError } from '#lib/livetv/errorMessages.js';

const logger = createChildLogger({ module: 'LiveTvAccountTest', logDomain: 'livetv' });

/**
 * Test an existing Live TV account by ID
 * Updates the account's test results and metadata
 */
export const POST: RequestHandler = async ({ params }) => {
	try {
		const manager = getLiveTvAccountManager();
		const result = await manager.testAccount(params.id);

		if (!result.success && result.error === 'Account not found') {
			return Response.json(
				{
					success: false,
					error: 'Account not found'
				},
				{ status: 404 }
			);
		}

		const responseResult = result.success
			? result
			: {
					...result,
					error: toFriendlyLiveTvTestError(result.error)
				};

		return Response.json({
			success: true,
			result: responseResult
		});
	} catch (error) {
		logger.error(
			'[API] Failed to test Live TV account',
			error instanceof Error ? error : undefined
		);

		return Response.json(
			{
				success: false,
				error: toFriendlyLiveTvTestError(
					error instanceof Error ? error.message : 'Failed to test account'
				)
			},
			{ status: 500 }
		);
	}
};
