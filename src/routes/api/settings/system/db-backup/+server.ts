import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { dbBackupService } from '#lib/server/db/DbBackupService.js';

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const [dbSettings, scheduledBackups, preUpdateBackups] = await Promise.all([
		dbBackupService.getSettings(),
		dbBackupService.listScheduledBackups(),
		dbBackupService.listPreUpdateBackups()
	]);

	return Response.json({ success: true, settings: dbSettings, scheduledBackups, preUpdateBackups });
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json();
	const patch: Record<string, unknown> = {};

	if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
	if (typeof body.directory === 'string') patch.directory = body.directory;
	if (typeof body.retentionCount === 'number' && body.retentionCount >= 1)
		patch.retentionCount = Math.floor(body.retentionCount);

	await dbBackupService.updateSettings(patch);
	const updated = await dbBackupService.getSettings();
	return Response.json({ success: true, settings: updated });
};
