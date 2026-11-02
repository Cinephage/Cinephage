/**
 * Bulk Set Category API
 *
 * POST /api/livetv/lineup/bulk-category - Set category for multiple lineup items
 */

import type { RequestHandler } from './$types';
import { channelLineupService } from '#lib/server/livetv/lineup/index.js';
import { ValidationError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTvLineupBulkCategory', logDomain: 'livetv' });

interface BulkSetCategoryRequest {
	itemIds: string[];
	categoryId: string | null;
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = (await request.json()) as BulkSetCategoryRequest;

		if (!body.itemIds || !Array.isArray(body.itemIds)) {
			throw new ValidationError('itemIds array is required');
		}

		if (body.itemIds.length === 0) {
			return Response.json({
				success: true,
				updated: 0
			});
		}

		// categoryId can be null (for uncategorized) or a string
		const categoryId = body.categoryId === undefined ? null : body.categoryId;

		const updated = await channelLineupService.bulkSetCategory(body.itemIds, categoryId);

		return Response.json({
			success: true,
			updated
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
		logger.error('[API] Failed to bulk set category', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to update categories'
			},
			{ status: 500 }
		);
	}
};
