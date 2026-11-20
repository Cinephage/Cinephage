import { and, asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '#lib/server/db/index.js';
import { albums, artists, mediaItems, trackFiles, tracks } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { ValidationError } from '#lib/errors/index.js';
import { musicProfileService } from './MusicProfileService.js';
import type { MusicArtistRef, MusicRelease, MusicReleaseGroup } from './types.js';

const logger = createChildLogger({ module: 'MusicAlbumService', logDomain: 'system' });

export const DEFAULT_ARTIST_PRIMARY_TYPES = ['Album', 'EP'];
export const DEFAULT_EXCLUDED_SECONDARY_TYPES = [
	'Compilation',
	'Live',
	'Remix',
	'DJ-mix',
	'Interview',
	'Audiobook',
	'Spokenword',
	'Field recording'
];

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

/** One row of the music library list: enough for a card, no tracklist. */
export interface AlbumSummary {
	id: string;
	title: string;
	artistId: string;
	artistName: string;
	/** The artist's MusicBrainz id — links every album surface to the artist page. */
	artistMbid: string | null;
	year: number | null;
	trackCount: number | null;
	/** Total runtime in seconds, summed across the tracklist. */
	duration: number | null;
	hasFile: boolean | null;
	monitored: boolean | null;
	coverPath: string | null;
	path: string | null;
	/** True when the cover can be served: a local file, or a MusicBrainz edition to proxy. */
	hasCover: boolean;
}

/** One audio file on disk, as the album page's Files block lists it. */
export interface AlbumFile {
	id: string;
	trackId: string | null;
	trackTitle: string | null;
	relativePath: string;
	sizeBytes: number | null;
	format: string | null;
	bitrateKbps: number | null;
	bitDepth: number | null;
	sampleRateHz: number | null;
	duration: number | null;
}

export interface AlbumMetadataUpdate {
	title?: string;
	year?: number | null;
	primaryType?: string | null;
	labelName?: string | null;
	catalogNumber?: string | null;
	barcode?: string | null;
	country?: string | null;
}

export interface AlbumDetail extends AlbumSummary {
	releaseMbid: string | null;
	mbid: string | null;
	/** Non-null when the album is served by a streaming source, not files. */
	streamSource: string | null;
	/** The album's actual audio files, the way a movie page lists its files. */
	files: AlbumFile[];
	/** Chosen music quality profile; null means the built-in default. */
	qualityProfileId: string | null;
	primaryType: string | null;
	secondaryTypes: string[] | null;
	status: string | null;
	labelName: string | null;
	catalogNumber: string | null;
	barcode: string | null;
	country: string | null;
	mediaCount: number | null;
	duration: number | null;
	tracks: Array<{
		id: string;
		title: string;
		artistCredit: string | null;
		discNumber: number | null;
		trackNumber: number | null;
		position: number | null;
		duration: number | null;
		hasFile: boolean | null;
	}>;
}

export interface AddArtistPolicy {
	/** Release-group primary types to take. Default: Album + EP. */
	primaryTypes?: string[];
	/** Secondary types to skip. Default: Compilation, Live, Remix, DJ-mix, Interview, Audiobook, Spokenword. */
	excludeSecondaryTypes?: string[];
	monitored?: boolean;
	libraryId?: string | null;
	rootFolderId?: string | null;
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
		const existing = db
			.select({ id: artists.id })
			.from(artists)
			.where(eq(artists.mbid, artist.mbid))
			.get();
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
				return {
					albumId: existing.id,
					mediaItemId: existing.mediaItemId,
					created: false
				} satisfies AddAlbumResult;
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

	/**
	 * Which release groups an "add this artist" run should take.
	 *
	 * The defaults are the ones that make a discography useful instead of noisy:
	 * albums and EPs only, no singles by default (an artist can have dozens, and
	 * each is a separate grab), and compilations/live/remix/secondary-type
	 * releases skipped unless asked for. Mixtape/Street is *not* excluded by
	 * default — for hip-hop it is the main body of work.
	 */
	filterReleaseGroups(
		releaseGroups: MusicReleaseGroup[],
		policy: Pick<AddArtistPolicy, 'primaryTypes' | 'excludeSecondaryTypes'>
	): MusicReleaseGroup[] {
		const primary = new Set(policy.primaryTypes ?? DEFAULT_ARTIST_PRIMARY_TYPES);
		const excluded = new Set(policy.excludeSecondaryTypes ?? DEFAULT_EXCLUDED_SECONDARY_TYPES);
		return releaseGroups.filter((group) => {
			if (!primary.has(group.primaryType ?? 'Album')) return false;
			return !(group.secondaryTypes ?? []).some((type) => excluded.has(type));
		});
	}

	/** Release-group ids already stored, so a re-run does not re-fetch them. */
	existingReleaseGroupMbids(artistId?: string): Set<string> {
		const rows = (
			artistId
				? db.select({ mbid: albums.mbid }).from(albums).where(eq(albums.artistId, artistId))
				: db.select({ mbid: albums.mbid }).from(albums)
		).all();
		return new Set(rows.flatMap((row) => (row.mbid ? [row.mbid] : [])));
	}

	/**
	 * Flip an album's monitored flag. Returns false when the id is unknown, so
	 * the route can answer 404 instead of pretending it updated something.
	 */
	setMonitored(albumId: string, monitored: boolean): boolean {
		const result = db.update(albums).set({ monitored }).where(eq(albums.id, albumId)).run();
		return result.changes > 0;
	}

	/**
	 * The album's quality ladder. `null` is a real value — "use the default" —
	 * and an unknown id is rejected instead of being stored and silently
	 * ignored at search time.
	 */
	setQualityProfile(albumId: string, profileId: string | null): boolean {
		if (profileId !== null && !musicProfileService.get(profileId)) {
			throw new ValidationError(`Unknown music quality profile: ${profileId}`);
		}

		const result = db
			.update(albums)
			.set({ qualityProfileId: profileId })
			.where(eq(albums.id, albumId))
			.run();
		return result.changes > 0;
	}

	/**
	 * Edit the metadata a person can actually know better than MusicBrainz:
	 * the release title and its edition facts. Identifiers (MBIDs) are not here
	 * — changing those is a re-match, not an edit.
	 */
	updateMetadata(albumId: string, patch: AlbumMetadataUpdate): boolean {
		const values: Partial<typeof albums.$inferInsert> = {};

		if (patch.title !== undefined) {
			const title = patch.title.trim();
			if (!title) throw new ValidationError('Album title cannot be empty');
			values.title = title;
		}
		if (patch.year !== undefined) values.year = patch.year;
		if (patch.primaryType !== undefined) values.primaryType = patch.primaryType;
		if (patch.labelName !== undefined) values.labelName = patch.labelName;
		if (patch.catalogNumber !== undefined) values.catalogNumber = patch.catalogNumber;
		if (patch.barcode !== undefined) values.barcode = patch.barcode;
		if (patch.country !== undefined) values.country = patch.country;

		if (Object.keys(values).length === 0) return false;

		const result = db.update(albums).set(values).where(eq(albums.id, albumId)).run();
		return result.changes > 0;
	}

	/**
	 * Remove an album and its tracklist. The `media_items` identity row is
	 * deleted with it — that row exists only to carry this album's cross-cutting
	 * links, and leaving it behind would strand them on a subject that no longer
	 * exists. Files on disk are never touched: this is a catalogue write, and
	 * the movie/series delete paths behave the same way.
	 */
	deleteAlbum(albumId: string): boolean {
		const row = db
			.select({ mediaItemId: albums.mediaItemId })
			.from(albums)
			.where(eq(albums.id, albumId))
			.get();
		if (!row) return false;

		db.transaction((tx) => {
			tx.delete(albums).where(eq(albums.id, albumId)).run();
			tx.delete(mediaItems).where(eq(mediaItems.id, row.mediaItemId)).run();
		});
		logger.info({ albumId }, '[MusicAlbum] album removed');
		return true;
	}

	/**
	 * Albums for the library list, artist-major then chronological. `artistId`
	 * narrows it to one artist's discography for the artist page.
	 */
	listAlbums(options: { libraryId?: string | null; artistId?: string | null } = {}): AlbumSummary[] {
		const base = db
			.select({
				id: albums.id,
				title: albums.title,
				artistId: albums.artistId,
				artistName: artists.name,
				artistMbid: artists.mbid,
				year: albums.year,
				trackCount: albums.trackCount,
				duration: albums.duration,
				hasFile: albums.hasFile,
				monitored: albums.monitored,
				coverPath: albums.coverPath,
				path: albums.path,
				releaseMbid: albums.releaseMbid
			})
			.from(albums)
			.innerJoin(artists, eq(albums.artistId, artists.id));

		const rows = (
			options.libraryId || options.artistId
				? base.where(
						and(
							options.libraryId ? eq(albums.libraryId, options.libraryId) : undefined,
							options.artistId ? eq(albums.artistId, options.artistId) : undefined
						)
					)
				: base
		)
			.orderBy(asc(artists.name), asc(albums.year), asc(albums.title))
			.all();

		return rows.map(({ releaseMbid, ...row }) => ({
			...row,
			hasCover: Boolean(row.coverPath ?? releaseMbid)
		}));
	}

	/** One album with its tracklist, or null when the id is unknown. */
	getAlbum(albumId: string): AlbumDetail | null {
		const row = db
			.select({
				id: albums.id,
				title: albums.title,
				artistId: albums.artistId,
				artistName: artists.name,
				artistMbid: artists.mbid,
				year: albums.year,
				trackCount: albums.trackCount,
				hasFile: albums.hasFile,
				streamSource: albums.streamSource,
				qualityProfileId: albums.qualityProfileId,
				monitored: albums.monitored,
				coverPath: albums.coverPath,
				path: albums.path,
				releaseMbid: albums.releaseMbid,
				mbid: albums.mbid,
				primaryType: albums.primaryType,
				secondaryTypes: albums.secondaryTypes,
				status: albums.status,
				labelName: albums.labelName,
				catalogNumber: albums.catalogNumber,
				barcode: albums.barcode,
				country: albums.country,
				mediaCount: albums.mediaCount,
				duration: albums.duration
			})
			.from(albums)
			.innerJoin(artists, eq(albums.artistId, artists.id))
			.where(eq(albums.id, albumId))
			.get();
		if (!row) return null;

		const trackRows = db
			.select({
				id: tracks.id,
				title: tracks.title,
				artistCredit: tracks.artistCredit,
				discNumber: tracks.discNumber,
				trackNumber: tracks.trackNumber,
				position: tracks.position,
				duration: tracks.duration,
				hasFile: tracks.hasFile
			})
			.from(tracks)
			.where(eq(tracks.albumId, albumId))
			.orderBy(asc(tracks.position))
			.all();

		const fileRows = db
			.select({
				id: trackFiles.id,
				trackId: trackFiles.trackId,
				trackTitle: tracks.title,
				relativePath: trackFiles.relativePath,
				sizeBytes: trackFiles.sizeBytes,
				format: trackFiles.format,
				bitrateKbps: trackFiles.bitrateKbps,
				bitDepth: trackFiles.bitDepth,
				sampleRateHz: trackFiles.sampleRateHz,
				duration: trackFiles.duration
			})
			.from(trackFiles)
			.leftJoin(tracks, eq(trackFiles.trackId, tracks.id))
			.where(eq(trackFiles.albumId, albumId))
			.all();

		return {
			...row,
			hasCover: Boolean(row.coverPath ?? row.releaseMbid),
			tracks: trackRows,
			files: fileRows
		};
	}
}

export const musicAlbumService = new MusicAlbumService();
