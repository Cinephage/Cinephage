/**
 * GET /api/notifications/mediabrowser/:id - Get a specific server
 * PUT /api/notifications/mediabrowser/:id - Update a server
 * DELETE /api/notifications/mediabrowser/:id - Delete a server
 */

import type { RequestHandler } from './$types';
import { getMediaBrowserManager } from '#lib/server/notifications/mediabrowser/index.js';
import { mediaBrowserServerUpdateSchema } from '#lib/validation/schemas.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

/**
 * GET /api/notifications/mediabrowser/:id
 * Get a specific MediaBrowser server by ID.
 */
export const GET: RequestHandler = async ({ params }) => {
	const manager = getMediaBrowserManager();
	const server = await manager.getServer(params.id);

	if (!server) {
		return Response.json({ error: 'Server not found' }, { status: 404 });
	}

	return Response.json(server);
};

/**
 * PUT /api/notifications/mediabrowser/:id
 * Update an existing MediaBrowser server.
 */
export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params, request } = event;
	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const result = mediaBrowserServerUpdateSchema.safeParse(data);

	if (!result.success) {
		return Response.json(
			{
				error: 'Validation failed',
				details: result.error.flatten()
			},
			{ status: 400 }
		);
	}

	const manager = getMediaBrowserManager();
	const existing = await manager.getServerRecord(params.id);

	if (!existing) {
		return Response.json({ error: 'Server not found' }, { status: 404 });
	}

	const effectiveEnabled = result.data.enabled ?? existing.enabled ?? true;
	let testResult: Awaited<ReturnType<typeof manager.testServerConfig>> | null = null;

	if (effectiveEnabled) {
		const host = result.data.host ?? existing.host;
		const apiKey = result.data.apiKey ?? existing.apiKey;
		const serverType = (result.data.serverType ?? existing.serverType) as
			'jellyfin' | 'emby' | 'plex';

		testResult = await manager.testServerConfig({
			host,
			apiKey,
			serverType
		});

		if (!testResult.success) {
			return Response.json(
				{
					error: testResult.error
						? `Connection test failed: ${testResult.error}`
						: 'Connection test failed'
				},
				{ status: 400 }
			);
		}
	}

	const updated = await manager.updateServer(params.id, result.data);

	if (!updated) {
		return Response.json({ error: 'Server not found' }, { status: 404 });
	}

	if (testResult) await manager.recordTestResult(params.id, testResult);

	return Response.json({ success: true, server: updated });
};

/**
 * DELETE /api/notifications/mediabrowser/:id
 * Delete a MediaBrowser server.
 */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params } = event;
	const manager = getMediaBrowserManager();
	const deleted = await manager.deleteServer(params.id);

	if (!deleted) {
		return Response.json({ error: 'Server not found' }, { status: 404 });
	}

	return Response.json({ success: true });
};
