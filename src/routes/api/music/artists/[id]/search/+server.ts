import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { createChildLogger } from '#lib/logging/index.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { musicGrabService } from '#lib/server/music/MusicGrabService.js';
import { musicSearchService } from '#lib/server/music/MusicSearchService.js';

const logger = createChildLogger({ module: 'MusicArtistSearchApi', logDomain: 'system' });

/** Letters and digits only, lowercased — release titles are punctuation soup. */
function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/**
 * A release may only be auto-grabbed for an album when the release name
 * actually carries the album title. The album search ranks by artist, so a
 * discography sweep otherwise picks up whatever else that artist has — the
 * first live run grabbed "CHRIS STASSY - Dangerous" for a Chris Webby album.
 * Interactive search can still show those rows; automation must not take them.
 */
function releaseMatchesAlbum(albumTitle: string, releaseTitle: string): boolean {
	const tokens = normalize(albumTitle)
		.split(' ')
		.filter((token) => token.length > 2);
	if (tokens.length === 0) return false;
	const haystack = normalize(releaseTitle);
	return tokens.every((token) => haystack.includes(token));
}

const searchSchema = z.object({
	/** Albums to try in this call. Each one costs an indexer round trip. */
	limit: z.number().int().min(1).max(25).default(10),
	/** Only albums with no file yet. The default, because that is the point. */
	missingOnly: z.boolean().default(true)
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

	const targets = (input.missingOnly ? albums.filter((album) => !album.hasFile) : albums).slice(
		0,
		input.limit
	);

	const results: Array<{
		albumId: string;
		title: string;
		grabbed: boolean;
		release?: string;
		size?: number | null;
		error?: string;
	}> = [];

	for (const album of targets) {
		try {
			const search = await musicSearchService.searchForAlbum(album.id);
			const best = search.candidates.find(
				(candidate) =>
					candidate.accepted !== false &&
					Boolean(candidate.guid) &&
					releaseMatchesAlbum(album.title, candidate.title)
			);
			if (!best?.guid) {
				results.push({ albumId: album.id, title: album.title, grabbed: false, error: 'no accepted release' });
				continue;
			}
			const grab = await musicGrabService.grabAlbum(album.id, { releaseGuid: best.guid });
			results.push({
				albumId: album.id,
				title: album.title,
				grabbed: true,
				release: grab.title,
				size: grab.size
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn({ albumId: album.id, err: message }, '[MusicArtistSearch] album search failed');
			results.push({ albumId: album.id, title: album.title, grabbed: false, error: message });
		}
	}

	const remaining = Math.max(0, (input.missingOnly ? albums.filter((album) => !album.hasFile) : albums).length - targets.length);

	return Response.json({
		success: true,
		searched: targets.length,
		grabbed: results.filter((result) => result.grabbed).length,
		remaining,
		results
	});
};
