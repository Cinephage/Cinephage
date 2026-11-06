import type { RequestHandler } from './$types';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({
	module: 'MonitoringSearchSeriesAirtimeBackfillApi',
	logDomain: 'monitoring'
});

/**
 * POST /api/monitoring/search/series-airtime-backfill
 *
 * Fills broadcast air times/days from TVDB. Bounded per run and resumable.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const result = await monitoringScheduler.runSeriesAirtimeBackfill();

		return Response.json({
			success: true,
			message: 'Broadcast times backfill completed',
			result
		});
	} catch (error) {
		logger.error(
			'[API] Failed to run broadcast times backfill',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to run broadcast times backfill',
				message: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};
