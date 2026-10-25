import type { RequestHandler } from './$types';
import { createChildLogger } from '#lib/logging/index.js';
import { regenerateRecoverableApiKey } from '#lib/server/auth/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'ApiKeysRegenerateApi', logDomain: 'auth' });

// POST /api/settings/system/api-keys/[id]/regenerate - Regenerate an API key
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params, request, locals } = event;
	// Require authentication
	if (!locals.user) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const { id } = params;
	if (!id) {
		return Response.json({ error: 'API key ID is required' }, { status: 400 });
	}

	try {
		const newKey = await regenerateRecoverableApiKey({
			keyId: id,
			userId: locals.user.id,
			headers: request.headers
		});

		if (!newKey) {
			return Response.json({ error: 'API key not found' }, { status: 404 });
		}

		return Response.json({
			success: true,
			data: {
				id: newKey.id,
				key: newKey.key,
				name: newKey.name,
				metadata: newKey.metadata
			}
		});
	} catch (error) {
		logger.error(
			{ err: error, component: 'ApiKeyRegenerateApi', keyId: id },
			'Error regenerating API key'
		);
		return Response.json({ error: 'Failed to regenerate API key' }, { status: 500 });
	}
};
