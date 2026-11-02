/**
 * Sync Status API Endpoint
 *
 * GET /api/livetv/channels/sync/status - Get sync status for all accounts
 */

import type { RequestHandler } from './$types';
import { getLiveTvChannelService } from '#lib/server/livetv/LiveTvChannelService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTvChannelsSyncStatus', logDomain: 'livetv' });

export const GET: RequestHandler = async () => {
	const channelService = getLiveTvChannelService();

	try {
		const accounts = await channelService.getSyncStatus();
		return Response.json({
			success: true,
			accounts
		});
	} catch (error) {
		logger.error('[API] Failed to get sync status', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to get sync status'
			},
			{ status: 500 }
		);
	}
};
