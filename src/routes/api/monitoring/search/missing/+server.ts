import type { RequestHandler } from './$types';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'MonitoringSearchMissingApi', logDomain: 'monitoring' });

/**
 * POST /api/monitoring/search/missing
 * Manually trigger missing content search
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const result = await monitoringScheduler.runMissingContentSearch();

		return Response.json({
			success: true,
			message: 'Missing content search completed',
			result
		});
	} catch (error) {
		logger.error(
			'[API] Failed to run missing content search',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to run missing content search',
				message: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};
