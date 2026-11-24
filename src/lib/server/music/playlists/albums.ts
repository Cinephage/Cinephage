/**
 * The album each song belongs to, asked of the catalog that is not rate limited.
 *
 * A playlist is a list of songs; the library stores albums. Deezer answers
 * "which album is this song on" in a few hundred milliseconds and answers many
 * at once — measured from this network, 20 concurrent requests in 380 ms with
 * no refusals — where MusicBrainz allows one request per second per address and
 * declines *every* request once that is exceeded.
 *
 * So the album is discovered here, once per playlist, before the resolver runs.
 * Each album this fills in turns a per-song MusicBrainz recording search into
 * one release-group search shared by every track from that album. A provider
 * that already knows its albums (Deezer does) pays nothing: a track carrying an
 * album is never looked at.
 *
 * Nothing here throws. A playlist whose albums cannot be discovered is still
 * resolvable the old way, one recording at a time.
 */
import { artistMatches, coreTitle } from '../track-matching.js';
import type { PlaylistTrack } from './types.js';

/** The only call this module makes; `DeezerApi` satisfies it. */
export interface TrackSearch {
	search<T>(kind: 'track', query: string, limit: number): Promise<T[]>;
}

/** What a track search hit has to carry to be usable here. */
interface CatalogTrack {
	title?: string;
	artist?: { name?: string };
	album?: { title?: string };
}

const SEARCH_LIMIT = 10;
/** Deezer serves dozens a second; a handful in flight is enough and is polite. */
const DEFAULT_CONCURRENCY = 4;

export interface AlbumFillResult {
	tracks: PlaylistTrack[];
	/** How many tracks gained an album; 0 means the resolver runs unchanged. */
	filled: number;
}

/** Quotes are syntax in Deezer's query language, never part of a title. */
function term(value: string): string {
	return value.replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The first hit that is the same song by the same act — the rule the resolver
 * already applies to a MusicBrainz hit, so a decorated title ("Remastered
 * 2011") still matches and a cover does not.
 */
function albumOf(track: PlaylistTrack, hits: CatalogTrack[]): string | null {
	const wanted = coreTitle(track.title);
	if (!wanted) return null;
	for (const hit of hits) {
		if (!hit.title || !hit.album?.title) continue;
		if (coreTitle(hit.title) !== wanted) continue;
		if (!artistMatches(track.artists, hit.artist?.name ?? '')) continue;
		return hit.album.title.trim() || null;
	}
	return null;
}

async function discover(track: PlaylistTrack, search: TrackSearch): Promise<string | null> {
	try {
		if (!track.title?.trim() || track.artists?.length === 0) return null;
		const query = `artist:"${term(track.artists[0])}" track:"${term(track.title)}"`;
		const hits = await search.search<CatalogTrack>('track', query, SEARCH_LIMIT);
		return albumOf(track, hits);
	} catch {
		// A dead catalog — or a provider that handed back a malformed entry — is
		// not a broken playlist: the resolver still runs.
		return null;
	}
}

/**
 * Fill in the album for every track whose provider did not supply one.
 *
 * Order is preserved and only the album is added: the entry the user pasted is
 * what the preview shows, and a discovery step has no business rewriting it.
 */
export async function fillMissingAlbums(
	tracks: PlaylistTrack[],
	search: TrackSearch,
	options: { concurrency?: number } = {}
): Promise<AlbumFillResult> {
	const missing = tracks.filter((track) => !track.album?.trim());
	if (missing.length === 0) return { tracks, filled: 0 };

	const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
	const found = new Map<PlaylistTrack, string>();
	let cursor = 0;

	// A fixed pool, not one promise per track: a 500-track playlist must not open
	// 500 sockets against a catalog we do not own.
	const workers = Array.from({ length: Math.min(concurrency, missing.length) }, async () => {
		for (;;) {
			const index = cursor;
			cursor += 1;
			const track = missing[index];
			if (!track) return;
			const album = await discover(track, search);
			if (album) found.set(track, album);
		}
	});
	await Promise.all(workers);

	if (found.size === 0) return { tracks, filled: 0 };
	return {
		tracks: tracks.map((track) => {
			const album = found.get(track);
			return album ? { ...track, album } : track;
		}),
		filled: found.size
	};
}
