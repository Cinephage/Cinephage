import type { RequestHandler } from './$types';
import {
	activityService,
	activityStreamEvents,
	DEFAULT_ACTIVITY_RETENTION_DAYS,
	MAX_ACTIVITY_RETENTION_DAYS
} from '#lib/server/activity/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';
import { z } from 'zod';

const logger = createChildLogger({ module: 'ActivitySettingsApi', logDomain: 'monitoring' });

const updateRetentionSchema = z.object({
	retentionDays: z.coerce.number().int().min(1).max(MAX_ACTIVITY_RETENTION_DAYS)
});

const purgeSchema = z.object({
	action: z.enum(['older_than_retention', 'all']),
	removeFromClient: z.boolean().optional().default(false)
});

/**
 * GET - Get activity history retention settings.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const retentionDays = await activityService.getRetentionDays();
		return Response.json({
			success: true,
			retentionDays,
			defaultRetentionDays: DEFAULT_ACTIVITY_RETENTION_DAYS,
			maxRetentionDays: MAX_ACTIVITY_RETENTION_DAYS
		});
	} catch (error) {
		logger.error('Failed to load activity retention settings', error);
		return Response.json(
			{ success: false, error: 'Failed to load activity settings' },
			{ status: 500 }
		);
	}
};

/**
 * PUT - Update activity history retention (max 90 days).
 */
export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = updateRetentionSchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{
				success: false,
				error: 'Validation failed',
				details: parsed.error.flatten()
			},
			{ status: 400 }
		);
	}

	try {
		const retentionDays = await activityService.setRetentionDays(parsed.data.retentionDays);
		return Response.json({ success: true, retentionDays });
	} catch (error) {
		logger.error('Failed to update activity retention settings', error);
		return Response.json(
			{ success: false, error: 'Failed to update activity settings' },
			{ status: 500 }
		);
	}
};

/**
 * POST - Purge history rows (older than retention, or all).
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = purgeSchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{
				success: false,
				error: 'Validation failed',
				details: parsed.error.flatten()
			},
			{ status: 400 }
		);
	}

	try {
		const { action, removeFromClient } = parsed.data;

		if (action === 'all') {
			const result = await activityService.purgeAllHistory({ removeFromClient });
			activityStreamEvents.emitRefresh({
				action: 'purge_all',
				timestamp: new Date().toISOString()
			});
			return Response.json({
				success: true,
				action: 'all',
				...result
			});
		}

		const retentionDays = await activityService.getRetentionDays();
		const result = await activityService.purgeHistoryOlderThan(retentionDays, { removeFromClient });
		activityStreamEvents.emitRefresh({
			action: 'purge_older_than_retention',
			timestamp: new Date().toISOString()
		});
		return Response.json({
			success: true,
			action: 'older_than_retention',
			retentionDays,
			...result
		});
	} catch (error) {
		logger.error('Failed to purge activity history', error);
		const message =
			error instanceof Error && error.message.includes('SQLITE_BUSY')
				? 'Activity entries are busy right now. Please retry in a moment.'
				: 'Failed to purge activity entries';
		return Response.json({ success: false, error: message }, { status: 500 });
	}
};
