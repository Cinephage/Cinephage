/**
 * Where album artwork is served from.
 *
 * The Cover Art Archive answers a 307 to archive.org, which answers a 302 to a
 * download node: three round trips that measured 1.5–4 s per image from this
 * network, and the archive sends no cache headers on its redirects, so a grid
 * paid that again on every render. Every surface therefore asks this instance
 * for the image, and the server walks the chain once and caches the bytes.
 *
 * This module is the one owner of that URL shape. Client and server both use
 * it; the fetch lives in `#lib/server/music/cover-cache.js`.
 */

export const COVER_KINDS = ['release', 'release-group'] as const;
export type CoverKind = (typeof COVER_KINDS)[number];

/** The sizes the archive publishes, and the only ones the cache stores. */
export const COVER_SIZES = [250, 500, 1200] as const;
export type CoverSize = (typeof COVER_SIZES)[number];

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCoverKind(value: string): value is CoverKind {
	return (COVER_KINDS as readonly string[]).includes(value);
}

export function isCoverSize(value: number | string): value is CoverSize {
	return (COVER_SIZES as readonly number[]).includes(Number(value));
}

/** MusicBrainz ids are UUIDs; anything else never reaches the archive. */
export function isCoverMbid(value: string): boolean {
	return MBID.test(value);
}

function coverUrl(kind: CoverKind, mbid: string, size: CoverSize): string {
	return `/api/music/cover/${kind}/${encodeURIComponent(mbid)}/${size}`;
}

/** Artwork for a release group — the album identity shown before an import. */
export function releaseGroupCoverUrl(mbid: string, size: CoverSize = 250): string {
	return coverUrl('release-group', mbid, size);
}

/** Artwork for one release — what a library album stores as its edition. */
export function releaseCoverUrl(mbid: string, size: CoverSize = 500): string {
	return coverUrl('release', mbid, size);
}
