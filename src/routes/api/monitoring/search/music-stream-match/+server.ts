import type { RequestHandler } from './$types';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({
	module: 'MonitoringSearchMusicStreamMatchApi',
	logDomain: 'monitoring'
});

/** POST /api/monitoring/search/music-stream-match — run the match pass now. */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const result = await monitoringScheduler.runMusicStreamMatch();

		return Response.json({
			success: true,
			message: 'Streamed music match completed',
			result
		});
	} catch (error) {
		logger.error(
			'[API] Failed to match streamed music',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to match streamed music',
				message: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};
