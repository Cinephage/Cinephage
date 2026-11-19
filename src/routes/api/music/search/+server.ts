import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';
import { musicBrainz, MusicBrainzError } from '#lib/server/music/musicbrainz.js';

const logger = createChildLogger({ module: 'MusicSearchApi', logDomain: 'system' });

/**
 * MusicBrainz is gated at 1.2 s per request, and the same album is resolved
 * repeatedly — a chart card click, then its add, then the next open. Ten
 * minutes of memo keeps those off the gate without hiding real edits: the
 * resolver only looks up an id.
 */
const RESULT_TTL_MS = 10 * 60 * 1000;
const RESULT_CACHE_MAX = 200;
const resultCache = new Map<string, { at: number; body: unknown }>();

function cached(key: string): unknown | null {
	const hit = resultCache.get(key);
	if (!hit) return null;
	if (Date.now() - hit.at > RESULT_TTL_MS) {
		resultCache.delete(key);
		return null;
	}
	return hit.body;
}

function remember(key: string, body: unknown): void {
	if (resultCache.size >= RESULT_CACHE_MAX) {
		const oldest = [...resultCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
		if (oldest) resultCache.delete(oldest[0]);
	}
	resultCache.set(key, { at: Date.now(), body });
}

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

	const cacheKey = `${kind}|${artist}|${album}|${q}`;
	const memo = cached(cacheKey);
	if (memo) return Response.json(memo);

	try {
		if (kind === 'artist') {
			const body = {
				success: true,
				type: 'artist',
				results: await musicBrainz.searchArtists(q || artist, 20)
			};
			remember(cacheKey, body);
			return Response.json(body);
		}

		if (kind === 'song') {
			const body = {
				success: true,
				type: 'song',
				results: await musicBrainz.searchRecordings({ artist, track: q || album, limit: 25 })
			};
			remember(cacheKey, body);
			return Response.json(body);
		}

		const body = {
			success: true,
			type: 'album',
			results: await musicBrainz.searchReleaseGroups({ artist, album: album || q, limit: 20 })
		};
		remember(cacheKey, body);
		return Response.json(body);
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