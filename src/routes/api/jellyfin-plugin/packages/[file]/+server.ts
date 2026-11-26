/**
 * GET /api/jellyfin-plugin/packages/[file]
 *
 * Serves the plugin zip named by the repository manifest. Public for the same
 * reason as the manifest: Jellyfin downloads it server-to-server.
 */
import type { RequestHandler } from './$types';
import { readPluginPackage } from '#lib/server/jellyfinPlugin/manifest.js';

export const GET: RequestHandler = async ({ params }) => {
	const body = await readPluginPackage(params.file);
	if (!body) {
		return new Response('Not found', { status: 404 });
	}

	return new Response(new Uint8Array(body), {
		headers: {
			'Content-Type': 'application/zip',
			'Content-Length': String(body.byteLength),
			'Content-Disposition': `attachment; filename="${params.file}"`,
			'Cache-Control': 'public, max-age=31536000, immutable'
		}
	});
};
