/**
 * Music search for Discover, from Deezer.
 *
 * MusicBrainz is the canonical metadata source but a gated one: a one-box
 * search there costs 1.2 s per request and can queue behind the rate gate, so
 * typing in Discover stalled for seconds. Deezer answers the same query in a
 * few hundred milliseconds and already carries covers, which is what a result
 * grid needs. Rows resolved here have no MusicBrainz id — the detail pages
 * resolve one when it is actually needed (an add), never to render.
 *
 * Three legs are asked at once (artist / album / song) and then interleaved by
 * relevance, not concatenated: "daft punk" used to return four artist tiles
 * first, two of them empty impostor profiles, and no album above the fold.
 */

import {
	createDeezerApi,
	pickImage,
	type DeezerAlbum,
	type DeezerApi,
	type DeezerApiOptions,
	type DeezerArtist,
	type DeezerTrack
} from './deezerApi.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 100;
const ALBUM_LIMIT = 12;
const ARTIST_LIMIT = 6;
const TRACK_LIMIT = 12;

/** How many of each kind a merged list carries: one artist profile, then the
 *  albums worth adding, then the songs people recognised the query from. */
const ARTIST_CAP = 2;
const ALBUM_CAP = 12;
const SONG_CAP = 8;

export interface DeezerMusicRow {
	/** Stable per provider, so the grid key never collides with a TMDB id. */
	id: string;
	title: string;
	subtitle: string | null;
	imageUrl: string | null;
	year: number | null;
	/** MusicBrainz id: never present on a search row. */
	mbid: null;
	musicKind: 'album' | 'artist' | 'song';
	/** For a song row: the album whose page resolves `mbid`. */
	albumTitle: string | null;
	/** Deezer's own ids, so a tile links straight to a provider-backed page. */
	deezerId: number;
	/** For a song row: the album it sits on, which is what a click opens. */
	deezerAlbumId: number | null;
}

export interface DeezerSearchOptions extends DeezerApiOptions {
	api?: DeezerApi;
}

