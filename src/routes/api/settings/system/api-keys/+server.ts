import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import {
	ensureDefaultApiKeysForUser,
	getManagedApiKeysForRequest
} from '#lib/server/auth/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'ApiKeysApi', logDomain: 'auth' });

// POST /api/settings/system/api-keys - Auto-generate Main and Media Streaming API keys
export const POST: RequestHandler = async (event) => {
	// Require admin authentication
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request, locals } = event;

	// After requireAdmin check, user is guaranteed to exist
	const user = locals.user!;

	try {
		const results = await ensureDefaultApiKeysForUser(user.id, request.headers);

		return Response.json({
			success: true,
			data: results
		});
	} catch (error) {
		logger.error({ err: error, component: 'SystemApiKeysApi' }, 'Error creating API keys');
		return Response.json({ error: 'Failed to create API keys' }, { status: 500 });
	}
};

// GET /api/settings/system/api-keys - List user's API keys
export const GET: RequestHandler = async (event) => {
	// Require admin authentication
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;

	try {
		const apiKeysResult = await getManagedApiKeysForRequest(request.headers);

		return Response.json({
			success: true,
			data: [apiKeysResult.mainApiKey, apiKeysResult.streamingApiKey].filter(Boolean)
		});
	} catch (error) {
		logger.error({ err: error, component: 'SystemApiKeysApi' }, 'Error listing API keys');
		return Response.json({ error: 'Failed to list API keys' }, { status: 500 });
	}
};
