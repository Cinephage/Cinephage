import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '#lib/server/db/index.js';
import { albums, artists, mediaItems, tracks } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { MusicArtistRef, MusicRelease, MusicReleaseGroup } from './types.js';

const logger = createChildLogger({ module: 'MusicAlbumService', logDomain: 'system' });

export interface AddAlbumInput {
	/** The work: one row per release group. */
	releaseGroup: MusicReleaseGroup;
	/** The chosen edition, with its tracklist. */
	release: MusicRelease;
	libraryId?: string | null;
	rootFolderId?: string | null;
	monitored?: boolean;
	coverPath?: string | null;
}

export interface AddAlbumResult {
	albumId: string;
	mediaItemId: string;
	/** false when the album already existed and nothing was written. */
	created: boolean;
}

/**
 * Album-level writes. The album is the subject for acquisition, monitoring and
 * the list view, so it is also the unit that gets a `media_items` identity row
 * (that is what cross-cutting tables reach an album through).
 */
export class MusicAlbumService {
	/**
	 * Insert the artist the release group names, or reuse the row already holding
	 * that MusicBrainz id. Artists are only created as a side effect of adding an
	 * album — there is no standalone artist import yet.
	 */
	private ensureArtist(artist: MusicArtistRef): string {
		const existing = db.select({ id: artists.id }).from(artists).where(eq(artists.mbid, artist.mbid)).get();
		if (existing) return existing.id;

		const id = randomUUID();
		db.insert(artists)
			.values({
				id,
				mbid: artist.mbid,
				name: artist.name,
				sortName: artist.sortName ?? null
			})
			.run();
		return id;
	}

	/**
	 * Add an album from a search result: one `media_items` row, one `albums` row,
	 * and the release's tracklist. Idempotent on `(release-group mbid, artist)`, so
	 * adding the same album twice returns the existing row instead of duplicating.
	 */
	addAlbum(input: AddAlbumInput): AddAlbumResult {
		const { releaseGroup, release } = input;

		const result = db.transaction((tx) => {
			const artistId = this.ensureArtist(releaseGroup.artist);

			const existing = tx
				.select({ id: albums.id, mediaItemId: albums.mediaItemId })
				.from(albums)
				.where(and(eq(albums.mbid, releaseGroup.mbid), eq(albums.artistId, artistId)))
				.get();
			if (existing) {
				return { albumId: existing.id, mediaItemId: existing.mediaItemId, created: false } satisfies AddAlbumResult;
			}

			const mediaItemId = randomUUID();
			tx.insert(mediaItems)
				.values({
					id: mediaItemId,
					kind: 'album',
					title: releaseGroup.title,
					year: releaseGroup.year ?? null,
					libraryId: input.libraryId ?? null,
					rootFolderId: input.rootFolderId ?? null,
					monitored: input.monitored ?? true,
					providerRefs: { musicbrainz: releaseGroup.mbid }
				})
				.run();

			const albumId = randomUUID();
			tx.insert(albums)
				.values({
					id: albumId,
					mediaItemId,
					artistId,
					mbid: releaseGroup.mbid,
					releaseMbid: release.mbid,
					title: releaseGroup.title,
					year: releaseGroup.year ?? release.year ?? null,
					primaryType: releaseGroup.primaryType ?? null,
					secondaryTypes: releaseGroup.secondaryTypes,
					status: release.status ?? null,
					labelName: release.labelName ?? null,
					catalogNumber: release.catalogNumber ?? null,
					barcode: release.barcode ?? null,
					country: release.country ?? null,
					mediaCount: release.mediaCount,
					trackCount: release.trackCount,
					duration: release.duration,
					coverPath: input.coverPath ?? null,
					libraryId: input.libraryId ?? null,
					rootFolderId: input.rootFolderId ?? null,
					monitored: input.monitored ?? true,
					hasFile: false
				})
				.run();

			if (release.tracks.length > 0) {
				tx.insert(tracks)
					.values(
						release.tracks.map((track) => ({
							id: randomUUID(),
							albumId,
							recordingMbid: track.recordingMbid ?? null,
							title: track.title,
							artistCredit: track.artistCredit ?? null,
							discNumber: track.discNumber,
							trackNumber: track.trackNumber,
							position: track.position,
							duration: track.duration ?? null
						}))
					)
					.run();
			}

			return { albumId, mediaItemId, created: true } satisfies AddAlbumResult;
		});

		logger.info(
			{ albumId: result.albumId, mbid: releaseGroup.mbid, created: result.created },
			'[MusicAlbum] album add'
		);
		return result;
	}
}

export const musicAlbumService = new MusicAlbumService();
