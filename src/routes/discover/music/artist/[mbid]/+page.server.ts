import type { PageServerLoad } from './$types';
import { loadArtistPage } from '#lib/server/music/detail.js';

/**
 * `/discover/music/artist/<id>` — an MBID, or `deezer-artist-<id>` from a chart
 * or search tile. Same provider dispatch as the album page.
 */
export const load: PageServerLoad = async ({ params }) => loadArtistPage(params.mbid);
