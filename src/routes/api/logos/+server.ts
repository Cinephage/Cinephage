import type { RequestHandler } from './$types';
import { createChildLogger } from '#lib/logging/index.js';
import { getLogoDownloadService } from '#lib/server/logos/LogoDownloadService.js';
import { listLogos } from '#lib/server/logos/logo-library.js';

const logger = createChildLogger({ module: 'LogosApi', logDomain: 'system' });

/**
 * GET /api/logos
 * List all logos with optional search and filter
 * Query params:
 *   - search: Filter by channel name (case-insensitive, partial match)
 *   - country: Filter by country code (e.g., 'united-states')
 *   - limit: Maximum results (default: 50)
 *   - offset: Pagination offset (default: 0)
 */
export const GET: RequestHandler = async ({ url }) => {
	try {
		// Check if logos are downloaded
		const service = getLogoDownloadService();
		const isDownloaded = await service.isDownloaded();

		if (!isDownloaded) {
			return Response.json(
				{
					success: false,
					error: 'Logos not downloaded',
					code: 'NOT_DOWNLOADED'
				},
				{ status: 404 }
			);
		}

		const search = url.searchParams.get('search')?.toLowerCase() || '';
		const country = url.searchParams.get('country') || '';
		const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
		const offset = parseInt(url.searchParams.get('offset') || '0', 10);

		const result = await listLogos({
			search,
			country,
			limit,
			offset
		});

		return Response.json({
			success: true,
			data: result.data,
			pagination: result.pagination,
			library: result.library
		});
	} catch (error) {
		logger.error('[LogosAPI] Failed to list logos', error);
		return Response.json(
			{
				success: false,
				error: 'Failed to load logos'
			},
			{ status: 500 }
		);
	}
};