/** Diacritics and punctuation are noise in a music query: "Beyoncé" == "beyonce". */
export function normalizeQuery(text: string): string {
	return text
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/**
 * How well a title answers the query, 0–100. Exact beats prefix beats a whole
 * word beats a substring, and a multi-word query still scores the rows it
 * partly names — "blonde frank ocean" should surface *Blonde*.
 */
export function titleRelevance(title: string, query: string): number {
	const t = normalizeQuery(title);
	const q = normalizeQuery(query);
	if (!t || !q) return 0;
	if (t === q) return 100;
	if (t.startsWith(`${q} `) || t.startsWith(q)) return 80;
	const words = t.split(' ');
	if (words.includes(q)) return 60;
	if (t.includes(q)) return 40;
	const queryWords = q.split(' ').filter(Boolean);
	if (queryWords.length < 2) return 0;
	const hits = queryWords.filter((word) => words.includes(word)).length;
	return hits > 0 ? Math.round((30 * hits) / queryWords.length) : 0;
}

interface ScoredRow {
	row: DeezerMusicRow;
	score: number;
	order: number;
}

function albumScore(album: DeezerAlbum, query: string, order: number): number {
	const byTitle = titleRelevance(album.title, query) * 1.2;
	const byArtist = titleRelevance(album.artist?.name ?? '', query) * 0.8;
	return Math.max(byTitle, byArtist) + 12 - order * 0.2;
}

/**
 * A name is short, so exactness is the whole signal: a prefix match is often a
 * tribute act ("Daft Punk Experience"), and it must not outrank the real
 * artist's albums. Reach (fan count) breaks ties inside a tier.
 */
function artistScore(artist: DeezerArtist, query: string, order: number): number {
	const relevance = titleRelevance(artist.name, query);
	const tier =
		relevance >= 100 ? 130 : relevance >= 80 ? 70 : relevance >= 60 ? 45 : relevance * 0.5;
	const reach = Math.log10((artist.nb_fan ?? 0) + 1) * 4;
	return tier + reach + 10 - order * 0.2;
}

function songScore(track: DeezerTrack, query: string, order: number): number {
	const byTitle = titleRelevance(track.title, query) * 1.15;
	const byArtist = titleRelevance(track.artist?.name ?? '', query) * 0.5;
	const popularity = Math.log10((track.rank ?? 0) + 1);
	return Math.max(byTitle, byArtist) + popularity + 6 - order * 0.2;
}

function albumRow(album: DeezerAlbum): DeezerMusicRow {
	return {
		id: `deezer-album-${album.id}`,
		title: album.title,
		subtitle: album.artist?.name ?? null,
		imageUrl: pickImage(album.cover_big, album.cover_medium, album.cover_small),
		year: album.release_date ? Number(album.release_date.slice(0, 4)) || null : null,
		mbid: null,
		musicKind: 'album',
		albumTitle: album.title,
		deezerId: album.id,
		deezerAlbumId: album.id
	};
}

function artistRow(artist: DeezerArtist): DeezerMusicRow {
	return {
		id: `deezer-artist-${artist.id}`,
		title: artist.name,
		subtitle: null,
		imageUrl: pickImage(artist.picture_big, artist.picture_medium, artist.picture_small),
		year: null,
		mbid: null,
		musicKind: 'artist',
		albumTitle: null,
		deezerId: artist.id,
		deezerAlbumId: null
	};
}

function songRow(track: DeezerTrack): DeezerMusicRow {
	return {
		id: `deezer-track-${track.id}`,
		title: track.title,
		subtitle: track.artist?.name ?? null,
		imageUrl: pickImage(
			track.album?.cover_big,
			track.album?.cover_medium,
			track.album?.cover_small
		),
		year: null,
		mbid: null,
		musicKind: 'song',
		albumTitle: track.album?.title ?? null,
		deezerId: track.id,
		deezerAlbumId: track.album?.id ?? null
	};
}

/**
 * Merge the three legs into one ranked list.
 *
 * An artist profile with no albums is a dead end — Deezer is full of
 * name-squatters ("Daft Punk" with 0 albums and 0 fans) and they used to sit
 * above the real artist's discography. They are dropped; the real profile is
 * preferred by fan count when two rows score the same.
 */
export function mergeMusicRows(
	artists: DeezerArtist[],
	albums: DeezerAlbum[],
	tracks: DeezerTrack[],
	query: string
): DeezerMusicRow[] {
	const scored: ScoredRow[] = [];
	let order = 0;

	const seenArtists = new Set<string>();
	for (const artist of artists) {
		if ((artist.nb_album ?? 0) === 0) continue;
		const key = normalizeQuery(artist.name);
		if (seenArtists.has(key)) continue;
		seenArtists.add(key);
		scored.push({ row: artistRow(artist), score: artistScore(artist, query, order), order });
		order += 1;
	}

	const seenAlbums = new Set<string>();
	for (const album of albums) {
		const key = `${normalizeQuery(album.artist?.name ?? '')}|${normalizeQuery(album.title)}`;
		if (seenAlbums.has(key)) continue;
		seenAlbums.add(key);
		scored.push({ row: albumRow(album), score: albumScore(album, query, order), order });
		order += 1;
	}

	const seenSongs = new Set<string>();
	for (const track of tracks) {
		const key = `${normalizeQuery(track.artist?.name ?? '')}|${normalizeQuery(track.title)}`;
		if (seenSongs.has(key)) continue;
		seenSongs.add(key);
		scored.push({ row: songRow(track), score: songScore(track, query, order), order });
		order += 1;
	}

	scored.sort((a, b) => b.score - a.score || a.order - b.order);

	const kept: DeezerMusicRow[] = [];
	const counts: Record<DeezerMusicRow['musicKind'], number> = { artist: 0, album: 0, song: 0 };
	const caps: Record<DeezerMusicRow['musicKind'], number> = {
		artist: ARTIST_CAP,
		album: ALBUM_CAP,
		song: SONG_CAP
	};
	for (const { row } of scored) {
		const kind = row.musicKind;
		if (counts[kind] >= caps[kind]) continue;
		counts[kind] += 1;
		kept.push(row);
	}
	return kept;
}

export function createDeezerSearch(options: DeezerSearchOptions = {}) {
	const api = options.api ?? createDeezerApi(options);
	const now = options.now ?? Date.now;
	const cache = new Map<string, { at: number; rows: DeezerMusicRow[] }>();

	return async function searchMusic(query: string): Promise<DeezerMusicRow[]> {
		const trimmed = query.trim();
		const key = trimmed.toLowerCase();
		if (!key) return [];

		const hit = cache.get(key);
		if (hit && now() - hit.at < CACHE_TTL_MS) return hit.rows;

		// An artist match explains the query, an album is what gets added, and a
		// song is often what was typed. A song row points at its album, because
		// that is the unit acquisition and import act on.
		const [artists, albums, tracks] = await Promise.all([
			api.search<DeezerArtist>('artist', trimmed, ARTIST_LIMIT).catch(() => []),
			api.search<DeezerAlbum>('album', trimmed, ALBUM_LIMIT).catch(() => []),
			api.search<DeezerTrack>('track', trimmed, TRACK_LIMIT).catch(() => [])
		]);

		const rows = mergeMusicRows(artists, albums, tracks, trimmed);

		if (cache.size >= CACHE_MAX) {
			const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (oldest) cache.delete(oldest[0]);
		}
		cache.set(key, { at: now(), rows });
		return rows;
	};
}

export const searchMusic = createDeezerSearch();
