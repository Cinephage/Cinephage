/**
 * GET /api/notifications/mediabrowser - List all MediaBrowser servers
 * POST /api/notifications/mediabrowser - Create a new server
 */

import type { RequestHandler } from './$types';
import { getMediaBrowserManager } from '#lib/server/notifications/mediabrowser/index.js';
import { mediaBrowserServerCreateSchema } from '#lib/validation/schemas.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';

/**
 * GET /api/notifications/mediabrowser
 * List all configured media servers (Jellyfin/Emby/Plex).
 */
export const GET: RequestHandler = async () => {
	const manager = getMediaBrowserManager();
	const servers = await manager.getServers();
	return Response.json(servers);
};

/**
 * POST /api/notifications/mediabrowser
 * Create a new MediaBrowser server.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	const result = await parseBody(request, mediaBrowserServerCreateSchema);

	const manager = getMediaBrowserManager();

	const shouldValidateConnection = result.enabled ?? true;
	let testResult: Awaited<ReturnType<typeof manager.testServerConfig>> | null = null;

	if (shouldValidateConnection) {
		testResult = await manager.testServerConfig({
			host: result.host,
			apiKey: result.apiKey,
			serverType: result.serverType
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

	const created = await manager.createServer(result);
	if (testResult) await manager.recordTestResult(created.id, testResult);
	return Response.json({ success: true, server: created });
};
