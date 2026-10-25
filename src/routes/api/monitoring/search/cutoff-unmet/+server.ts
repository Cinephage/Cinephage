import type { RequestHandler } from './$types';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({
	module: 'MonitoringSearchCutoffUnmetApi',
	logDomain: 'monitoring'
});

/**
 * POST /api/monitoring/search/cutoff-unmet
 * Manually trigger cutoff unmet search
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const result = await monitoringScheduler.runCutoffUnmetSearch();

		return Response.json({
			success: true,
			message: 'Cutoff unmet search completed',
			result
		});
	} catch (error) {
		logger.error(
			'[API] Failed to run cutoff unmet search',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to run cutoff unmet search',
				message: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};
