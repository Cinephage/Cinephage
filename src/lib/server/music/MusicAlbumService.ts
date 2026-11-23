import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { coreTitle } from './track-matching.js';
import { db } from '#lib/server/db/index.js';
import { albums, artists, downloadQueue, libraries, mediaItems, trackFiles, tracks } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { NotFoundError, ValidationError } from '#lib/errors/index.js';
import { musicProfileService } from './MusicProfileService.js';
import { cancelQueuedDownloads } from '#lib/server/library/library-removal.js';
import { musicBrainz, pickPrimaryRelease } from './musicbrainz.js';
import type { MusicArtistRef, MusicRelease, MusicReleaseGroup, MusicTrack } from './types.js';

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
	/** The album's own ladder; null/omitted inherits the artist, then the library. */
	qualityProfileId?: string | null;
	/**
	 * Track titles to want, when it is not the whole album.
	 *
	 * A playlist import brings the album for the songs on the list; everything
	 * else is written unmonitored so the tracklist is complete but the want is
	 * honest. Omitted means every track.
	 */
	onlyTracks?: string[];
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
	/** Non-null when the album is served by a stream, not files. */
	streamSource: string | null;
	monitored: boolean | null;
	coverPath: string | null;
	/** MusicBrainz release-group genres, cached with the metadata. */
	genres: string[] | null;
	path: string | null;
	/** Library this album belongs to; null for an add that resolved no library. */
	libraryId: string | null;
	/** The album's own profile, null when it inherits the artist/library/default. */
	qualityProfileId: string | null;
	/** Sum of its files' bytes, 0 when nothing is on disk. */
	sizeBytes: number;
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
		monitored: boolean | null;
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
	/** The artist row's ladder; every album added by this run inherits it. */
	qualityProfileId?: string | null;
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
	private ensureArtist(artist: MusicArtistRef, libraryId?: string | null): string {
		const existing = db
			.select({ id: artists.id, libraryId: artists.libraryId })
			.from(artists)
			.where(eq(artists.mbid, artist.mbid))
			.get();
		if (existing) {
			// Give an unhomed artist a library, but never move one that already
			// has a home: adding one album is not a statement about the artist.
			if (libraryId && !existing.libraryId) {
				db.update(artists).set({ libraryId }).where(eq(artists.id, existing.id)).run();
			}
			return existing.id;
		}

		const id = randomUUID();
		db.insert(artists)
			.values({
				id,
				mbid: artist.mbid,
				name: artist.name,
				sortName: artist.sortName ?? null,
				libraryId: libraryId ?? null
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
			const artistId = this.ensureArtist(releaseGroup.artist, input.libraryId);

			const existing = tx
				.select({ id: albums.id, mediaItemId: albums.mediaItemId })
				.from(albums)
				.where(and(eq(albums.mbid, releaseGroup.mbid), eq(albums.artistId, artistId)))
				.get();
			if (existing) {
				const chosen: Partial<typeof albums.$inferInsert> = {};
				if (input.monitored !== undefined) chosen.monitored = input.monitored;
				if (input.qualityProfileId !== undefined) {
					chosen.qualityProfileId = input.qualityProfileId;
				}
				if (Object.keys(chosen).length > 0) {
					tx.update(albums).set(chosen).where(eq(albums.id, existing.id)).run();
				}
				if (input.monitored !== undefined) {
					tx.update(mediaItems)
						.set({ monitored: input.monitored })
						.where(eq(mediaItems.id, existing.mediaItemId))
						.run();
				}
				// Re-adding is normally a no-op, but "just the songs" still has to
				// apply the wanted titles to an album that is already stored.
				if (input.onlyTracks && input.onlyTracks.length > 0) {
					const wanted = new Set(input.onlyTracks.map((title) => coreTitle(title)));
					const rows = tx
						.select({ id: tracks.id, title: tracks.title })
						.from(tracks)
						.where(eq(tracks.albumId, existing.id))
						.all();
					for (const row of rows) {
						tx.update(tracks)
							.set({ monitored: wanted.has(coreTitle(row.title)) })
							.where(eq(tracks.id, row.id))
							.run();
					}
				}
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
				releaseDate: releaseGroup.firstReleaseDate ?? null,
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
					genres: releaseGroup.genres ?? [],
					libraryId: input.libraryId ?? null,
					rootFolderId: input.rootFolderId ?? null,
					monitored: input.monitored ?? true,
					qualityProfileId: input.qualityProfileId ?? null,
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
							duration: track.duration ?? null,
							// Compare works, not strings: the playlist says "Song (Remastered)",
							// the album says "Song", and they are the same song.
							monitored: input.onlyTracks
								? input.onlyTracks.some((title) => coreTitle(title) === coreTitle(track.title))
								: true
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
	 * One album update for everything the PATCH route can set. Validating first
	 * and writing once keeps a bad profile from applying the other fields.
	 */
	patchAlbum(
		albumId: string,
		patch: AlbumMetadataUpdate & { monitored?: boolean; qualityProfileId?: string | null }
	): boolean {
		if (
			patch.qualityProfileId !== undefined &&
			patch.qualityProfileId !== null &&
			!musicProfileService.get(patch.qualityProfileId)
		) {
			throw new ValidationError(`Unknown music quality profile: ${patch.qualityProfileId}`);
		}

		const values: Partial<typeof albums.$inferInsert> = {};
		if (patch.monitored !== undefined) values.monitored = patch.monitored;
		if (patch.qualityProfileId !== undefined) values.qualityProfileId = patch.qualityProfileId;
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
	 * Re-read the release group and the chosen edition from MusicBrainz and
	 * write their facts back. The tracklist is reconciled by disc/track
	 * position so existing rows (and the files attached to them) keep their
	 * ids; an edition that shrank loses only rows with no file.
	 */
	async refreshAlbum(albumId: string): Promise<AlbumDetail> {
		const row = db
			.select({ id: albums.id, mbid: albums.mbid, releaseMbid: albums.releaseMbid })
			.from(albums)
			.where(eq(albums.id, albumId))
			.get();
		if (!row) throw new NotFoundError('Album', albumId);
		if (!row.mbid) throw new ValidationError('This album has no MusicBrainz match to refresh');

		const { group, releases } = await musicBrainz.getReleaseGroupWithReleases(row.mbid);
		const chosen =
			releases.find((release) => release.mbid === row.releaseMbid) ?? pickPrimaryRelease(releases);
		if (!chosen) throw new ValidationError('MusicBrainz has no editions for this album');
		const release = await musicBrainz.getRelease(chosen.mbid);

		this.writeReleaseMetadata(albumId, group, release);
		logger.info({ albumId, releaseMbid: release.mbid }, '[MusicAlbum] album refreshed');
		return this.getAlbum(albumId)!;
	}

	/**
	 * Point the album at a different release group. The row and its files stay;
	 * the new group's identity and its primary edition's tracklist replace the
	 * old facts. The group must belong to this album's artist — moving an album
	 * between artists is an add, not a re-match.
	 */
	async rematchAlbum(albumId: string, releaseGroupMbid: string): Promise<AlbumDetail> {
		const row = db
			.select({
				id: albums.id,
				artistId: albums.artistId,
				artistMbid: artists.mbid,
				mbid: albums.mbid
			})
			.from(albums)
			.innerJoin(artists, eq(albums.artistId, artists.id))
			.where(eq(albums.id, albumId))
			.get();
		if (!row) throw new NotFoundError('Album', albumId);
		if (row.mbid === releaseGroupMbid) {
			throw new ValidationError("That is already this album's match");
		}

		const { group, releases } = await musicBrainz.getReleaseGroupWithReleases(releaseGroupMbid);
		if (row.artistMbid && group.artist.mbid !== row.artistMbid) {
			throw new ValidationError(
				`That release group belongs to ${group.artist.name}, not this album's artist`
			);
		}
		const chosen = pickPrimaryRelease(releases);
		if (!chosen) throw new ValidationError('That release group has no editions');
		const release = await musicBrainz.getRelease(chosen.mbid);

		const clash = db
			.select({ id: albums.id })
			.from(albums)
			.where(and(eq(albums.mbid, group.mbid), eq(albums.artistId, row.artistId)))
			.get();
		if (clash && clash.id !== albumId) {
			throw new ValidationError('Another album in this library already has that match');
		}

		this.writeReleaseMetadata(albumId, group, release, { resetCover: true });
		logger.info(
			{ albumId, mbid: group.mbid, releaseMbid: release.mbid },
			'[MusicAlbum] album re-matched'
		);
		return this.getAlbum(albumId)!;
	}

	/** Write the group/edition facts and reconcile the tracklist in one place. */
	private writeReleaseMetadata(
		albumId: string,
		group: MusicReleaseGroup,
		release: MusicRelease,
		options: { resetCover?: boolean } = {}
	): void {
		const row = db
			.select({ mediaItemId: albums.mediaItemId })
			.from(albums)
			.where(eq(albums.id, albumId))
			.get();
		if (!row) throw new NotFoundError('Album', albumId);

		db.transaction((tx) => {
			tx.update(albums)
				.set({
					mbid: group.mbid,
					releaseMbid: release.mbid,
					title: group.title,
					year: group.year ?? release.year ?? null,
				releaseDate: group.firstReleaseDate ?? null,
					primaryType: group.primaryType ?? null,
					secondaryTypes: group.secondaryTypes,
					genres: group.genres ?? [],
					status: release.status ?? null,
					labelName: release.labelName ?? null,
					catalogNumber: release.catalogNumber ?? null,
					barcode: release.barcode ?? null,
					country: release.country ?? null,
					mediaCount: release.mediaCount,
					trackCount: release.trackCount,
					duration: release.duration,
					...(options.resetCover ? { coverPath: null } : {}),
					refreshedAt: new Date().toISOString()
				})
				.where(eq(albums.id, albumId))
				.run();

			const identity = tx
				.select({ providerRefs: mediaItems.providerRefs })
				.from(mediaItems)
				.where(eq(mediaItems.id, row.mediaItemId))
				.get();
			tx.update(mediaItems)
				.set({
					title: group.title,
					year: group.year ?? release.year ?? null,
					providerRefs: { ...(identity?.providerRefs ?? {}), musicbrainz: group.mbid }
				})
				.where(eq(mediaItems.id, row.mediaItemId))
				.run();
		});

		this.reconcileTracklist(albumId, release.tracks);
	}

	/**
	 * Keep track ids stable across a re-read: the same disc/track position is
	 * the same row, so `track_files.track_id` survives. Rows the new edition no
	 * longer has are deleted only when nothing on disk points at them.
	 */
	private reconcileTracklist(albumId: string, nextTracks: MusicTrack[]): void {
		const existing = db
			.select({
				id: tracks.id,
				discNumber: tracks.discNumber,
				trackNumber: tracks.trackNumber,
				hasFile: tracks.hasFile
			})
			.from(tracks)
			.where(eq(tracks.albumId, albumId))
			.all();
		const byPosition = new Map(
			existing.map((track) => [`${track.discNumber ?? 1}:${track.trackNumber ?? 0}`, track])
		);
		const kept = new Set<string>();

		db.transaction((tx) => {
			for (const track of nextTracks) {
				const match = byPosition.get(`${track.discNumber}:${track.trackNumber ?? 0}`);
				if (match) {
					kept.add(match.id);
					tx.update(tracks)
						.set({
							recordingMbid: track.recordingMbid ?? null,
							title: track.title,
							artistCredit: track.artistCredit ?? null,
							position: track.position,
							duration: track.duration ?? null
						})
						.where(eq(tracks.id, match.id))
						.run();
					continue;
				}
				tx.insert(tracks)
					.values({
						albumId,
						recordingMbid: track.recordingMbid ?? null,
						title: track.title,
						artistCredit: track.artistCredit ?? null,
						discNumber: track.discNumber,
						trackNumber: track.trackNumber,
						position: track.position,
						duration: track.duration ?? null
					})
					.run();
			}

			const leftovers = existing.filter((track) => !kept.has(track.id));
			if (leftovers.length === 0) return;
			const referenced = new Set(
				tx
					.select({ trackId: trackFiles.trackId })
					.from(trackFiles)
					.where(
						inArray(
							trackFiles.trackId,
							leftovers.map((track) => track.id)
						)
					)
					.all()
					.flatMap((file) => (file.trackId ? [file.trackId] : []))
			);
			for (const leftover of leftovers) {
				if (leftover.hasFile || referenced.has(leftover.id)) continue;
				tx.delete(tracks).where(eq(tracks.id, leftover.id)).run();
			}
		});

		logger.info(
			{ albumId, tracks: nextTracks.length, kept: kept.size },
			'[MusicAlbum] tracklist reconciled'
		);
	}

	/**
	 * Remove an album and its tracklist. The `media_items` identity row is
	 * deleted with it — that row exists only to carry this album's cross-cutting
	 * links, and leaving it behind would strand them on a subject that no longer
	 * exists. Files on disk are never touched: this is a catalogue write, and
	 * the movie/series delete paths behave the same way.
	 */
	/** Stop anything still downloading for this album before its rows go. */
	async cancelDownloadsForAlbum(albumId: string): Promise<void> {
		const album = db
			.select({ mediaItemId: albums.mediaItemId })
			.from(albums)
			.where(eq(albums.id, albumId))
			.get();
		if (!album) return;
		const rows = db
			.select({
				id: downloadQueue.id,
				downloadClientId: downloadQueue.downloadClientId,
				protocol: downloadQueue.protocol,
				infoHash: downloadQueue.infoHash,
				downloadId: downloadQueue.downloadId
			})
			.from(downloadQueue)
			.where(eq(downloadQueue.mediaItemId, album.mediaItemId))
			.all();
		await cancelQueuedDownloads(rows);
	}

	/** Same, for every album under an artist. */
	async cancelDownloadsForArtist(artistId: string): Promise<void> {
		const mediaItemIds = db
			.select({ mediaItemId: albums.mediaItemId })
			.from(albums)
			.where(eq(albums.artistId, artistId))
			.all()
			.map((row) => row.mediaItemId);
		if (mediaItemIds.length === 0) return;
		const rows = db
			.select({
				id: downloadQueue.id,
				downloadClientId: downloadQueue.downloadClientId,
				protocol: downloadQueue.protocol,
				infoHash: downloadQueue.infoHash,
				downloadId: downloadQueue.downloadId
			})
			.from(downloadQueue)
			.where(inArray(downloadQueue.mediaItemId, mediaItemIds))
			.all();
		await cancelQueuedDownloads(rows);
	}

	/**
	 * Albums whose effective ladder is `profileId`. Effective means the same
	 * album -> artist -> library -> default walk a grab uses, not just the
	 * album's own column.
	 */
	albumIdsForEffectiveProfile(profileId: string): string[] {
		return db
			.select({
				id: albums.id,
				albumProfile: albums.qualityProfileId,
				artistProfile: artists.qualityProfileId,
				libraryProfile: libraries.qualityProfileId
			})
			.from(albums)
			.leftJoin(artists, eq(albums.artistId, artists.id))
			.leftJoin(libraries, eq(albums.libraryId, libraries.id))
			.all()
			.filter(
				(row) =>
					musicProfileService.resolve(
						row.albumProfile,
						row.artistProfile,
						row.libraryProfile
					).id === profileId
			)
			.map((row) => row.id);
	}

	/** The two fields the cover route needs, without the tracklist. */
	getAlbumCoverInfo(
		albumId: string
	): { coverPath: string | null; releaseMbid: string | null; albumPath: string | null } | null {
		const row = db
			.select({ coverPath: albums.coverPath, releaseMbid: albums.releaseMbid, albumPath: albums.path })
			.from(albums)
			.where(eq(albums.id, albumId))
			.get();
		return row ?? null;
	}

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
	listAlbums(
		options: { libraryId?: string | null; artistId?: string | null } = {}
	): AlbumSummary[] {
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
				streamSource: albums.streamSource,
				monitored: albums.monitored,
				coverPath: albums.coverPath,
				genres: albums.genres,
				path: albums.path,
				releaseMbid: albums.releaseMbid,
				libraryId: albums.libraryId,
				qualityProfileId: albums.qualityProfileId,
				sizeBytes: sql<number>`COALESCE(SUM(${trackFiles.sizeBytes}), 0)`
			})
			.from(albums)
			.innerJoin(artists, eq(albums.artistId, artists.id))
			.leftJoin(trackFiles, eq(trackFiles.albumId, albums.id));

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
			.groupBy(albums.id)
			.orderBy(asc(artists.name), asc(albums.year), asc(albums.title))
			.all();

		return rows.map(({ releaseMbid, ...row }) => ({
			...row,
			sizeBytes: Number(row.sizeBytes),
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
				libraryId: albums.libraryId,
				monitored: albums.monitored,
				coverPath: albums.coverPath,
				genres: albums.genres,
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
				hasFile: tracks.hasFile,
				monitored: tracks.monitored
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
			sizeBytes: fileRows.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
			hasCover: Boolean(row.coverPath ?? row.releaseMbid),
			tracks: trackRows,
			files: fileRows
		};
	}
}

export const musicAlbumService = new MusicAlbumService();
