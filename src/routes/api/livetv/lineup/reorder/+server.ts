/**
 * Lineup Reorder API
 *
 * POST /api/livetv/lineup/reorder - Reorder lineup items
 */

import type { RequestHandler } from './$types';
import { channelLineupService } from '#lib/server/livetv/lineup/index.js';
import { ValidationError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { ReorderLineupRequest } from '#lib/types/livetv.js';

const logger = createChildLogger({ module: 'LiveTvLineupReorder', logDomain: 'livetv' });

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = (await request.json()) as ReorderLineupRequest;

		if (!body.itemIds || !Array.isArray(body.itemIds)) {
			throw new ValidationError('itemIds array is required');
		}

		if (body.itemIds.length === 0) {
			return Response.json({
				success: true
			});
		}

		await channelLineupService.reorderLineup(body.itemIds);

		return Response.json({
			success: true
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
		logger.error('[API] Failed to reorder lineup', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to reorder lineup'
			},
			{ status: 500 }
		);
	}
};
