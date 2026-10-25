/**
 * Clear Failed Queue Items API
 *
 * POST /api/queue/clear-failed - Clear failed downloads from the queue
 *
 * Query params:
 *   olderThanDays=N - Only clear items that failed more than N days ago
 *   dryRun=true - Preview what would be cleared without actually clearing
 */

import type { RequestHandler } from './$types';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'QueueClearFailedApi', logDomain: 'downloads' });

export const POST: RequestHandler = async ({ url }) => {
	const dryRun = url.searchParams.get('dryRun') === 'true';
	const olderThanDaysParam = url.searchParams.get('olderThanDays');
	const olderThanDays = olderThanDaysParam ? parseInt(olderThanDaysParam, 10) : undefined;

	logger.info({ dryRun, olderThanDays }, 'Clear failed items requested');

	try {
		const result = await downloadMonitor.clearFailedItems({
			olderThanDays,
			dryRun
		});

		return Response.json({
			success: true,
			dryRun,
			olderThanDays,
			summary: {
				cleared: result.cleared.length,
				total: result.total
			},
			cleared: result.cleared
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ error: message }, 'Clear failed items failed');

		return Response.json(
			{
				success: false,
				error: message
			},
			{ status: 500 }
		);
	}
};
