import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { musicBrainz } from '#lib/server/music/musicbrainz.js';

/**
 * GET /api/music/albums/[id]/cover
 *
 * Serves the album's artwork. Imported albums get a local `coverPath`; before an
 * album has files, the edition is still known, so the Cover Art Archive is the
 * source and the browser follows the redirect. Proxying beats putting the
 * archive URL in the page: one source of truth, and swapping in the local file
 * later changes nothing for callers.
 *
 * The redirect is a plain Response with a Location header on purpose —
 * SvelteKit's `redirect()` helper refuses an external origin
 * (`kit/redirect_external_not_allowed`), which surfaced as a 500 on the first
 * live request.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const album = musicAlbumService.getAlbum(event.params.id);
	if (!album?.hasCover) return new Response('No cover for this album', { status: 404 });

	// Local artwork (`coverPath`) is written by the import slice; until an album
	// has files there is no local file to serve, so the archive is the source.
	if (!album.releaseMbid) return new Response('No cover for this album', { status: 404 });
	return new Response(null, {
		status: 302,
		headers: { location: musicBrainz.coverArtUrl(album.releaseMbid, 500) }
	});
};
