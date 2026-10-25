/**
 * Portal Scan History API
 *
 * GET /api/livetv/portals/[id]/scan/history - Get scan history
 */

import type { RequestHandler } from './$types';
import { getPortalScannerService } from '#lib/server/livetv/stalker/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTvPortalScanHistory', logDomain: 'livetv' });

/**
 * Get scan history for a portal
 */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const limit = parseInt(url.searchParams.get('limit') || '20', 10);

		const scannerService = getPortalScannerService();
		const history = await scannerService.getScanHistory(params.id, limit);

		return Response.json({
			success: true,
			history
		});
	} catch (error) {
		logger.error('[API] Failed to get scan history', error instanceof Error ? error : undefined);

		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to get scan history'
			},
			{ status: 500 }
		);
	}
};
