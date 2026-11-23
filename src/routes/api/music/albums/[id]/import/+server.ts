import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { isPathAllowed } from '#lib/server/filesystem/path-guard.js';
import { createChildLogger } from '#lib/logging/index.js';
import { isAppError } from '#lib/errors/index.js';
import { musicImportService } from '#lib/server/music/MusicImportService.js';

const logger = createChildLogger({ module: 'MusicAlbumImportApi', logDomain: 'system' });

/**
 * POST /api/music/albums/[id]/import
 *
 * Imports an album folder into the library. With no body it imports the album's
 * most recent queued download; with `{ path }` it imports that folder, which is
 * how an existing collection gets in without a download.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = (await event.request.json().catch(() => ({}))) as {
		path?: unknown;
		dryRun?: unknown;
	};
	if (body.path !== undefined && typeof body.path !== 'string') {
		return Response.json({ error: 'path must be a string' }, { status: 400 });
	}
	if (typeof body.path === 'string' && !(await isPathAllowed(body.path))) {
		return Response.json({ error: 'That path is not an allowed media source' }, { status: 400 });
	}

	try {
		const result =
			typeof body.path === 'string'
				? await musicImportService.importFolder(event.params.id, body.path, {
						dryRun: body.dryRun === true
					})
				: await musicImportService.importFromQueueForAlbum(event.params.id, {
						dryRun: body.dryRun === true
					});
		return Response.json({ success: true, ...result }, { status: 201 });
	} catch (error) {
		if (isAppError(error)) {
			return Response.json(
				{ error: error.message, errorCode: error.code },
				{ status: error.statusCode }
			);
		}
		logger.error(
			{ albumId: event.params.id, err: error instanceof Error ? error.message : String(error) },
			'[MusicImport] import failed'
		);
		return Response.json(
			{
				error: 'Could not import the album',
				details: error instanceof Error ? error.message : String(error)
			},
			{ status: 500 }
		);
	}
};
