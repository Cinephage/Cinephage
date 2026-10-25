import type { RequestHandler } from './$types';
import { getLogoDownloadService } from '#lib/server/logos/LogoDownloadService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LogosStatusApi', logDomain: 'system' });

/**
 * GET /api/logos/status
 * Check if logos are downloaded and get count
 */
export const GET: RequestHandler = async () => {
	try {
		const service = getLogoDownloadService();
		const status = await service.getStatus();

		return Response.json({
			success: true,
			data: status
		});
	} catch (error) {
		logger.error('[LogosStatusAPI] Failed to get status', error);
		return Response.json(
			{
				success: false,
				error: 'Failed to get logo status'
			},
			{ status: 500 }
		);
	}
};
