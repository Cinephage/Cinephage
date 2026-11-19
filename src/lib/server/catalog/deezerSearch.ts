/**
 * Music search for Discover, from Deezer.
 *
 * MusicBrainz is the canonical metadata source but a gated one: a one-box
 * search there costs 1.2 s per request and can queue behind the rate gate, so
 * typing in Discover stalled for seconds. Deezer answers the same query in a
 * few hundred milliseconds and already carries covers, which is what a result
 * grid needs. Rows resolved here have no MusicBrainz id — the detail pages
 * resolve one when they are opened, and adding an album resolves it then.
 *
 * Cached briefly: a user typing "daft p" → "daft pu" → "daft punk" must not hit
 * the upstream three times.
 */

const SEARCH_URL = 'https://api.deezer.com/search';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 100;
const ALBUM_LIMIT = 12;
const ARTIST_LIMIT = 4;

export interface DeezerMusicRow {
	/** Stable per provider, so the grid key never collides with a TMDB id. */
	id: string;
	title: string;
	subtitle: string | null;
	imageUrl: string | null;
	year: number | null;
	/** MusicBrainz id: never present on a search row. */
	mbid: null;
	musicKind: 'album' | 'artist';
}

interface DeezerArtist {
	id: number;
	name: string;
	picture_big?: string;
	picture_medium?: string;
}

interface DeezerAlbum {
	id: number;
	title: string;
	cover_big?: string;
	cover_medium?: string;
	release_date?: string;
	artist?: { name?: string };
}

export interface DeezerSearchOptions {
	fetchImpl?: typeof fetch;
	now?: () => number;
}

async function search<T>(
	kind: 'album' | 'artist',
	query: string,
	limit: number,
	fetchImpl: typeof fetch
): Promise<T[]> {
	const url = `${SEARCH_URL}/${kind}?q=${encodeURIComponent(query)}&limit=${limit}`;
	const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
	if (!response.ok) return [];
	const body = (await response.json()) as { data?: T[] };
	return Array.isArray(body.data) ? body.data : [];
}

export function createDeezerSearch(options: DeezerSearchOptions = {}) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const cache = new Map<string, { at: number; rows: DeezerMusicRow[] }>();

	return async function searchMusic(query: string): Promise<DeezerMusicRow[]> {
		const key = query.trim().toLowerCase();
		if (!key) return [];

		const hit = cache.get(key);
		if (hit && now() - hit.at < CACHE_TTL_MS) return hit.rows;

		// Both legs at once: an artist match usually explains the query, an album
		// match is what gets added, and the grid shows both.
		const [artists, albums] = await Promise.all([
			search<DeezerArtist>('artist', key, ARTIST_LIMIT, fetchImpl).catch(() => []),
			search<DeezerAlbum>('album', key, ALBUM_LIMIT, fetchImpl).catch(() => [])
		]);

		const rows: DeezerMusicRow[] = [
			...artists.map((artist) => ({
				id: `deezer-artist-${artist.id}`,
				title: artist.name,
				subtitle: null,
				imageUrl: artist.picture_big ?? artist.picture_medium ?? null,
				year: null,
				mbid: null,
				musicKind: 'artist' as const
			})),
			...albums.map((album) => ({
				id: `deezer-album-${album.id}`,
				title: album.title,
				subtitle: album.artist?.name ?? null,
				imageUrl: album.cover_big ?? album.cover_medium ?? null,
				year: album.release_date ? Number(album.release_date.slice(0, 4)) || null : null,
				mbid: null,
				musicKind: 'album' as const
			}))
		];

		if (cache.size >= CACHE_MAX) {
			const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (oldest) cache.delete(oldest[0]);
		}
		cache.set(key, { at: now(), rows });
		return rows;
	};
}

export const searchMusic = createDeezerSearch();
