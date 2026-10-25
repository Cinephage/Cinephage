/**
 * Channel Lineup API
 *
 * GET /api/livetv/lineup - Get all lineup items
 * POST /api/livetv/lineup - Add channels to lineup
 */

import type { RequestHandler } from './$types';
import { channelLineupService } from '#lib/server/livetv/lineup/index.js';
import { ValidationError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { AddToLineupRequest } from '#lib/types/livetv.js';

const logger = createChildLogger({ module: 'LiveTvLineup', logDomain: 'livetv' });

export const GET: RequestHandler = async () => {
	try {
		const lineup = await channelLineupService.getLineup();
		const lineupChannelIds = await channelLineupService.getLineupChannelIds();

		return Response.json({
			success: true,
			lineup,
			lineupChannelIds: Array.from(lineupChannelIds),
			total: lineup.length
		});
	} catch (error) {
		logger.error('[API] Failed to get lineup', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to get lineup'
			},
			{ status: 500 }
		);
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = (await request.json()) as AddToLineupRequest;

		if (!body.channels || !Array.isArray(body.channels)) {
			throw new ValidationError('channels array is required');
		}

		if (body.channels.length === 0) {
			return Response.json({
				success: true,
				added: 0,
				skipped: 0
			});
		}

		// Validate each channel has required fields
		for (const channel of body.channels) {
			if (!channel.accountId || !channel.channelId) {
				throw new ValidationError('Each channel must have accountId and channelId');
			}
		}

		const result = await channelLineupService.addToLineup(body);

		return Response.json(
			{
				success: true,
				...result
			},
			{ status: 201 }
		);
	} catch (error) {
		// Validation errors
		if (error instanceof ValidationError) {
			return Response.json(
				{
					success: false,
					error: error.message,
					code: error.code
				},
				{ status: error.statusCode }
			);
		}
		logger.error('[API] Failed to add to lineup', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to add to lineup'
			},
			{ status: 500 }
		);
	}
};
