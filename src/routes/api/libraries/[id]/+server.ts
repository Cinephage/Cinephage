import type { RequestHandler } from './$types.js';
import { requireAdmin, requireAuth } from '#lib/server/auth/authorization.js';
import { parseBody, parseOptionalBody } from '#lib/server/api/validate.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { libraryUpdateSchema, libraryDeleteSchema } from '#lib/validation/schemas.js';
import { NotFoundError, isAppError } from '#lib/errors/index.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';

export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const service = getLibraryEntityService();
	const library = await service.getLibrary(event.params.id);
	if (!library) {
		throw new NotFoundError('Library', event.params.id);
	}

	return Response.json({ success: true, library });
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const updates = await parseBody(event.request, libraryUpdateSchema);
		const service = getLibraryEntityService();
		const library = await service.updateLibrary(event.params.id, updates);
		libraryMediaEvents.emitLibraryDataChanged({
			source: 'library',
			reason: 'library-updated',
			entityId: event.params.id
		});
		return Response.json({ success: true, library });
	} catch (error) {
		if (isAppError(error)) {
			return Response.json(error.toJSON(), { status: error.statusCode });
		}
		throw error;
	}
};

export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const payload = await parseOptionalBody(event.request, libraryDeleteSchema);
		const service = getLibraryEntityService();
		await service.deleteLibrary(event.params.id, payload.targetLibraryId ?? null);
		libraryMediaEvents.emitLibraryDataChanged({
			source: 'library',
			reason: 'library-deleted',
			entityId: event.params.id
		});
		return Response.json({ success: true });
	} catch (error) {
		if (isAppError(error)) {
			return Response.json(error.toJSON(), { status: error.statusCode });
		}
		throw error;
	}
};
