/**
 * POST /api/queue/relink-orphans
 *
 * Scans all enabled download clients for downloads that are active in the
 * client but have no active queue entry. For each such download, looks up
 * the failed download history (matched by hash) and re-creates the queue
 * entry using the stored media association.
 *
 * This recovers downloads where the queue entry was cleared (e.g. via
 * "Clear Failed") while the download was still running in the client.
 */

import type { RequestHandler } from './$types';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'QueueRelinkOrphansApi', logDomain: 'downloads' });

export const POST: RequestHandler = async () => {
	logger.info('Orphan relink requested');

	try {
		const result = await downloadMonitor.relinkOrphanedDownloads();

		return Response.json({
			success: true,
			relinked: result.relinked.length,
			details: result.relinked
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ error: message }, 'Orphan relink failed');
		return Response.json({ success: false, error: message }, { status: 500 });
	}
};
