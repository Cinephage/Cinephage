/**
 * Channel Countries API Endpoint
 *
 * GET /api/livetv/channels/countries - Distinct country codes present in
 * cached channel metadata (Cinephage Live), with channel counts. Powers the
 * channel browser's country filter.
 */

import type { RequestHandler } from './$types';
import { getLiveTvChannelService } from '#lib/server/livetv/LiveTvChannelService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTvChannelCountries', logDomain: 'livetv' });

export const GET: RequestHandler = async ({ url }) => {
	const channelService = getLiveTvChannelService();

	const accountIdsParam = url.searchParams.get('accountIds');
	const accountIdParam = url.searchParams.get('accountId');

	const accountIds =
		accountIdsParam
			?.split(',')
			.map((v) => v.trim())
			.filter(Boolean) ?? (accountIdParam ? [accountIdParam] : undefined);

	try {
		const countries = await channelService.getChannelCountries(accountIds);
		return Response.json({
			success: true,
			countries
		});
	} catch (error) {
		logger.error(
			'[API] Failed to get channel countries',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to get channel countries'
			},
			{ status: 500 }
		);
	}
};
