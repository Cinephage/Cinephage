/**
 * Deezer's public API: the browse and search source for music.
 *
 * Deezer answers in a couple of hundred milliseconds and carries covers, which
 * is what a result grid needs. MusicBrainz stays the identity layer — the
 * library is keyed by MBID — but it allows one request per second, so nothing a
 * click waits on may depend on it.
 *
 * One factory, one cache, one timeout: every reader here goes through
 * `getJson`, so "a dead upstream returns null, never throws" is written once.
 * The factory keeps the injected clock and fetch that tests need, without a
 * module-level seam that production code could accidentally rely on.
 */

const BASE = 'https://api.deezer.com';
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_MAX = 400;

const SEARCH_TTL_MS = 10 * 60 * 1000;
const ENTITY_TTL_MS = 24 * 60 * 60 * 1000;
const CHART_TTL_MS = 60 * 60 * 1000;

/** Deezer returns an empty string for an image it does not hold, which turns
 *  into `.../artist//500x500` — a broken tile. Fall through to the next one. */
export function pickImage(...candidates: Array<string | undefined | null>): string | null {
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
	}
	return null;
}

export interface DeezerArtist {
	id: number;
	name: string;
	picture_small?: string;
	picture_medium?: string;
	picture_big?: string;
	picture_xl?: string;
	nb_album?: number;
	nb_fan?: number;
}

export interface DeezerTrack {
	id: number;
	title: string;
	duration?: number;
	rank?: number;
	track_position?: number;
	disk_number?: number;
	explicit_lyrics?: boolean;
	preview?: string;
	artist?: { id?: number; name?: string };
	album?: {
		id?: number;
		title?: string;
		cover_small?: string;
		cover_medium?: string;
		cover_big?: string;
		cover_xl?: string;
	};
}

export interface DeezerAlbum {
	id: number;
	title: string;
	upc?: string;
	label?: string;
	release_date?: string;
	record_type?: string;
	genre_id?: number;
	nb_tracks?: number;
	duration?: number;
	fans?: number;
	explicit_lyrics?: boolean;
	cover_small?: string;
	cover_medium?: string;
	cover_big?: string;
	cover_xl?: string;
	genres?: { data?: Array<{ id: number; name: string }> };
	artist?: { id?: number; name?: string };
	contributors?: Array<{ id?: number; name?: string; role?: string }>;
	tracks?: { data?: DeezerTrack[] };
}

export interface DeezerGenre {
	id: number;
	name: string;
	picture_small?: string;
	picture_medium?: string;
	picture_big?: string;
}

export interface DeezerChart {
	albums?: { data?: DeezerAlbum[]; total?: number };
	artists?: { data?: DeezerArtist[]; total?: number };
	tracks?: { data?: DeezerTrack[]; total?: number };
}

interface DeezerList<T> {
	data?: T[];
	total?: number;
	next?: string;
}

export type DeezerSearchKind = 'album' | 'artist' | 'track';

export interface DeezerApiOptions {
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export interface DeezerApi {
	search<T>(kind: DeezerSearchKind, query: string, limit: number): Promise<T[]>;
	album(id: number | string): Promise<DeezerAlbum | null>;
	artist(id: number | string): Promise<DeezerArtist | null>;
	artistAlbums(id: number | string, limit?: number): Promise<DeezerAlbum[]>;
	artistTop(id: number | string, limit?: number): Promise<DeezerTrack[]>;
	chart(options?: { genreId?: number; limit?: number }): Promise<DeezerChart | null>;
	chartAlbums(
		genreId: number | undefined,
		limit: number
	): Promise<{ rows: DeezerAlbum[]; total: number }>;
	genres(): Promise<DeezerGenre[]>;
}

export function createDeezerApi(options: DeezerApiOptions = {}): DeezerApi {
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const cache = new Map<string, { at: number; value: unknown }>();

	async function getJson<T>(path: string, ttlMs: number): Promise<T | null> {
		const hit = cache.get(path);
		if (hit && now() - hit.at < ttlMs) return hit.value as T;

		let body: T | null = null;
		try {
			const response = await fetchImpl(`${BASE}${path}`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
			if (response.ok) {
				const parsed = (await response.json()) as T & { error?: unknown };
				// Deezer answers 200 with an `error` body for an unknown id.
				if (!parsed.error) body = parsed;
			}
		} catch {
			body = null;
		}

		if (body === null) return null;

		if (cache.size >= CACHE_MAX) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		cache.set(path, { at: now(), value: body });
		return body;
	}

	async function chartAlbums(
		genreId: number | undefined,
		limit: number
	): Promise<{ rows: DeezerAlbum[]; total: number }> {
		const genre = genreId ? `/${genreId}` : '/0';
		const body = await getJson<DeezerList<DeezerAlbum>>(
			`/chart${genre}/albums?limit=${limit}`,
			CHART_TTL_MS
		);
		const rows = Array.isArray(body?.data) ? body.data : [];
		return { rows, total: body?.total ?? rows.length };
	}

	return {
		async search<T>(kind: DeezerSearchKind, query: string, limit: number): Promise<T[]> {
			const body = await getJson<DeezerList<T>>(
				`/search/${kind}?q=${encodeURIComponent(query)}&limit=${limit}`,
				SEARCH_TTL_MS
			);
			return Array.isArray(body?.data) ? body.data : [];
		},
		album: (id) => getJson<DeezerAlbum>(`/album/${id}`, ENTITY_TTL_MS),
		artist: (id) => getJson<DeezerArtist>(`/artist/${id}`, ENTITY_TTL_MS),
		async artistAlbums(id, limit = 100) {
			const body = await getJson<DeezerList<DeezerAlbum>>(
				`/artist/${id}/albums?limit=${limit}`,
				ENTITY_TTL_MS
			);
			return Array.isArray(body?.data) ? body.data : [];
		},
		async artistTop(id, limit = 10) {
			const body = await getJson<DeezerList<DeezerTrack>>(
				`/artist/${id}/top?limit=${limit}`,
				CHART_TTL_MS
			);
			return Array.isArray(body?.data) ? body.data : [];
		},
		async chart({ genreId, limit = 100 } = {}) {
			const genre = genreId ? `/${genreId}` : '/0';
			return getJson<DeezerChart>(`/chart${genre}?limit=${limit}`, CHART_TTL_MS);
		},
		chartAlbums,
		async genres() {
			const body = await getJson<DeezerList<DeezerGenre>>('/genre', ENTITY_TTL_MS);
			// Genre 0 is Deezer's "All" pseudo-genre; the surface has its own chip.
			return (body?.data ?? []).filter((genre) => genre.id !== 0);
		}
	};
}

export const deezer = createDeezerApi();
