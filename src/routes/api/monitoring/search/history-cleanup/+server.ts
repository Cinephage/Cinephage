import type { RequestHandler } from './$types';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({
	module: 'MonitoringSearchHistoryCleanupApi',
	logDomain: 'monitoring'
});

/**
 * POST /api/monitoring/search/history-cleanup
 * Manually trigger history cleanup (the task the scheduler also runs daily)
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const result = await monitoringScheduler.runHistoryCleanup();

		return Response.json({
			success: true,
			message: 'History cleanup completed',
			result
		});
	} catch (error) {
		logger.error('[API] Failed to run history cleanup', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: 'Failed to run history cleanup',
				message: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};
