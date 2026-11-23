import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { isAppError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';

const logger = createChildLogger({ module: 'MusicAlbumRematchApi', logDomain: 'system' });

/** POST /api/music/albums/[id]/rematch — point the album at another release group. */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = (await event.request.json().catch(() => null)) as { mbid?: unknown } | null;
	if (!body || typeof body.mbid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.mbid)) {
		return Response.json({ error: 'A MusicBrainz release-group id is required' }, { status: 400 });
	}

	try {
		const album = await musicAlbumService.rematchAlbum(event.params.id, body.mbid);
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
			'[MusicAlbum] re-match failed'
		);
		return Response.json({ error: 'Could not change the album match' }, { status: 502 });
	}
};
