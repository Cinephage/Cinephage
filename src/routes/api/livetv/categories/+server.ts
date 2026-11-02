/**
 * Categories API Endpoint
 *
 * GET /api/livetv/categories - List cached categories for filtering
 */

import type { RequestHandler } from './$types';
import { getLiveTvChannelService } from '#lib/server/livetv/LiveTvChannelService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTvCategories', logDomain: 'livetv' });

export const GET: RequestHandler = async ({ url }) => {
	const channelService = getLiveTvChannelService();

	// Parse query parameters
	const accountIdsParam = url.searchParams.get('accountIds');
	const accountIdParam = url.searchParams.get('accountId');

	const accountIds =
		accountIdsParam
			?.split(',')
			.map((v) => v.trim())
			.filter(Boolean) ?? (accountIdParam ? [accountIdParam] : undefined);

	try {
		const categories = await channelService.getCategories(accountIds);
		return Response.json({
			success: true,
			categories
		});
	} catch (error) {
		logger.error('[API] Failed to get categories', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to get categories'
			},
			{ status: 500 }
		);
	}
};
