import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { isAppError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { musicArtistService } from '#lib/server/music/MusicArtistService.js';

const logger = createChildLogger({ module: 'MusicArtistRefreshApi', logDomain: 'system' });

/** POST /api/music/artists/[id]/refresh — re-read the artist from MusicBrainz. */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const artist = await musicArtistService.refreshArtist(event.params.id);
		return Response.json({ success: true, artist });
	} catch (error) {
		if (isAppError(error)) {
			return Response.json(
				{ error: error.message, errorCode: error.code },
				{ status: error.statusCode }
			);
		}
		logger.error(
			{ artistId: event.params.id, err: error instanceof Error ? error.message : String(error) },
			'[MusicArtist] refresh failed'
		);
		return Response.json({ error: 'Could not refresh the artist' }, { status: 502 });
	}
};
