/**
 * Smart List Refresh-All API
 * POST /api/smartlists/refresh-all - Manually trigger smart-list due refresh check
 */

import type { RequestHandler } from './$types';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SmartListsRefreshAllApi', logDomain: 'monitoring' });

export const POST: RequestHandler = async () => {
	try {
		const result = await monitoringScheduler.runSmartListRefresh();

		return Response.json({
			success: true,
			message: 'Smart list refresh completed',
			result
		});
	} catch (error) {
		logger.error(
			'[API] Failed to run smart list refresh',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to run smart list refresh',
				message: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};
