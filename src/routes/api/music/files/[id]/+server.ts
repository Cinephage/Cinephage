import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { isAppError } from '#lib/errors/index.js';
import { musicFileService } from '#lib/server/music/MusicFileService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'MusicFileApi', logDomain: 'scans' });

/** DELETE /api/music/files/[id] — remove one audio file from disk and the DB. */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const removed = await musicFileService.removeFile(event.params.id);
		if (!removed) return Response.json({ error: 'File not found' }, { status: 404 });
		return Response.json({ success: true, ...removed });
	} catch (error) {
		if (isAppError(error)) {
			return Response.json(
				{ error: error.message, errorCode: error.code },
				{ status: error.statusCode }
			);
		}
		logger.error(
			{ fileId: event.params.id, err: error instanceof Error ? error.message : String(error) },
			'[MusicFile] delete failed'
		);
		return Response.json({ error: 'Could not remove the file' }, { status: 502 });
	}
};
