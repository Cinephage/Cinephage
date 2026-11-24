import type { PageServerLoad } from './$types';
import { loadAlbumPage } from '#lib/server/music/detail.js';

/**
 * `/discover/music/<id>` — an MBID, or `deezer-album-<id>` from a browse tile.
 * The loader answers from whichever provider the id names, so a click never
 * waits on the rate-gated one just to render.
 */
export const load: PageServerLoad = async ({ params, locals }) => ({
	...(await loadAlbumPage(params.mbid)),
	// Adding is an admin action; everyone else requests.
	isAdmin: locals.user?.role === 'admin'
});
