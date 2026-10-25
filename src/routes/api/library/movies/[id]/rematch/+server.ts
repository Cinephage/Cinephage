/**
 * Change Match API (movie)
 *
 * POST /api/library/movies/[id]/rematch
 * Swaps an already-added movie's TMDB match in place: re-fetches metadata
 * and renames the folder/file to match. See MediaMatcherService.rematchMovie.
 */

import type { RequestHandler } from './$types.js';
import { mediaMatcherService } from '#lib/server/library/media-matcher.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { logger } from '#lib/logging/index.js';

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = await request.json();
		const tmdbId = Number(body?.tmdbId);

		if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
			return Response.json(
				{ success: false, error: 'A valid tmdbId is required' },
				{ status: 400 }
			);
		}

		const result = await mediaMatcherService.rematchMovie(params.id, tmdbId);

		libraryMediaEvents.emitMovieUpdated(params.id);

		return Response.json({ success: true, ...result });
	} catch (err) {
		logger.error('[API] Error rematching movie', err instanceof Error ? err : undefined);
		const message = err instanceof Error ? err.message : 'Failed to rematch movie';
		const status = message.includes('not found') ? 404 : 400;
		return Response.json({ success: false, error: message }, { status });
	}
};
