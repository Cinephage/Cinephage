import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAdmin, requireAuth } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { musicArtistService } from '#lib/server/music/MusicArtistService.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { musicProfileService } from '#lib/server/music/MusicProfileService.js';

const patchArtistSchema = z
	.object({
		name: z.string().trim().min(1).max(300).optional(),
		sortName: z.string().trim().max(300).nullable().optional(),
		monitored: z.boolean().optional(),
		qualityProfileId: z.string().trim().min(1).nullable().optional()
	})
	.refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

/** GET /api/music/artists/[id] — one artist row as the library stores it. */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const artist = musicArtistService.getArtist(event.params.id);
	if (!artist) return Response.json({ error: 'Artist not found' }, { status: 404 });

	return Response.json({ success: true, artist });
};

/**
 * PATCH /api/music/artists/[id] — the artist flag.
 *
 * An artist's monitoring is about future discovery, not current acquisition:
 * albums carry their own flag and are what actually searches and grabs. This
 * one decides whether a discography refresh treats unowned albums as wanted.
 */
export const PATCH: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let input: z.infer<typeof patchArtistSchema>;
	try {
		input = await parseBody(event.request, patchArtistSchema);
	} catch (err) {
		return Response.json(
			{ error: 'Invalid request', details: err instanceof Error ? err.message : String(err) },
			{ status: 400 }
		);
	}

	if (input.qualityProfileId && !musicProfileService.get(input.qualityProfileId)) {
		return Response.json(
			{ error: `Unknown music quality profile: ${input.qualityProfileId}` },
			{ status: 400 }
		);
	}

	const updated = musicArtistService.updateArtist(event.params.id, input);
	if (!updated) return Response.json({ error: 'Artist not found' }, { status: 404 });

	return Response.json({
		success: true,
		artist: musicArtistService.getArtist(event.params.id)
	});
};

/** DELETE /api/music/artists/[id] — remove the artist and every album under it. */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	await musicAlbumService.cancelDownloadsForArtist(event.params.id);
	const removed = musicArtistService.deleteArtist(event.params.id);
	if (!removed) return Response.json({ error: 'Artist not found' }, { status: 404 });

	return Response.json({ success: true });
};
