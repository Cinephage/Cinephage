import type { RequestHandler } from './$types';
import { getRootFolderService } from '#lib/server/downloadClients/RootFolderService.js';
import { rootFolderUpdateSchema } from '#lib/validation/schemas.js';
import { assertFound, parseBody } from '#lib/server/api/validate.js';
import { NotFoundError, isAppError } from '#lib/errors/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/DownloadMonitorService.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { invalidateRootFolderPathCache } from '#lib/server/filesystem/path-guard.js';

/**
 * GET /api/root-folders/[id]
 * Get a single root folder with current free space.
 */
export const GET: RequestHandler = async ({ params }) => {
	const service = getRootFolderService();
	const folder = await service.getFolder(params.id);

	return Response.json(assertFound(folder, 'Root folder', params.id));
};

/**
 * PUT /api/root-folders/[id]
 * Update a root folder.
 */
export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params, request } = event;
	const data = await parseBody(request, rootFolderUpdateSchema);
	const service = getRootFolderService();

	try {
		const result = await service.updateFolder(params.id, data);
		invalidateRootFolderPathCache();
		if (data.blockedVideoExtensions !== undefined) {
			downloadMonitor.checkBlockedExtensions().catch(() => {});
		}
		libraryMediaEvents.emitLibraryDataChanged({
			source: 'root-folder',
			reason: 'root-folder-updated',
			entityId: params.id
		});
		return Response.json({ success: true, ...result });
	} catch (error) {
		if (isAppError(error)) {
			return Response.json(error.toJSON(), { status: error.statusCode });
		}
		if (error instanceof Error && error.message.includes('not found')) {
			throw new NotFoundError('Root folder', params.id);
		}
		throw error;
	}
};

/**
 * DELETE /api/root-folders/[id]
 * Delete a root folder.
 */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params } = event;
	const service = getRootFolderService();

	try {
		const result = await service.deleteFolder(params.id);
		invalidateRootFolderPathCache();
		libraryMediaEvents.emitLibraryDataChanged({
			source: 'root-folder',
			reason: 'root-folder-deleted',
			entityId: params.id
		});
		return Response.json({ success: true, ...result });
	} catch (error) {
		if (error instanceof Error && error.message.includes('not found')) {
			throw new NotFoundError('Root folder', params.id);
		}
		throw error;
	}
};
