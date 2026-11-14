/**
 * POST /api/monitoring/search-activity/global-pause
 *
 * Sets or clears the global "pause all automatic search" switch, independent
 * of per-item pause. Unlike per-item pause, this blocks every
 * MonitoringSearchService entry point, including a manual "Run Now" on the
 * whole task - see global-search-pause.ts for why. Called from the Searches
 * tab's toolbar.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { activityService } from '#lib/server/activity/ActivityService.js';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({
	module: 'SearchActivityGlobalPauseApi',
	logDomain: 'monitoring'
});

const globalPauseSchema = z.object({
	paused: z.boolean()
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

	const parsed = globalPauseSchema.safeParse(body);
	if (!parsed.success) {
		return json(
			{ success: false, error: 'Validation failed', details: parsed.error.flatten() },
			{ status: 400 }
		);
	}

	try {
		await activityService.setGlobalAutoSearchPaused(parsed.data.paused);
		return json({ success: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ error: message }, 'Failed to set global auto-search pause');
		return json({ success: false, error: message }, { status: 500 });
	}
};
