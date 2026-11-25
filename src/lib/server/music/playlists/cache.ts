/**
 * MusicBrainz answers, kept between playlist resolves.
 *
 * The API allows one request per second, so a 50-song playlist is minutes of
 * waiting and the same playlist is resolved again by every re-import and by
 * every smart-list refresh. Caching the answers is the only lever that makes
 * those repeats cheap: a second resolve of an unchanged playlist needs no
 * MusicBrainz request at all.
 *
 * Misses are cached too, and for a shorter time: a song MusicBrainz cannot
 * place today may be added next month, but paying for ten unmatchable tracks
 * on every refresh is not acceptable either.
 */
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { musicLookupCache } from '#lib/server/db/schema.js';
import { normalizeForMatch } from '../track-matching.js';
import type { MusicRelease, MusicReleaseGroup } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A match is a fact about MusicBrainz; it is worth keeping for a long time. */
const HIT_TTL_MS = 30 * DAY_MS;
/** A miss can become wrong when the database gains a release. */
const MISS_TTL_MS = 7 * DAY_MS;
const RELEASE_TTL_MS = 30 * DAY_MS;

/** `null` means the cache has no opinion; `{ value: null }` means "asked, nothing there". */
export type Cached<T> = { value: T | null };

function fold(value: string): string {
	return normalizeForMatch(value);
}

/** One cache row with its age; the caller decides which TTL applies. */
function readEntry<T>(key: string): { value: T | null; ageMs: number } | null {
	const row = db.select().from(musicLookupCache).where(eq(musicLookupCache.key, key)).get();
	if (!row) return null;
	try {
		return {
			value: JSON.parse(row.payload) as T | null,
			ageMs: Date.now() - Date.parse(row.fetchedAt)
		};
	} catch {
		db.delete(musicLookupCache).where(eq(musicLookupCache.key, key)).run();
		return null;
	}
}

function read<T>(key: string, ttlMs: (value: T | null) => number): Cached<T> | null {
	const entry = readEntry<T>(key);
	if (!entry) return null;
	if (!Number.isFinite(entry.ageMs) || entry.ageMs > ttlMs(entry.value)) {
		db.delete(musicLookupCache).where(eq(musicLookupCache.key, key)).run();
		return null;
	}
	return { value: entry.value };
}

function write(key: string, payload: unknown): void {
	const fetchedAt = new Date().toISOString();
	const stored = JSON.stringify(payload);
	db.insert(musicLookupCache)
		.values({ key, payload: stored, fetchedAt })
		.onConflictDoUpdate({ target: musicLookupCache.key, set: { payload: stored, fetchedAt } })
		.run();
}

export function albumCacheKey(artist: string, album: string): string {
	return `album:${fold(artist)}|${fold(album)}`;
}

export function artistCacheKey(name: string): string {
	return `artist:${fold(name)}`;
}

export function discographyKey(artistMbid: string): string {
	return `discog:${artistMbid}`;
}

export function featuresKey(artistMbid: string): string {
	return `features:${artistMbid}`;
}

export function artistAlbumsKey(artistMbid: string): string {
	return `albums:${artistMbid}`;
}

export function songCacheKey(artist: string, title: string): string {
	// `song3:` retires entries resolved before album-first ranking: those held singles.
	return `song3:${fold(artist)}|${fold(title)}`;
}

/** The release group an artist+album search settled on, or a remembered miss. */
export function getAlbumMatch(artist: string, album: string): Cached<MusicReleaseGroup> | null {
	return read<MusicReleaseGroup>(albumCacheKey(artist, album), (value) =>
		value === null ? MISS_TTL_MS : HIT_TTL_MS
	);
}

export function setAlbumMatch(
	artist: string,
	album: string,
	group: MusicReleaseGroup | null
): void {
	write(albumCacheKey(artist, album), group);
}

/** The MusicBrainz id behind a credited artist name, or a remembered miss. */
export function getArtistMbid(name: string): Cached<string> | null {
	return read<string>(artistCacheKey(name), (value) => (value === null ? MISS_TTL_MS : HIT_TTL_MS));
}

export function setArtistMbid(name: string, mbid: string | null): void {
	write(artistCacheKey(name), mbid);
}

/**
 * An artist's own release groups, as the discography scope would add them.
 *
 * Cached because the preview and the import both ask: expanding a selection
 * to a discography is a browse of every release group, and the user looking at
 * "this will add 213 albums" must not pay for it twice.
 */
export function getArtistDiscography(artistMbid: string): Cached<MusicReleaseGroup[]> | null {
	return read<MusicReleaseGroup[]>(discographyKey(artistMbid), () => HIT_TTL_MS);
}

export function setArtistDiscography(artistMbid: string, groups: MusicReleaseGroup[]): void {
	write(discographyKey(artistMbid), groups);
}

/** Albums where the artist is a guest, not the album artist. */
export function getArtistFeatures(artistMbid: string): Cached<MusicReleaseGroup[]> | null {
	return read<MusicReleaseGroup[]>(featuresKey(artistMbid), () => HIT_TTL_MS);
}

export function setArtistFeatures(artistMbid: string, groups: MusicReleaseGroup[]): void {
	write(featuresKey(artistMbid), groups);
}

/** An artist's albums indexed by track title — the song path's search space. */
export function getArtistAlbums(
	artistMbid: string
): Cached<Array<{ title: string; groups: MusicReleaseGroup[] }>> | null {
	return read<Array<{ title: string; groups: MusicReleaseGroup[] }>>(
		artistAlbumsKey(artistMbid),
		() => HIT_TTL_MS
	);
}

export function setArtistAlbums(
	artistMbid: string,
	rows: Array<{ title: string; groups: MusicReleaseGroup[] }>
): void {
	write(artistAlbumsKey(artistMbid), rows);
}

/** The album a song resolved to, or a remembered miss. */
export function getSongMatch(artist: string, title: string): Cached<MusicReleaseGroup> | null {
	return read<MusicReleaseGroup>(songCacheKey(artist, title), (value) =>
		value === null ? MISS_TTL_MS : HIT_TTL_MS
	);
}

export function setSongMatch(artist: string, title: string, group: MusicReleaseGroup | null): void {
	write(songCacheKey(artist, title), group);
}

/** The release group, one edition and its tracklist — what the import writes. */
export function getCachedRelease(
	releaseGroupMbid: string
): Cached<{ group: MusicReleaseGroup; release: MusicRelease }> | null {
	return read(`release:${releaseGroupMbid}`, () => RELEASE_TTL_MS);
}

export function setCachedRelease(
	releaseGroupMbid: string,
	value: { group: MusicReleaseGroup; release: MusicRelease }
): void {
	write(`release:${releaseGroupMbid}`, value);
}
