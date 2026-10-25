/**
 * Bulk Apply Clean Names API
 *
 * POST /api/livetv/lineup/bulk-clean-names - Apply normalized names to multiple lineup items
 */

import type { RequestHandler } from './$types';
import { channelLineupService } from '#lib/server/livetv/lineup/index.js';
import { ValidationError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { BulkApplyCleanNamesRequest } from '#lib/types/livetv.js';

const logger = createChildLogger({ module: 'LiveTvLineupBulkCleanNames', logDomain: 'livetv' });

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = (await request.json()) as BulkApplyCleanNamesRequest;

		if (!body.itemIds || !Array.isArray(body.itemIds)) {
			throw new ValidationError('itemIds array is required');
		}

		if (body.itemIds.length === 0) {
			return Response.json({
				success: true,
				updated: 0,
				skippedExistingCustom: 0,
				skippedUnchanged: 0
			});
		}

		const result = await channelLineupService.bulkApplyCleanNames(body.itemIds);

		return Response.json({
			success: true,
			...result
		});
	} catch (error) {
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

		logger.error(
			'[API] Failed to bulk apply clean names',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to apply clean names'
			},
			{ status: 500 }
		);
	}
};
