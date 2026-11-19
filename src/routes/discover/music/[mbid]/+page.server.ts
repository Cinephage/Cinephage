import type { PageServerLoad } from './$types';
import { loadAlbumPage } from '#lib/server/music/detail.js';

/**
 * `/discover/music/<id>` — an MBID, or `deezer-album-<id>` from a browse tile.
 * The loader answers from whichever provider the id names, so a click never
 * waits on the rate-gated one just to render.
 */
export const load: PageServerLoad = async ({ params }) => loadAlbumPage(params.mbid);
