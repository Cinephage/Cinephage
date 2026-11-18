import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAdmin, requireAuth } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';

const patchAlbumSchema = z.object({
	monitored: z.boolean()
});

/** GET /api/music/albums/[id] — one album with its tracklist. */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const album = musicAlbumService.getAlbum(event.params.id);
	if (!album) return Response.json({ error: 'Album not found' }, { status: 404 });

	return Response.json({ success: true, album });
};

/**
 * PATCH /api/music/albums/[id] — the album's own toggle.
 *
 * Monitoring belongs to the album because acquisition does: the album is the
 * unit that searches, grabs and imports, exactly like a movie. The artist's
 * flag only decides which albums a future discography refresh keeps.
 */
export const PATCH: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let input: z.infer<typeof patchAlbumSchema>;
	try {
		input = await parseBody(event.request, patchAlbumSchema);
	} catch (err) {
		return Response.json(
			{ error: 'Invalid request', details: err instanceof Error ? err.message : String(err) },
			{ status: 400 }
		);
	}

	const updated = musicAlbumService.setMonitored(event.params.id, input.monitored);
	if (!updated) return Response.json({ error: 'Album not found' }, { status: 404 });

	return Response.json({ success: true, album: musicAlbumService.getAlbum(event.params.id) });
};

/** DELETE /api/music/albums/[id] — remove the album from the library. */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const removed = musicAlbumService.deleteAlbum(event.params.id);
	if (!removed) return Response.json({ error: 'Album not found' }, { status: 404 });

	return Response.json({ success: true });
};
