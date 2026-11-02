import type { RequestHandler } from './$types';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'MonitoringStatusApi', logDomain: 'monitoring' });

/**
 * GET /api/monitoring/status
 * Returns monitoring scheduler status
 */
export const GET: RequestHandler = async () => {
	try {
		const status = await monitoringScheduler.getStatus();

		return Response.json({
			success: true,
			...status
		});
	} catch (error) {
		logger.error(
			'[API] Failed to get monitoring status',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to get monitoring status'
			},
			{ status: 500 }
		);
	}
};
