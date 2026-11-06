import type { RequestHandler } from './$types';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({
	module: 'MonitoringSearchReleaseEventBackfillApi',
	logDomain: 'monitoring'
});

/**
 * POST /api/monitoring/search/release-event-backfill
 *
 * Runs the release-event backfill. Bounded per run (see the task's default
 * limit) and resumable, so repeat calls simply continue through the library.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const result = await monitoringScheduler.runReleaseEventBackfill();

		return Response.json({
			success: true,
			message: 'Release event backfill completed',
			result
		});
	} catch (error) {
		logger.error(
			'[API] Failed to run release event backfill',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to run release event backfill',
				message: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};
