import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { isAppError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { musicArtistService } from '#lib/server/music/MusicArtistService.js';

const logger = createChildLogger({ module: 'MusicArtistRematchApi', logDomain: 'system' });

/** POST /api/music/artists/[id]/rematch — point the artist at another MusicBrainz id. */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = (await event.request.json().catch(() => null)) as { mbid?: unknown } | null;
	if (
		!body ||
		typeof body.mbid !== 'string' ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.mbid)
	) {
		return Response.json({ error: 'A MusicBrainz artist id is required' }, { status: 400 });
	}

	try {
		const result = await musicArtistService.rematchArtist(event.params.id, body.mbid);
		return Response.json({ success: true, ...result });
	} catch (error) {
		if (isAppError(error)) {
			return Response.json(
				{ error: error.message, errorCode: error.code },
				{ status: error.statusCode }
			);
		}
		logger.error(
			{ artistId: event.params.id, err: error instanceof Error ? error.message : String(error) },
			'[MusicArtist] re-match failed'
		);
		return Response.json({ error: 'Could not change the artist match' }, { status: 502 });
	}
};
