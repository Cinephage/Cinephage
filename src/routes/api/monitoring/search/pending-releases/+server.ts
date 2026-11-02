import type { RequestHandler } from './$types';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({
	module: 'MonitoringSearchPendingReleasesApi',
	logDomain: 'monitoring'
});

/**
 * POST /api/monitoring/search/pending-releases
 * Manually trigger pending release processing
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const result = await monitoringScheduler.runPendingReleaseProcessing();

		return Response.json({
			success: true,
			message: 'Pending release processing completed',
			result
		});
	} catch (error) {
		logger.error(
			'[API] Failed to run pending release processing',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to run pending release processing',
				message: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};
