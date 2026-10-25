/**
 * API endpoint for reordering backup links
 * PUT /api/livetv/lineup/[id]/backups/reorder - Reorder backup priorities
 */

import type { RequestHandler } from './$types';
import { channelLineupService } from '#lib/server/livetv/lineup/ChannelLineupService.js';
import { createChildLogger } from '#lib/logging/index.js';
import { ValidationError } from '#lib/errors/index.js';
import type { ReorderBackupsRequest } from '#lib/types/livetv.js';

const logger = createChildLogger({ module: 'LiveTvLineupBackupsReorder', logDomain: 'livetv' });

/**
 * Reorder backup links for a lineup item
 */
export const PUT: RequestHandler = async ({ params, request }) => {
	const { id } = params;

	try {
		// Verify lineup item exists
		const item = await channelLineupService.getChannelById(id);
		if (!item) {
			return Response.json(
				{
					success: false,
					error: 'Lineup item not found'
				},
				{ status: 404 }
			);
		}

		let body: ReorderBackupsRequest;
		try {
			body = await request.json();
		} catch {
			throw new ValidationError('Invalid JSON body');
		}

		if (!body.backupIds || !Array.isArray(body.backupIds)) {
			throw new ValidationError('Missing required field: backupIds (array)');
		}

		await channelLineupService.reorderBackups(id, body.backupIds);

		// Return updated backups
		const backups = await channelLineupService.getBackups(id);
		return Response.json({
			success: true,
			backups
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
		logger.error('[API] Failed to reorder backups', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to reorder backups'
			},
			{ status: 500 }
		);
	}
};
