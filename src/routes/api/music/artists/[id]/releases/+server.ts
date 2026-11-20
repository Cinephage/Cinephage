import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';
import { musicSearchService } from '#lib/server/music/MusicSearchService.js';
import { isAppError } from '#lib/errors/index.js';

const logger = createChildLogger({ module: 'MusicArtistReleasesApi', logDomain: 'system' });

/**
 * POST /api/music/artists/[id]/releases
 *
 * Interactive release search across a discography — the multi-season search of
 * music. Every hit is filed under the album it names; grabbing one goes through
 * that album's grab route.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	try {
		const result = await musicSearchService.searchForArtist(event.params.id);
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
			'[MusicSearch] artist release search failed'
		);
		return Response.json(
			{
				error: 'Could not search for releases',
				details: error instanceof Error ? error.message : String(error)
			},
			{ status: 502 }
		);
	}
};
