import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { autoSearchAlbum } from '#lib/server/music/MusicAutoSearch.js';

const searchSchema = z.object({
	/** Albums to try in this call. Each one costs an indexer round trip. */
	limit: z.number().int().min(1).max(25).default(10),
	/** Only albums with no file yet. The default, because that is the point. */
	missingOnly: z.boolean().default(true),
	/** Albums an earlier batch of this run already tried. */
	excludeIds: z.array(z.string().min(1)).max(2000).optional()
});

/**
 * POST /api/music/artists/[id]/search
 *
 * The artist-level counterpart of the series page's search: walk the albums,
 * search each one on the indexers and take the best accepted release. Bounded
 * and batched the same way the add-artist flow is — the caller gets a
 * `remaining` count and continues, rather than one request holding an indexer
 * session open for a 23-album discography.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let input: z.infer<typeof searchSchema>;
	try {
		input = await parseBody(event.request, searchSchema);
	} catch (err) {
		return Response.json(
			{ error: 'Invalid request', details: err instanceof Error ? err.message : String(err) },
			{ status: 400 }
		);
	}

	const albums = musicAlbumService.listAlbums({ artistId: event.params.id });
	if (albums.length === 0) return Response.json({ error: 'Artist not found' }, { status: 404 });

	const excluded = new Set(input.excludeIds ?? []);
	const eligible = (input.missingOnly ? albums.filter((album) => !album.hasFile) : albums).filter(
		(album) => !excluded.has(album.id)
	);
	const targets = eligible.slice(0, input.limit);

	const results = [];
	for (const album of targets) {
		results.push(await autoSearchAlbum(album));
	}

	return Response.json({
		success: true,
		searched: targets.length,
		grabbed: results.filter((result) => result.grabbed).length,
		remaining: Math.max(0, eligible.length - targets.length),
		results
	});
};
