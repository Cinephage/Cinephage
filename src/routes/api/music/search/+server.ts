import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';
import { musicBrainz, MusicBrainzError } from '#lib/server/music/musicbrainz.js';

const logger = createChildLogger({ module: 'MusicSearchApi', logDomain: 'system' });

type SearchKind = 'artist' | 'album' | 'song';

function readKind(raw: string | null): SearchKind {
	if (raw === 'artist' || raw === 'song') return raw;
	return 'album';
}

/**
 * GET /api/music/search?type=artist|album|song&artist=&album=&q=
 *
 * One endpoint for the three things a person searches for, because the UI is
 * one search box with a type switch:
 *
 *   artist → who to add
 *   album  → release groups (the work)
 *   song   → recordings, which include guest appearances (MusicBrainz matches
 *            the artist *credit*, so a feature is found as well as an own track)
 *
 * A song hit carries the release group it appeared on, because a song is never
 * importable by itself — the album is what gets stored.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const kind = readKind(event.url.searchParams.get('type'));
	const artist = event.url.searchParams.get('artist')?.trim() ?? '';
	const album = event.url.searchParams.get('album')?.trim() ?? '';
	const q = event.url.searchParams.get('q')?.trim() ?? '';

	if (!artist && !album && !q) {
		return Response.json({ error: 'An artist, album or query is required' }, { status: 400 });
	}
	if (kind === 'song' && !artist && !q) {
		return Response.json(
			{ error: 'A song search needs an artist or a track title' },
			{ status: 400 }
		);
	}

	try {
		if (kind === 'artist') {
			return Response.json({
				success: true,
				type: 'artist',
				results: await musicBrainz.searchArtists(q || artist, 20)
			});
		}

		if (kind === 'song') {
			return Response.json({
				success: true,
				type: 'song',
				results: await musicBrainz.searchRecordings({ artist, track: q || album, limit: 25 })
			});
		}

		return Response.json({
			success: true,
			type: 'album',
			results: await musicBrainz.searchReleaseGroups({ artist, album: album || q, limit: 20 })
		});
	} catch (err) {
		const retryable = err instanceof MusicBrainzError && err.retryable;
		logger.warn(
			{ err: err instanceof Error ? err.message : String(err), retryable, kind },
			'[MusicSearch] MusicBrainz search failed'
		);
		return Response.json(
			{
				error: 'MusicBrainz search failed',
				details: err instanceof Error ? err.message : String(err),
				retryable
			},
			{ status: 502 }
		);
	}
};
