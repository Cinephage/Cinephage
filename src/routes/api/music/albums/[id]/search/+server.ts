import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';
import { musicSearchService } from '#lib/server/music/MusicSearchService.js';
import { isAppError } from '#lib/errors/index.js';

const logger = createChildLogger({ module: 'MusicAlbumSearchApi', logDomain: 'system' });

/**
 * POST /api/music/albums/[id]/search
 *
 * Interactive release search for one stored album — the music counterpart of the
 * movie/TV search. Returns ranked candidates; it does not grab (a music grab has
 * no download-monitor seam yet).
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	try {
		const result = await musicSearchService.searchForAlbum(event.params.id);
		return Response.json({ success: true, ...result });
	} catch (error) {
		if (isAppError(error)) {
			return Response.json(
				{ error: error.message, errorCode: error.code },
				{ status: error.statusCode }
			);
		}
		logger.error(
			{ albumId: event.params.id, err: error instanceof Error ? error.message : String(error) },
			'[MusicSearch] album search failed'
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
