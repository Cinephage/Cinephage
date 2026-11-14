/**
 * POST /api/monitoring/search-activity/pause
 *
 * Sets or clears the user-initiated auto-search pause (migration 173) for
 * any number of movies/episodes in one call. Independent of `monitored` and
 * the (missing-content-only) failure cap - MonitoringSearchService checks
 * this across every search task type, even on a manual "Run Now" bypass.
 * Called from the Searches tab's per-item detail panel (single-element
 * arrays) and its bulk pause/resume action.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { activityService } from '#lib/server/activity/ActivityService.js';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SearchActivityPauseApi', logDomain: 'monitoring' });

const pauseSchema = z
	.object({
		movieIds: z.array(z.string().min(1)).default([]),
		episodeIds: z.array(z.string().min(1)).default([]),
		paused: z.boolean()
	})
	.refine((data) => data.movieIds.length > 0 || data.episodeIds.length > 0, {
		message: 'At least one movieId or episodeId is required'
	});

export const POST: RequestHandler = async ({ request, locals }) => {
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = pauseSchema.safeParse(body);
	if (!parsed.success) {
		return json(
			{ success: false, error: 'Validation failed', details: parsed.error.flatten() },
			{ status: 400 }
		);
	}

	const { movieIds, episodeIds, paused } = parsed.data;

	try {
		await activityService.setAutoSearchPaused({ movieIds, episodeIds }, paused);
		return json({ success: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ error: message }, 'Failed to set auto-search pause');
		return json({ success: false, error: message }, { status: 500 });
	}
};
