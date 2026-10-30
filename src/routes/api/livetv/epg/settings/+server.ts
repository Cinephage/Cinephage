/**
 * EPG Settings API
 *
 * GET /api/livetv/epg/settings - Current EPG scheduler settings
 * PUT /api/livetv/epg/settings - Update sync interval and retention
 *
 * Changes take effect on the scheduler's next evaluation — no restart.
 */

import type { RequestHandler } from './$types';
import { getEpgScheduler } from '#lib/server/livetv/epg/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { z } from 'zod';
import { ValidationError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTvEpgSettings', logDomain: 'livetv' });

const epgSettingsUpdateSchema = z
	.object({
		syncIntervalHours: z.number().int().min(1).max(168).optional(),
		retentionHours: z.number().int().min(24).max(720).optional()
	})
	.refine((data) => data.syncIntervalHours !== undefined || data.retentionHours !== undefined, {
		message: 'At least one of syncIntervalHours or retentionHours is required'
	});

export const GET: RequestHandler = async () => {
	const scheduler = getEpgScheduler();
	const status = scheduler.getStatus();

	return Response.json({
		success: true,
		syncIntervalHours: status.syncIntervalHours,
		retentionHours: status.retentionHours,
		lastSyncAt: status.lastSyncAt,
		nextSyncAt: status.nextSyncAt
	});
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		throw new ValidationError('Invalid JSON body');
	}

	const parsed = epgSettingsUpdateSchema.safeParse(body);
	if (!parsed.success) {
		throw new ValidationError('Validation failed', {
			details: parsed.error.flatten()
		});
	}

	const scheduler = getEpgScheduler();

	try {
		if (parsed.data.syncIntervalHours !== undefined) {
			scheduler.setSyncIntervalHours(parsed.data.syncIntervalHours);
		}
		if (parsed.data.retentionHours !== undefined) {
			scheduler.setRetentionHours(parsed.data.retentionHours);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Invalid settings';
		logger.warn({ error: message }, '[API] Rejected EPG settings update');
		throw new ValidationError(message);
	}

	const status = scheduler.getStatus();
	logger.info(
		{
			syncIntervalHours: status.syncIntervalHours,
			retentionHours: status.retentionHours
		},
		'[API] EPG settings updated'
	);

	return Response.json({
		success: true,
		syncIntervalHours: status.syncIntervalHours,
		retentionHours: status.retentionHours,
		lastSyncAt: status.lastSyncAt,
		nextSyncAt: status.nextSyncAt
	});
};
