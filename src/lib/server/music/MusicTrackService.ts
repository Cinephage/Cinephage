import { and, asc, count, eq, inArray, like, or } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, artists, tracks } from '#lib/server/db/schema.js';

/** One song row: the track plus the album and artist it belongs to. */
export interface TrackRow {
	id: string;
	albumId: string;
	albumTitle: string;
	artistId: string;
	artistName: string;
	title: string;
	artistCredit: string | null;
	discNumber: number | null;
	trackNumber: number | null;
	position: number | null;
	duration: number | null;
	explicit: boolean | null;
	hasFile: boolean | null;
}

/**
 * Song-level reads.
 *
 * Albums are what gets acquired, but "where is that track" is a real question
 * in a music library — the same way an episode is searchable without opening
 * its season. This is a read-only projection over the tracklist; nothing here
 * writes, and a track never becomes an acquisition subject of its own.
 */
export interface TrackPageOptions {
	q?: string;
	file?: 'all' | 'downloaded' | 'missing';
	libraryId?: string | null;
	artistId?: string | null;
	/** A profile-scoped set, resolved by the caller; empty means no rows. */
	albumIds?: string[];
	sort?: 'title-asc' | 'artist-asc' | 'album-asc' | 'duration-desc';
	offset?: number;
	limit?: number;
}

export class MusicTrackService {
	/** Counts for the page header, without loading a row. */
	countTracks(): number {
		return db.select({ value: count() }).from(tracks).get()?.value ?? 0;
	}

	/**
	 * One page of songs, filtered and sorted in SQL. The library list renders a
	 * window at a time; this is the query behind that window.
	 */
	listTracksPage(options: TrackPageOptions = {}): { rows: TrackRow[]; total: number } {
		const conditions = [
			options.albumIds ? inArray(tracks.albumId, options.albumIds) : undefined,
			options.libraryId ? eq(albums.libraryId, options.libraryId) : undefined,
			options.artistId ? eq(albums.artistId, options.artistId) : undefined,
			options.file === 'downloaded'
				? eq(tracks.hasFile, true)
				: options.file === 'missing'
					? eq(tracks.hasFile, false)
					: undefined
		];
		for (const needle of (options.q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)) {
			const pattern = `%${needle}%`;
			conditions.push(
				or(
					like(tracks.title, pattern),
					like(albums.title, pattern),
					like(artists.name, pattern)
				)!
			);
		}
		const where = conditions.filter(Boolean).length > 0 ? and(...conditions.filter(Boolean)) : undefined;

		const total =
			db
				.select({ value: count() })
				.from(tracks)
				.innerJoin(albums, eq(tracks.albumId, albums.id))
				.innerJoin(artists, eq(albums.artistId, artists.id))
				.where(where)
				.get()?.value ?? 0;

		const order =
			options.sort === 'artist-asc'
				? [asc(artists.name), asc(albums.title), asc(tracks.position)]
				: options.sort === 'album-asc'
					? [asc(albums.title), asc(tracks.position)]
					: options.sort === 'duration-desc'
						? [asc(albums.title), asc(tracks.position)]
						: [asc(tracks.title), asc(artists.name)];

		const rows = db
			.select({
				id: tracks.id,
				albumId: tracks.albumId,
				albumTitle: albums.title,
				artistId: albums.artistId,
				artistName: artists.name,
				title: tracks.title,
				artistCredit: tracks.artistCredit,
				discNumber: tracks.discNumber,
				trackNumber: tracks.trackNumber,
				position: tracks.position,
				duration: tracks.duration,
				explicit: tracks.explicit,
				hasFile: tracks.hasFile
			})
			.from(tracks)
			.innerJoin(albums, eq(tracks.albumId, albums.id))
			.innerJoin(artists, eq(albums.artistId, artists.id))
			.where(where)
			.orderBy(...order)
			.limit(options.limit ?? 90)
			.offset(options.offset ?? 0)
			.all();

		return { rows, total };
	}

	listTracks(options: { libraryId?: string | null; artistId?: string | null } = {}): TrackRow[] {
		const base = db
			.select({
				id: tracks.id,
				albumId: tracks.albumId,
				albumTitle: albums.title,
				artistId: albums.artistId,
				artistName: artists.name,
				title: tracks.title,
				artistCredit: tracks.artistCredit,
				discNumber: tracks.discNumber,
				trackNumber: tracks.trackNumber,
				position: tracks.position,
				duration: tracks.duration,
				explicit: tracks.explicit,
				hasFile: tracks.hasFile
			})
			.from(tracks)
			.innerJoin(albums, eq(tracks.albumId, albums.id))
			.innerJoin(artists, eq(albums.artistId, artists.id));

		const conditions = [
			options.libraryId ? eq(albums.libraryId, options.libraryId) : undefined,
			options.artistId ? eq(albums.artistId, options.artistId) : undefined
		].filter(Boolean);

		return base
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(
				asc(artists.name),
				asc(albums.year),
				asc(albums.title),
				asc(tracks.discNumber),
				asc(tracks.position)
			)
			.all();
	}
}

export const musicTrackService = new MusicTrackService();
