import type { RequestHandler } from './$types';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({
	module: 'MonitoringSearchNewEpisodesApi',
	logDomain: 'monitoring'
});

/**
 * POST /api/monitoring/search/new-episodes
 * Manually trigger new episode check
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const result = await monitoringScheduler.runNewEpisodeCheck();

		return Response.json({
			success: true,
			message: 'New episode check completed',
			result
		});
	} catch (error) {
		logger.error(
			'[API] Failed to run new episode check',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to run new episode check',
				message: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};
