/**
 * Self-service per-account preferences.
 *
 * GET /api/user/preferences/[key] — the caller's parsed value (defaults when unset)
 * PUT /api/user/preferences/[key] — validate and save for the caller
 *
 * Auth: any authenticated user; rows are hard-scoped to locals.user.id and
 * keys are restricted to the server-side registry (no arbitrary keys).
 */

import type { RequestHandler } from './$types.js';
import { parseBody } from '#lib/server/api/validate.js';
import {
	getUserPreference,
	isPreferenceKey,
	setUserPreference
} from '#lib/server/preferences/user-preferences.js';
import { z } from 'zod';

const putSchema = z.object({ value: z.unknown() });

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}
	if (!isPreferenceKey(params.key)) {
		return Response.json({ success: false, error: 'Unknown preference key' }, { status: 404 });
	}

	const value = await getUserPreference(locals.user.id, params.key);
	return Response.json({ success: true, value });
};

export const PUT: RequestHandler = async ({ request, locals, params }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}
	if (!isPreferenceKey(params.key)) {
		return Response.json({ success: false, error: 'Unknown preference key' }, { status: 404 });
	}

	const body = await parseBody(request, putSchema);
	try {
		// The service validates the value against the registry schema and
		// throws; its typed signature is narrower than this passthrough.
		await setUserPreference(locals.user.id, params.key, body.value as never);
	} catch {
		return Response.json({ success: false, error: 'Invalid preference value' }, { status: 400 });
	}

	const value = await getUserPreference(locals.user.id, params.key);
	return Response.json({ success: true, value });
};
