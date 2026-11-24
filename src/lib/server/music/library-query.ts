import { and, asc, count, desc, eq, exists, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, artists, libraries, trackFiles } from '#lib/server/db/schema.js';

/**
 * The query vocabulary shared by the music library's lists.
 *
 * Albums, artists and the Songs tab all narrow by the same filters — a search
 * needle, file state, monitoring, library and the effective quality profile —
 * so the WHERE/ORDER rules live here once. The services own their SELECT shapes;
 * this module owns what "missing", "downloaded" and "this profile" mean in SQL.
 */

export type LibraryFileFilter = 'all' | 'downloaded' | 'missing';
export type LibraryMonitorFilter = 'all' | 'monitored' | 'unmonitored';

export type AlbumListSort =
	| 'artist-asc'
	| 'title-asc'
	| 'year-desc'
	| 'year-asc'
	| 'tracks-desc'
	| 'size-desc'
	| 'size-asc';

export type ArtistListSort = 'name-asc' | 'name-desc' | 'albums-desc' | 'missing-desc';

export interface MusicLibraryFilter {
	q?: string;
	file?: LibraryFileFilter;
	monitor?: LibraryMonitorFilter;
	libraryId?: string | null;
	/** The effective profile a grab would use, not only an explicit override. */
	quality?: string | null;
}

/**
 * Music libraries only. A movie library's scoring profile is not a music ladder,
 * so it must not answer the profile question for an album that points at it.
 */
export const musicLibraryJoin = and(
	eq(albums.libraryId, libraries.id),
	eq(libraries.mediaType, 'music')
)!;

/**
 * The ladder a grab would actually use: album → artist → library → default.
 *
 * A deleted profile is cleared from all three columns by
 * `MusicProfileService.remove()`, so there is no dangling-id case to guard.
 */
export function effectiveProfileSql(defaultProfileId: string): SQL<string> {
	return sql<string>`COALESCE(${albums.qualityProfileId}, ${artists.qualityProfileId}, ${libraries.qualityProfileId}, ${defaultProfileId})`;
}

function searchNeedles(q?: string): string[] {
	return (q ?? '')
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
}

function albumSearch(q?: string): SQL | undefined {
	const parts = searchNeedles(q).map((needle) => {
		const pattern = `%${needle}%`;
		return or(like(albums.title, pattern), like(artists.name, pattern))!;
	});
	return parts.length > 0 ? and(...parts) : undefined;
}

/** WHERE for the album list. Requires `albums`, `artists` and `libraries` joined. */
export function albumFilter(
	options: MusicLibraryFilter,
	defaultProfileId: string
): SQL | undefined {
	const conditions = [
		options.libraryId ? eq(albums.libraryId, options.libraryId) : undefined,
		options.quality ? eq(effectiveProfileSql(defaultProfileId), options.quality) : undefined,
		options.monitor === 'monitored'
			? eq(albums.monitored, true)
			: options.monitor === 'unmonitored'
				? eq(albums.monitored, false)
				: undefined,
		// "Missing" is the same set the header counts: no file and no stream.
		// A stream-backed album is playable, so it must not fail this filter.
		options.file === 'downloaded'
			? eq(albums.hasFile, true)
			: options.file === 'missing'
				? and(eq(albums.hasFile, false), isNull(albums.streamSource))
				: undefined,
		albumSearch(options.q)
	].filter((value): value is SQL => Boolean(value));

	return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * WHERE for the artist list. Library and profile both scope through an album, so
 * an artist appears when it owns at least one album that matches — the rule the
 * browser applied before the list moved into SQL.
 */
export function artistFilter(
	options: MusicLibraryFilter,
	defaultProfileId: string
): SQL | undefined {
	const conditions = [
		options.monitor === 'monitored'
			? eq(artists.monitored, true)
			: options.monitor === 'unmonitored'
				? eq(artists.monitored, false)
				: undefined
	].filter((value): value is SQL => Boolean(value));

	for (const needle of searchNeedles(options.q)) {
		conditions.push(like(artists.name, `%${needle}%`));
	}

	if (options.libraryId || options.quality) {
		const scope = db
			.select({ one: sql`1` })
			.from(albums)
			.leftJoin(libraries, musicLibraryJoin)
			.where(
				and(
					eq(albums.artistId, artists.id),
					options.libraryId ? eq(albums.libraryId, options.libraryId) : undefined,
					options.quality
						? eq(effectiveProfileSql(defaultProfileId), options.quality)
						: undefined
				)
			);
		conditions.push(exists(scope));
	}

	return conditions.length > 0 ? and(...conditions) : undefined;
}

/** HAVING for the artist list: file state is a property of the artist's albums. */
export function artistHaving(options: MusicLibraryFilter): SQL | undefined {
	if (options.file === 'downloaded') {
		return sql`sum(case when ${albums.hasFile} = 1 then 1 else 0 end) > 0`;
	}
	if (options.file === 'missing') {
		return sql`sum(case when ${albums.hasFile} = 0 and ${albums.streamSource} is null then 1 else 0 end) > 0`;
	}
	return undefined;
}

export function albumOrder(sort: AlbumListSort = 'artist-asc'): SQL[] {
	switch (sort) {
		case 'title-asc':
			return [asc(albums.title), asc(artists.name)];
		case 'year-desc':
			return [desc(albums.year), asc(artists.name), asc(albums.title)];
		case 'year-asc':
			// A missing year sorts last in ascending order, like the old list.
			return [asc(sql`COALESCE(${albums.year}, 9999)`), asc(artists.name), asc(albums.title)];
		case 'tracks-desc':
			return [desc(albums.trackCount), asc(artists.name), asc(albums.title)];
		case 'size-desc':
			return [
				desc(sql`COALESCE(SUM(${trackFiles.sizeBytes}), 0)`),
				asc(artists.name),
				asc(albums.title)
			];
		case 'size-asc':
			return [
				asc(sql`COALESCE(SUM(${trackFiles.sizeBytes}), 0)`),
				asc(artists.name),
				asc(albums.title)
			];
		default:
			return [asc(artists.name), asc(albums.year), asc(albums.title)];
	}
}

export function artistOrder(sort: ArtistListSort = 'name-asc'): SQL[] {
	switch (sort) {
		case 'name-desc':
			return [desc(artists.name)];
		case 'albums-desc':
			return [desc(count(albums.id)), asc(artists.name)];
		case 'missing-desc':
			return [
				desc(
					sql`sum(case when ${albums.hasFile} = 0 and ${albums.streamSource} is null then 1 else 0 end)`
				),
				asc(artists.name)
			];
		default:
			return [asc(artists.name)];
	}
}

/** Page sizes are bounded at the boundary; the service does not trust the caller. */
export function pageLimit(value?: number): number {
	return Math.min(Math.max(value ?? 90, 1), 180);
}

export function pageOffset(value?: number): number {
	return Math.max(value ?? 0, 0);
}
