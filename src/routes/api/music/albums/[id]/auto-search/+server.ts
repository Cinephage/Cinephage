import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { autoSearchAlbum } from '#lib/server/music/MusicAutoSearch.js';

/**
 * POST /api/music/albums/[id]/auto-search
 *
 * One-click grab for a single album — the album row's search button, and the
 * song rows' search action. Interactive search stays on `…/search`, which
 * returns the candidate list instead of taking one.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const album = musicAlbumService.getAlbum(event.params.id);
	if (!album) return Response.json({ error: 'Album not found' }, { status: 404 });

	const result = await autoSearchAlbum(album);
	if (!result.grabbed) {
		return Response.json({ success: false, ...result }, { status: 409 });
	}

	return Response.json({ success: true, ...result });
};
