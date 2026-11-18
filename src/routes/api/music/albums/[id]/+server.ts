import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';

/** GET /api/music/albums/[id] — one album with its tracklist. */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const album = musicAlbumService.getAlbum(event.params.id);
	if (!album) return Response.json({ error: 'Album not found' }, { status: 404 });

	return Response.json({ success: true, album });
};
