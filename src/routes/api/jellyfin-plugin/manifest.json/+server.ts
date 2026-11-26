/**
 * GET /api/jellyfin-plugin/manifest.json
 *
 * The plugin repository Jellyfin reads. Public by design: a Jellyfin server
 * fetches it without a Cinephage session, exactly like any community plugin
 * repository. It contains no user data, only the bundled plugin's metadata.
 */
import type { RequestHandler } from './$types';
import { readPluginBuild, toJellyfinManifest } from '#lib/server/jellyfinPlugin/manifest.js';

export const GET: RequestHandler = async ({ url }) => {
	const build = await readPluginBuild();
	if (!build) {
		return Response.json(
			{ error: 'No Cinephage plugin package is bundled in this build' },
			{ status: 404 }
		);
	}

	return Response.json(toJellyfinManifest(build.pkg, url.origin), {
		headers: { 'Cache-Control': 'no-cache' }
	});
};
