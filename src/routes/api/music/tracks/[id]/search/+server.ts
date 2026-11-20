import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';
import { musicSearchService } from '#lib/server/music/MusicSearchService.js';
import { isAppError } from '#lib/errors/index.js';

const logger = createChildLogger({ module: 'MusicTrackSearchApi', logDomain: 'system' });

/**
 * POST /api/music/tracks/[id]/search
 *
 * Interactive release search for one track — the per-episode search of music.
 * Returns ranked candidates; grabbing one goes through the album's grab route
 * because a release is still fetched against the album's media item.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	try {
		const result = await musicSearchService.searchForTrack(event.params.id);
		return Response.json({ success: true, ...result });
	} catch (error) {
		if (isAppError(error)) {
			return Response.json(
				{ error: error.message, errorCode: error.code },
				{ status: error.statusCode }
			);
		}
		logger.error(
			{ trackId: event.params.id, err: error instanceof Error ? error.message : String(error) },
			'[MusicSearch] track search failed'
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
