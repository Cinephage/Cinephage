import type { RequestHandler } from './$types';
import { getMediaServerStatsSyncService } from '#lib/server/mediaServerStats/MediaServerStatsSyncService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const POST: RequestHandler = async ({ request }) => {
	let body: { serverId?: string } = {};
	try {
		body = await request.json();
	} catch {
		// empty body is fine
	}

	const syncService = getMediaServerStatsSyncService();

	setImmediate(() => {
		syncService.syncServer(body.serverId).catch((err) => {
			logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Sync failed');
		});
	});

	return Response.json({ success: true, message: 'Sync started' });
};
