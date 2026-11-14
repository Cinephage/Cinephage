/**
 * GET /api/monitoring/search-activity/item
 *
 * Detail payload for the Searches tab's per-item expand panel: media/
 * quality-profile info, attempts vs. the failure cap, first/last/next
 * attempt timestamps, the paused flag, and a short recent-attempts timeline.
 * Fetched lazily on expand, not part of the paginated list.
 *
 * Query params: movieId? | episodeId? (exactly one required).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { activityService } from '#lib/server/activity/ActivityService.js';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SearchActivityItemApi', logDomain: 'monitoring' });

export const GET: RequestHandler = async ({ url, locals }) => {
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	const movieId = url.searchParams.get('movieId') ?? undefined;
	const episodeId = url.searchParams.get('episodeId') ?? undefined;

	if (!movieId && !episodeId) {
		return json({ success: false, error: 'movieId or episodeId is required' }, { status: 400 });
	}

	try {
		const detail = await activityService.fetchSearchItemDetail({ movieId, episodeId });
		if (!detail) {
			return json({ success: false, error: 'Not found' }, { status: 404 });
		}
		return json({ success: true, item: detail });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ error: message }, 'Search activity item detail fetch failed');
		return json({ success: false, error: message }, { status: 500 });
	}
};
