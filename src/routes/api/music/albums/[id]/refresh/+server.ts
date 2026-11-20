import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { isAppError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';

const logger = createChildLogger({ module: 'MusicAlbumRefreshApi', logDomain: 'system' });

/** POST /api/music/albums/[id]/refresh — re-read the release group and edition. */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const album = await musicAlbumService.refreshAlbum(event.params.id);
		return Response.json({ success: true, album });
	} catch (error) {
		if (isAppError(error)) {
			return Response.json(
				{ error: error.message, errorCode: error.code },
				{ status: error.statusCode }
			);
		}
		logger.error(
			{ albumId: event.params.id, err: error instanceof Error ? error.message : String(error) },
			'[MusicAlbum] refresh failed'
		);
		return Response.json({ error: 'Could not refresh the album' }, { status: 502 });
	}
};
