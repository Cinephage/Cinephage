import type { RequestHandler } from './$types';
import { z } from 'zod';
import { createChildLogger } from '#lib/logging/index.js';
import { DEFAULT_CAPTURED_LOG_LEVEL } from '#lib/logging/log-capture.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import {
	DEFAULT_LOG_RETENTION_DAYS,
	MAX_LOG_RETENTION_DAYS,
	logHistoryService
} from '#lib/server/logging/log-history.js';

const logger = createChildLogger({ module: 'LogSettingsApi', logDomain: 'system' });

const updateSettingsSchema = z.object({
	retentionDays: z.coerce.number().int().min(1).max(MAX_LOG_RETENTION_DAYS).optional(),
	minLevel: z.enum(['debug', 'info', 'warn', 'error']).optional()
});

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const [retentionDays, minLevel] = await Promise.all([
			logHistoryService.getRetentionDays(),
			logHistoryService.getMinCaptureLevel()
		]);
		return Response.json({
			success: true,
			retentionDays,
			defaultRetentionDays: DEFAULT_LOG_RETENTION_DAYS,
			maxRetentionDays: MAX_LOG_RETENTION_DAYS,
			minLevel,
			defaultMinLevel: DEFAULT_CAPTURED_LOG_LEVEL
		});
	} catch (error) {
		logger.error({ err: error }, 'Failed to load log settings');
		return Response.json({ success: false, error: 'Failed to load log settings' }, { status: 500 });
	}
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = updateSettingsSchema.safeParse(body);
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
		const [retentionDays, minLevel] = await Promise.all([
			parsed.data.retentionDays !== undefined
				? logHistoryService.setRetentionDays(parsed.data.retentionDays)
				: logHistoryService.getRetentionDays(),
			parsed.data.minLevel !== undefined
				? logHistoryService.setMinCaptureLevel(parsed.data.minLevel)
				: logHistoryService.getMinCaptureLevel()
		]);
		return Response.json({ success: true, retentionDays, minLevel });
	} catch (error) {
		logger.error({ err: error }, 'Failed to update log settings');
		return Response.json(
			{ success: false, error: 'Failed to update log settings' },
			{ status: 500 }
		);
	}
};
