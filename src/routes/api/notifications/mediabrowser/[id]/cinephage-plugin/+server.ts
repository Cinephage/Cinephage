/**
 * GET  /api/notifications/mediabrowser/:id/cinephage-plugin - plugin status
 * POST /api/notifications/mediabrowser/:id/cinephage-plugin - install + restart
 *
 * The Cinephage Jellyfin plugin exists so Jellyfin can play the shortcuts
 * Cinephage writes (audio .strm). Installing it is a server-side action:
 * the browser never talks to Jellyfin directly.
 */
import type { RequestHandler } from './$types';
import { getMediaBrowserManager } from '#lib/server/notifications/mediabrowser/index.js';
import type { MediaBrowserServerRecord } from '#lib/server/notifications/mediabrowser/types.js';
import {
	CinephagePluginError,
	createJellyfinClient,
	getCinephagePluginStatus,
	installCinephagePlugin,
	restartMediaServer
} from '#lib/server/notifications/mediabrowser/cinephagePlugin.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

/**
 * The repository URL must be reachable from the Jellyfin server, not just from
 * the browser. Prefer the configured ORIGIN (the address Cinephage publishes to
 * services on the network); fall back to the origin the page came from.
 */
function pluginRepositoryOrigin(requestOrigin: string): string {
	const configured = process.env.ORIGIN?.replace(/\/+$/, '');
	if (configured) return configured;
	return requestOrigin;
}

async function readServer(
	id: string
): Promise<{ record: MediaBrowserServerRecord } | { error: Response }> {
	const record = await getMediaBrowserManager().getServerRecord(id);
	if (!record) {
		return { error: Response.json({ error: 'Server not found' }, { status: 404 }) };
	}
	return { record };
}

function pluginErrorResponse(error: unknown): Response {
	if (error instanceof CinephagePluginError) {
		return Response.json({ error: error.message }, { status: error.status });
	}

	return Response.json(
		{ error: error instanceof Error ? error.message : 'The plugin operation failed' },
		{ status: 502 }
	);
}

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const result = await readServer(event.params.id);
	if ('error' in result) return result.error;

	try {
		const client = createJellyfinClient(result.record);
		return Response.json(await getCinephagePluginStatus(client));
	} catch (cause) {
		return pluginErrorResponse(cause);
	}
};

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const result = await readServer(event.params.id);
	if ('error' in result) return result.error;

	const body = (await event.request.json().catch(() => ({}))) as { restart?: unknown };

	try {
		const client = createJellyfinClient(result.record);
		const repositoryUrl = `${pluginRepositoryOrigin(event.url.origin)}/api/jellyfin-plugin/manifest.json`;
		const status = await installCinephagePlugin(client, repositoryUrl);

		// Jellyfin activates an installed plugin on its next start. The restart
		// is opt-in from the caller because it interrupts playback.
		if (body.restart === true && status.status === 'Restart') {
			await restartMediaServer(client);
		}

		return Response.json({ success: true, status });
	} catch (cause) {
		return pluginErrorResponse(cause);
	}
};
