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
	album?: { id?: number | string; title?: string };
}

/** The album a hit names: what to store, and how to fetch its tracklist. */
export interface DiscoveredAlbum {
	/** The catalog's album id; null when the hit carried none. */
	sourceId: string | null;
	title: string;
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

/** The title before the first " - ": playlist exports append version tags that way. */
function headTitle(value: string): string {
	return coreTitle(value.split(' - ')[0] ?? value);
}

/**
 * The first hit that is the same song by the same act — the rule the resolver
 * already applies to a MusicBrainz hit, so a decorated title ("Remastered
 * 2011") still matches and a cover does not.
 *
 * Two spellings of a version tag count as the same song: one provider writes
 * "HIGH HONEY DRIP - Late Night Cut", another "HIGH HONEY DRIP (Late Night
 * Cut)", and a dash is not a different work. Only the head has to agree, and
 * only here — the album title this yields is verified against MusicBrainz
 * afterwards, so a loose song match cannot become a loose album match.
 */
function albumOf(track: PlaylistTrack, hits: CatalogTrack[]): DiscoveredAlbum | null {
	const wanted = coreTitle(track.title);
	if (!wanted) return null;
	const wantedHead = headTitle(track.title);
	for (const hit of hits) {
		if (!hit.title || !hit.album?.title) continue;
		const sameSong =
			coreTitle(hit.title) === wanted || (wantedHead !== '' && headTitle(hit.title) === wantedHead);
		if (!sameSong) continue;
		if (!artistMatches(track.artists, hit.artist?.name ?? '')) continue;
		const title = hit.album.title.trim();
		if (!title) continue;
		const id = hit.album.id;
		return { title, sourceId: id === undefined || id === null ? null : String(id) };
	}
	return null;
}

async function discover(
	track: PlaylistTrack,
	search: TrackSearch
): Promise<DiscoveredAlbum | null> {
	try {
		if (!track.title?.trim() || track.artists?.length === 0) return null;
		// Deezer's field syntax — `artist:"…" track:"…"` — answers zero for plenty
		// of independent artists whose plain text match is exact; measured on four
		// of them in one playlist. The quoted form is the one that finds the rows,
		// and the filters above are what make a loose search safe.
		const query = `"${term(track.title)}" "${term(track.artists[0])}"`;
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
	const found = new Map<PlaylistTrack, DiscoveredAlbum>();
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
			// The id travels with the title: an album MusicBrainz has no release
			// group for can only be stored from the catalog that named it.
			return album ? { ...track, album: album.title, albumSourceId: album.sourceId } : track;
		}),
		filled: found.size
	};
}
