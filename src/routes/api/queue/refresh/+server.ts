/**
 * POST /api/queue/refresh
 *
 * Triggers an immediate poll of all enabled download clients, updating the
 * status of every active and failed queue item without waiting for the next
 * scheduled poll interval.
 */

import type { RequestHandler } from './$types';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'QueueRefreshApi', logDomain: 'downloads' });

export const POST: RequestHandler = async () => {
	logger.info('Manual queue refresh requested');

	try {
		await downloadMonitor.forcePoll();
		return Response.json({ success: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ error: message }, 'Manual queue refresh failed');
		return Response.json({ success: false, error: message }, { status: 500 });
	}
};
