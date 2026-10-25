import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { getConfigurationBackupService } from '#lib/server/settings/ConfigurationBackupService.js';
import { backupExportSchema, backupImportSchema } from '#lib/validation/schemas.js';

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { passphrase, includeIndexerCookies } = await parseBody(event.request, backupExportSchema);
	const service = getConfigurationBackupService();
	const backup = await service.exportConfig(passphrase, { includeIndexerCookies });
	const timestamp = backup.createdAt.replace(/[:.]/g, '-');

	return Response.json({
		success: true,
		fileName: `cinephage-config-backup-${timestamp}.json`,
		backup
	});
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { passphrase, sections, mode, backup } = await parseBody(event.request, backupImportSchema);
	const service = getConfigurationBackupService();
	const result = await service.restoreConfig(backup, { passphrase, sections, mode });

	return Response.json({
		success: true,
		message: 'Configuration restored successfully',
		result
	});
};
