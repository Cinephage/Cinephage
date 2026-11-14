/**
 * POST /api/monitoring/search-activity/reset-failures
 *
 * Clears the consecutive-failure counter (FailureCapSpecification) for the
 * given movies/episodes, unsticking them from the missing-content search
 * failure cap without waiting for a successful import or re-running the
 * whole task manually. Called from the Searches tab's "Reset Failure Count"
 * bulk action.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { activityService } from '#lib/server/activity/ActivityService.js';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({
	module: 'SearchActivityResetFailuresApi',
	logDomain: 'monitoring'
});

const resetFailuresSchema = z.object({
	movieIds: z.array(z.string().min(1)).max(500).optional().default([]),
	episodeIds: z.array(z.string().min(1)).max(500).optional().default([])
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

	const parsed = resetFailuresSchema.safeParse(body);
	if (!parsed.success) {
		return json(
			{ success: false, error: 'Validation failed', details: parsed.error.flatten() },
			{ status: 400 }
		);
	}

	const { movieIds, episodeIds } = parsed.data;
	if (movieIds.length === 0 && episodeIds.length === 0) {
		return json({ success: false, error: 'No movies or episodes specified' }, { status: 400 });
	}

	try {
		await activityService.resetFailureCounts(movieIds, episodeIds);
		return json({ success: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ error: message }, 'Failed to reset failure counts');
		return json({ success: false, error: message }, { status: 500 });
	}
};
