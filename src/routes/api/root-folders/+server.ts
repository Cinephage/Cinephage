import type { RequestHandler } from './$types';
import { getRootFolderService } from '#lib/server/downloadClients/RootFolderService.js';
import { rootFolderCreateSchema } from '#lib/validation/schemas.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/DownloadMonitorService.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { invalidateRootFolderPathCache } from '#lib/server/filesystem/path-guard.js';

/**
 * GET /api/root-folders
 * List all configured root folders with free space info.
 */
export const GET: RequestHandler = async () => {
	const service = getRootFolderService();
	const folders = await service.getFolders();
	return Response.json(folders);
};

/**
 * POST /api/root-folders
 * Create a new root folder.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	const validated = await parseBody(request, rootFolderCreateSchema);

	const service = getRootFolderService();

	const created = await service.createFolder({
		name: validated.name,
		path: validated.path,
		mediaType: validated.mediaType,
		mediaSubType: validated.mediaSubType,
		isDefault: validated.isDefault,
		readOnly: validated.readOnly,
		preserveSymlinks: validated.preserveSymlinks,
		defaultMonitored: validated.defaultMonitored,
		skipFolderPatterns: validated.skipFolderPatterns,
		blockedVideoExtensions: validated.blockedVideoExtensions
	});

	invalidateRootFolderPathCache();

	if (validated.blockedVideoExtensions && validated.blockedVideoExtensions.length > 0) {
		downloadMonitor.checkBlockedExtensions().catch(() => {});
	}

	libraryMediaEvents.emitLibraryDataChanged({
		source: 'root-folder',
		reason: 'root-folder-created',
		entityId: created.folder.id
	});

	return Response.json({ success: true, folder: created.folder, scanJobId: created.scanJobId });
};
