/**
 * API endpoint for managing a specific backup link
 * DELETE /api/livetv/lineup/[id]/backups/[backupId] - Remove a backup link
 */

import type { RequestHandler } from './$types';
import { channelLineupService } from '#lib/server/livetv/lineup/ChannelLineupService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTvLineupBackupById', logDomain: 'livetv' });

/**
 * Remove a backup link
 */
export const DELETE: RequestHandler = async ({ params }) => {
	const { id, backupId } = params;

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

		const success = await channelLineupService.removeBackup(backupId);

		if (!success) {
			return Response.json(
				{
					success: false,
					error: 'Backup not found'
				},
				{ status: 404 }
			);
		}

		return Response.json({
			success: true
		});
	} catch (error) {
		logger.error('[API] Failed to remove backup', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to remove backup'
			},
			{ status: 500 }
		);
	}
};
