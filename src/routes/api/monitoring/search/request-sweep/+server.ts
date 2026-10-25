import type { RequestHandler } from './$types';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({
	module: 'MonitoringSearchRequestSweepApi',
	logDomain: 'monitoring'
});

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const result = await monitoringScheduler.runRequestSweep();

		return Response.json({
			success: true,
			message: 'Request sweep completed',
			result
		});
	} catch (error) {
		logger.error('[API] Failed to run request sweep', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: 'Failed to run request sweep',
				message: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};
