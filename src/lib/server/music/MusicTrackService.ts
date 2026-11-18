import { and, asc, eq } from 'drizzle-orm';
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
export class MusicTrackService {
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
