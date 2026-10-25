/**
 * API endpoints for channel lineup backup links
 * GET /api/livetv/lineup/[id]/backups - Get all backups for a lineup item
 * POST /api/livetv/lineup/[id]/backups - Add a backup link
 */

import type { RequestHandler } from './$types';
import { channelLineupService } from '#lib/server/livetv/lineup/ChannelLineupService.js';
import { createChildLogger } from '#lib/logging/index.js';
import { ValidationError } from '#lib/errors/index.js';
import { addBackupLinkSchema } from '#lib/validation/schemas.js';

const logger = createChildLogger({ module: 'LiveTvLineupBackups', logDomain: 'livetv' });

/**
 * Get all backup links for a lineup item
 */
export const GET: RequestHandler = async ({ params }) => {
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

		const backups = await channelLineupService.getBackups(id);
		return Response.json({
			success: true,
			backups
		});
	} catch (error) {
		logger.error('[API] Failed to get backups', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to get backups'
			},
			{ status: 500 }
		);
	}
};

/**
 * Add a backup link to a lineup item
 */
export const POST: RequestHandler = async ({ params, request }) => {
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

		const parsed = addBackupLinkSchema.safeParse(await request.json());
		if (!parsed.success) {
			return Response.json(
				{ success: false, error: parsed.error.issues[0].message },
				{ status: 400 }
			);
		}
		const body = parsed.data;

		// Service handles all validation including primary channel check
		const result = await channelLineupService.addBackup(id, body.accountId, body.channelId);

		if (!result.backup) {
			return Response.json(
				{
					success: false,
					error: result.error || 'Failed to add backup'
				},
				{ status: 400 }
			);
		}

		return Response.json(
			{
				success: true,
				backup: result.backup
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
		logger.error('[API] Failed to add backup', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to add backup'
			},
			{ status: 500 }
		);
	}
};
