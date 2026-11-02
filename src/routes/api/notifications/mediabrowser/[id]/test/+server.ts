/**
 * POST /api/notifications/mediabrowser/:id/test - Test a saved server's connection
 */

import type { RequestHandler } from './$types';
import { getMediaBrowserManager } from '#lib/server/notifications/mediabrowser/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { z } from 'zod/v4';
import { mediaBrowserServerTestSchema } from '#lib/validation/schemas.js';

/**
 * POST /api/notifications/mediabrowser/:id/test
 * Test connection for an existing MediaBrowser server.
 * Accepts optional JSON overrides (host/apiKey/serverType).
 * Persists health status by default unless `persist: false` is provided.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params, request } = event;
	const manager = getMediaBrowserManager();

	const testWithIdSchema = mediaBrowserServerTestSchema.partial().extend({
		persist: z.boolean().optional().default(true)
	});

	const text = await request.text();
	const rawBody = text.trim() ? JSON.parse(text) : {};
	const parsed = testWithIdSchema.safeParse(rawBody);
	if (!parsed.success) {
		return Response.json(
			{ success: false, error: parsed.error.issues[0].message },
			{ status: 400 }
		);
	}
	const body = parsed.data;

	try {
		const testResult = await manager.testServer(params.id, body);
		return Response.json(testResult);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return Response.json({ success: false, error: message });
	}
};
