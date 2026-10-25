/**
 * Change Match API (series)
 *
 * POST /api/library/series/[id]/rematch
 * Swaps an already-added series's TMDB match in place: re-fetches metadata,
 * regenerates seasons/episodes, re-links existing files, and renames the
 * folder/files to match. See MediaMatcherService.rematchSeries.
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

		const result = await mediaMatcherService.rematchSeries(params.id, tmdbId);

		libraryMediaEvents.emitSeriesUpdated(params.id);

		return Response.json({ success: true, ...result });
	} catch (err) {
		logger.error('[API] Error rematching series', err instanceof Error ? err : undefined);
		const message = err instanceof Error ? err.message : 'Failed to rematch series';
		const status = message.includes('not found') ? 404 : 400;
		return Response.json({ success: false, error: message }, { status });
	}
};
