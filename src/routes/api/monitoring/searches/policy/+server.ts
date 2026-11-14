import type { RequestHandler } from './$types';
import { z } from 'zod';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';
import {
	SEARCH_POLICY_DEFAULTS,
	getSearchPolicy,
	updateSearchPolicy
} from '#lib/server/monitoring/search/search-state.js';
import { resetSearchGatePolicyCache } from '#lib/server/monitoring/specifications/SearchGateSpecification.js';

const logger = createChildLogger({ module: 'MonitoringSearchesApi', logDomain: 'monitoring' });

/**
 * Every bound is enforced here rather than clamped silently: a zero attempt cap
 * would disable automatic search entirely, and a zero delay would restore the
 * unbounded loop this feature exists to stop.
 */
const policySchema = z
	.object({
		maxAttempts: z.number().int().min(1).max(100),
		minDelayHours: z.number().min(0.25).max(168),
		backoffMultiplier: z.number().min(1).max(10),
		maxDelayHours: z.number().min(1).max(720),
		paused: z.boolean(),
		newEpisodeMaxAttempts: z.number().int().min(1).max(500)
	})
	.partial()
	.refine((value) => Object.keys(value).length > 0, { message: 'No settings supplied' });

/** GET /api/monitoring/searches/policy */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const policy = await getSearchPolicy();
	return Response.json({ success: true, policy, defaults: SEARCH_POLICY_DEFAULTS });
};

/** PUT /api/monitoring/searches/policy */
export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = policySchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{ success: false, error: 'Invalid request body', details: parsed.error.issues },
			{ status: 400 }
		);
	}

	try {
		await updateSearchPolicy(parsed.data);
		// The gate caches the policy for a few seconds per process; drop it so the
		// change takes effect on the next item rather than the next task run.
		resetSearchGatePolicyCache();
		const policy = await getSearchPolicy();
		return Response.json({ success: true, policy });
	} catch (error) {
		logger.error({ err: error }, '[API] Failed to update search policy');
		return Response.json(
			{ success: false, error: 'Failed to update search policy' },
			{ status: 500 }
		);
	}
};
