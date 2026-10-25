/**
 * Bulk Remove from Lineup API
 *
 * POST /api/livetv/lineup/remove - Remove multiple items from lineup
 */

import type { RequestHandler } from './$types';
import { channelLineupService } from '#lib/server/livetv/lineup/index.js';
import { ValidationError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { RemoveFromLineupRequest } from '#lib/types/livetv.js';

const logger = createChildLogger({ module: 'LiveTvLineupRemove', logDomain: 'livetv' });

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = (await request.json()) as RemoveFromLineupRequest;

		if (!body.itemIds || !Array.isArray(body.itemIds)) {
			throw new ValidationError('itemIds array is required');
		}

		if (body.itemIds.length === 0) {
			return Response.json({
				success: true,
				removed: 0
			});
		}

		const removed = await channelLineupService.bulkRemoveFromLineup(body.itemIds);

		return Response.json({
			success: true,
			removed
		});
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
		logger.error('[API] Failed to remove from lineup', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to remove from lineup'
			},
			{ status: 500 }
		);
	}
};
