import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { fileManagementSchema } from '#lib/validation/schemas.js';
import { parseBody } from '#lib/server/api/validate.js';
import {
	getFileManagementSettings,
	setFileManagementSettings,
	invalidateFileManagementCache
} from '#lib/server/settings/file-management.js';
import { getRootFolderService } from '#lib/server/downloadClients/RootFolderService.js';

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const data = await getFileManagementSettings();
	return Response.json({ success: true, ...data });
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const result = await parseBody(event.request, fileManagementSchema);
	const current = await getFileManagementSettings();

	// Never trust the client-sent autoEnabledPreserveSymlinkFolderIds; always derive server-side
	let autoEnabledIds = current.autoEnabledPreserveSymlinkFolderIds;
	let autoEnabledCount = 0;
	let autoRevertedCount = 0;

	const rootFolderService = getRootFolderService();

	if (result.importMode === 'symlink' && current.importMode !== 'symlink') {
		// Switching TO symlink mode: enable preserveSymlinks on any folder that doesn't have it
		const folders = await rootFolderService.getFolders();
		const toEnable = folders.filter((f) => !f.preserveSymlinks);
		for (const folder of toEnable) {
			await rootFolderService.updateFolder(folder.id, { preserveSymlinks: true });
		}
		autoEnabledIds = toEnable.map((f) => f.id);
		autoEnabledCount = toEnable.length;
	} else if (result.importMode !== 'symlink' && current.importMode === 'symlink') {
		// Switching FROM symlink mode: revert only the folders we auto-enabled
		for (const id of current.autoEnabledPreserveSymlinkFolderIds) {
			try {
				await rootFolderService.updateFolder(id, { preserveSymlinks: false });
				autoRevertedCount++;
			} catch {
				// folder may have been deleted since we enabled it
			}
		}
		autoEnabledIds = [];
	}

	const settingsToSave = { ...result, autoEnabledPreserveSymlinkFolderIds: autoEnabledIds };
	await setFileManagementSettings(settingsToSave);
	invalidateFileManagementCache();

	return Response.json({ success: true, ...settingsToSave, autoEnabledCount, autoRevertedCount });
};
