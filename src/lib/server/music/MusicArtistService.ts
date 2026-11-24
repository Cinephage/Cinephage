import { asc, count, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '#lib/server/db/index.js';
import { albums, artists, mediaItems } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { NotFoundError, ValidationError } from '#lib/errors/index.js';
import { musicBrainz, MusicBrainzError, pickPrimaryRelease } from './musicbrainz.js';
import {
	musicAlbumService,
	type AddArtistPolicy,
	type AddAlbumResult
} from './MusicAlbumService.js';
import { musicProfileService } from './MusicProfileService.js';
import {
	artistFilter,
	artistHaving,
	artistOrder,
	pageLimit,
	pageOffset,
	type ArtistListSort,
	type MusicLibraryFilter
} from './library-query.js';
import type { ArtistCardData } from '#lib/components/music/music-card.js';
import type { MusicArtistRef, MusicReleaseGroup } from './types.js';

const logger = createChildLogger({ module: 'MusicArtistService', logDomain: 'system' });

/** Browse pages of 100 release groups; 5 pages = 500, past any realistic discography. */
const MAX_RELEASE_GROUP_PAGES = 5;

export interface AddArtistRequest {
	artist: MusicArtistRef;
	/** Albums to write in this call. Bounded because each one costs ~3 gated requests. */
	limit: number;
	policy: AddArtistPolicy;
}

export interface AddArtistFailure {
	releaseGroupMbid: string;
	title: string;
	error: string;
}

export interface AddArtistResult {
	artistId: string;
	added: number;
	skipped: number;
	/** Albums matching the policy that are left for the next call. */
	remaining: number;
	/** Albums matching the policy in total, including already-stored ones. */
	total: number;
	failures: AddArtistFailure[];
	albums: AddAlbumResult[];
}

/** The artist row as the library surfaces read it (no MusicBrainz round trip). */
export interface ArtistRecord {
	id: string;
	mbid: string | null;
	name: string;
	sortName: string | null;
	disambiguation: string | null;
	artistType: string | null;
	country: string | null;
	genres: string[] | null;
	overview: string | null;
	imagePath: string | null;
	monitored: boolean | null;
	/** Null = inherit the default music quality profile. */
	qualityProfileId: string | null;
	added: string | null;
}

/** One page of the artist list, in the shape every artist card already takes. */
export interface ArtistPage {
	rows: ArtistCardData[];
	total: number;
}

export interface ArtistPageOptions extends MusicLibraryFilter {
	sort?: ArtistListSort;
	offset?: number;
	limit?: number;
}

/**
 * Adding an artist is not one write: it is "browse the discography, apply a
 * policy, then import album by album". Each album costs a few MusicBrainz
 * requests at 1.2 s each, so the work is explicitly batched — the caller gets
 * `remaining` and continues — rather than being silently truncated or parked in
 * one long request that would time out.
 */
export class MusicArtistService {
	/** Every release group an artist owns, up to the page cap. */
	private async browseReleaseGroups(artist: MusicArtistRef): Promise<{
		groups: MusicReleaseGroup[];
		total: number;
	}> {
		const groups: MusicReleaseGroup[] = [];
		let total = 0;

		for (let page = 0; page < MAX_RELEASE_GROUP_PAGES; page += 1) {
			const { releaseGroups, total: reported } = await musicBrainz.getArtistReleaseGroups(
				artist.mbid,
				artist,
				{ limit: 100, offset: page * 100 }
			);
			total = reported;
			groups.push(...releaseGroups);
			if (releaseGroups.length < 100 || groups.length >= total) break;
		}

		return { groups, total };
	}

	/** Reuse the artist row if it exists, otherwise create it without albums. */
	private ensureArtistRow(
		artist: MusicArtistRef,
		libraryId?: string | null,
		qualityProfileId?: string | null
	): string {
		const existing = db
			.select({ id: artists.id, libraryId: artists.libraryId })
			.from(artists)
			.where(eq(artists.mbid, artist.mbid))
			.get();
		if (existing) {
			const patch: Partial<typeof artists.$inferInsert> = {};
			// A chosen profile is a statement about this artist; a library is only
			// filled in when the row has no home yet.
			if (qualityProfileId !== undefined && qualityProfileId !== null) {
				patch.qualityProfileId = qualityProfileId;
			}
			if (libraryId && !existing.libraryId) patch.libraryId = libraryId;
			if (Object.keys(patch).length > 0) {
				db.update(artists).set(patch).where(eq(artists.id, existing.id)).run();
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
				libraryId: libraryId ?? null,
				qualityProfileId: qualityProfileId ?? null
			})
			.run();
		return id;
	}

	/**
	 * Update the artist's own fields. Monitoring lives here too, because the
	 * artist flag decides whether a future discography refresh treats unowned
	 * albums as wanted — albums carry their own acquisition flag.
	 */
	updateArtist(
		artistId: string,
		patch: {
			name?: string;
			sortName?: string | null;
			monitored?: boolean;
			qualityProfileId?: string | null;
		}
	): boolean {
		const values: Record<string, unknown> = {};
		if (patch.name !== undefined) values.name = patch.name;
		if (patch.sortName !== undefined) values.sortName = patch.sortName;
		if (patch.monitored !== undefined) values.monitored = patch.monitored;
		if (patch.qualityProfileId !== undefined) values.qualityProfileId = patch.qualityProfileId;
		if (Object.keys(values).length === 0) return false;
		const result = db.update(artists).set(values).where(eq(artists.id, artistId)).run();
		return result.changes > 0;
	}

	/**
	 * Re-read the artist from MusicBrainz. Hand-edited names and sort names are
	 * replaced, which is the point of a refresh: the provider is the source.
	 */
	async refreshArtist(artistId: string): Promise<ArtistRecord> {
		const row = db
			.select({ id: artists.id, mbid: artists.mbid })
			.from(artists)
			.where(eq(artists.id, artistId))
			.get();
		if (!row) throw new NotFoundError('Artist', artistId);
		if (!row.mbid) throw new ValidationError('This artist has no MusicBrainz match to refresh');

		const detail = await musicBrainz.getArtist(row.mbid);
		db.update(artists)
			.set({
				name: detail.name,
				sortName: detail.sortName ?? null,
				disambiguation: detail.disambiguation ?? null,
				artistType: detail.type ?? null,
				country: detail.country ?? null,
				genres: detail.genres,
				refreshedAt: new Date().toISOString()
			})
			.where(eq(artists.id, artistId))
			.run();

		logger.info({ artistId, mbid: row.mbid }, '[MusicArtist] artist refreshed');
		return this.getArtist(artistId)!;
	}

	/**
	 * Point the artist at a different MusicBrainz id. Albums already attached
	 * stay attached and keep their own release-group matches: re-matching an
	 * artist changes the artist identity, not the discography.
	 */
	async rematchArtist(
		artistId: string,
		mbid: string
	): Promise<{ artist: ArtistRecord; albums: number }> {
		const row = db
			.select({ id: artists.id, mbid: artists.mbid })
			.from(artists)
			.where(eq(artists.id, artistId))
			.get();
		if (!row) throw new NotFoundError('Artist', artistId);
		if (row.mbid === mbid) throw new ValidationError("That is already this artist's match");

		const clash = db.select({ id: artists.id }).from(artists).where(eq(artists.mbid, mbid)).get();
		if (clash && clash.id !== artistId) {
			throw new ValidationError('Another artist in this library already has that match');
		}

		const detail = await musicBrainz.getArtist(mbid);
		db.update(artists)
			.set({
				mbid,
				name: detail.name,
				sortName: detail.sortName ?? null,
				disambiguation: detail.disambiguation ?? null,
				artistType: detail.type ?? null,
				country: detail.country ?? null,
				genres: detail.genres,
				refreshedAt: new Date().toISOString()
			})
			.where(eq(artists.id, artistId))
			.run();

		const attached = db
			.select({ id: albums.id })
			.from(albums)
			.where(eq(albums.artistId, artistId))
			.all();
		logger.info(
			{ artistId, mbid, albums: attached.length },
			'[MusicArtist] artist re-matched; attached albums left untouched'
		);
		return { artist: this.getArtist(artistId)!, albums: attached.length };
	}

	/**
	 * Remove an artist and the albums under it. `albums` cascades on the artist
	 * foreign key, but each album's `media_items` identity row does not — those
	 * are deleted explicitly, the same way the single-album path does it. Files
	 * on disk are never touched.
	 */
	deleteArtist(artistId: string): boolean {
		const artist = db
			.select({ id: artists.id })
			.from(artists)
			.where(eq(artists.id, artistId))
			.get();
		if (!artist) return false;

		const owned = db
			.select({ mediaItemId: albums.mediaItemId })
			.from(albums)
			.where(eq(albums.artistId, artistId))
			.all();

		db.transaction((tx) => {
			tx.delete(artists).where(eq(artists.id, artistId)).run();
			for (const album of owned) {
				tx.delete(mediaItems).where(eq(mediaItems.id, album.mediaItemId)).run();
			}
		});
		logger.info({ artistId, albums: owned.length }, '[MusicArtist] artist removed');
		return true;
	}

	/**
	 * Fill in the MusicBrainz fields an artist row is created without.
	 *
	 * `ensureArtist` runs inside a synchronous transaction and only knows the
	 * ref from a release group's credit, so type, country and genres stayed
	 * null — which is why the artist page had nothing to show beside "Type".
	 * One gated lookup fixes the row for good; callers tolerate its absence.
	 */
	async ensureMetadata(artistId: string, mbid: string): Promise<void> {
		const row = db
			.select({
				artistType: artists.artistType,
				country: artists.country,
				genres: artists.genres
			})
			.from(artists)
			.where(eq(artists.id, artistId))
			.get();
		if (!row) return;
		if (row.artistType && row.country && (row.genres?.length ?? 0) > 0) return;

		const detail = await musicBrainz.getArtist(mbid);
		db.update(artists)
			.set({
				artistType: detail.type ?? row.artistType ?? null,
				country: detail.country ?? row.country ?? null,
				genres: detail.genres.length > 0 ? detail.genres : (row.genres ?? null)
			})
			.where(eq(artists.id, artistId))
			.run();
		logger.info(
			{ artistId, genres: detail.genres.length },
			'[MusicArtist] filled MusicBrainz metadata'
		);
	}

	/** One artist row, for the artist page hero and its card. */
	getArtist(artistId: string): ArtistRecord | null {
		return (
			db
				.select({
					id: artists.id,
					mbid: artists.mbid,
					name: artists.name,
					sortName: artists.sortName,
					disambiguation: artists.disambiguation,
					artistType: artists.artistType,
					country: artists.country,
					genres: artists.genres,
					overview: artists.overview,
					imagePath: artists.imagePath,
					monitored: artists.monitored,
					qualityProfileId: artists.qualityProfileId,
					added: artists.added
				})
				.from(artists)
				.where(eq(artists.id, artistId))
				.get() ?? null
		);
	}

	/**
	 * Artist rows for a known set of ids. The library list groups albums by
	 * artist, then asks here for the flags the album rows do not carry
	 * (monitoring, portrait, genres) — one query, not one per artist.
	 */
	listArtists(ids: string[]): ArtistRecord[] {
		if (ids.length === 0) return [];
		return db
			.select({
				id: artists.id,
				mbid: artists.mbid,
				name: artists.name,
				sortName: artists.sortName,
				disambiguation: artists.disambiguation,
				artistType: artists.artistType,
				country: artists.country,
				genres: artists.genres,
				overview: artists.overview,
				imagePath: artists.imagePath,
				monitored: artists.monitored,
				qualityProfileId: artists.qualityProfileId,
				added: artists.added
			})
			.from(artists)
			.where(inArray(artists.id, ids))
			.all();
	}

	/**
	 * One page of the artist list, filtered and sorted in SQL. The page used to
	 * receive every artist and narrow in the browser; this is the query behind
	 * the window it shows instead.
	 */
	listArtistsPage(options: ArtistPageOptions = {}): ArtistPage {
		const defaultProfileId = musicProfileService.defaultQualityProfile().id;
		const where = artistFilter(options, defaultProfileId);
		const having = artistHaving(options);

		const matching = db
			.select({ id: artists.id })
			.from(artists)
			.innerJoin(albums, eq(albums.artistId, artists.id))
			.where(where)
			.groupBy(artists.id)
			.having(having)
			.as('matching_artists');

		const total = db.select({ value: count() }).from(matching).get()?.value ?? 0;

		const rows = db
			.select({
				id: artists.id,
				name: artists.name,
				mbid: artists.mbid,
				monitored: artists.monitored,
				albumCount: count(albums.id),
				inLibraryCount: sql<number>`sum(case when ${albums.hasFile} = 1 then 1 else 0 end)`,
				coverAlbumId:
					sql<string | null>`(select a2.id from albums a2 where a2.artist_id = ${artists.id} and (a2.cover_path is not null or a2.release_mbid is not null) order by a2.year, a2.title limit 1)`
			})
			.from(artists)
			.innerJoin(albums, eq(albums.artistId, artists.id))
			.where(where)
			.groupBy(artists.id)
			.having(having)
			.orderBy(...artistOrder(options.sort))
			.limit(pageLimit(options.limit))
			.offset(pageOffset(options.offset))
			.all();

		return {
			rows: rows.map((row) => ({
				...row,
				inLibraryCount: Number(row.inLibraryCount)
			})),
			total
		};
	}

	/**
	 * Every artist id matching the list filters. "Select all" and "Monitor all"
	 * mean the filtered shelf, not only the rows already scrolled into view.
	 */
	listArtistIds(options: MusicLibraryFilter = {}): string[] {
		const defaultProfileId = musicProfileService.defaultQualityProfile().id;
		return db
			.select({ id: artists.id })
			.from(artists)
			.innerJoin(albums, eq(albums.artistId, artists.id))
			.where(artistFilter(options, defaultProfileId))
			.groupBy(artists.id)
			.having(artistHaving(options))
			.orderBy(asc(artists.name))
			.all()
			.map((row) => row.id);
	}

	/** The header count. Artists with no album are not part of the music list. */
	countArtists(): number {
		return (
			db
				.select({ value: sql<number>`count(distinct ${artists.id})` })
				.from(artists)
				.innerJoin(albums, eq(albums.artistId, artists.id))
				.get()?.value ?? 0
		);
	}

	/** How much an artist would add, without writing anything — the preview. */
	async preview(
		artist: MusicArtistRef,
		policy: AddArtistPolicy = {}
	): Promise<{
		total: number;
		matched: number;
		alreadyStored: number;
		pending: number;
		byType: Record<string, number>;
	}> {
		const { groups, total } = await this.browseReleaseGroups(artist);
		const matched = musicAlbumService.filterReleaseGroups(groups, policy);
		const stored = musicAlbumService.existingReleaseGroupMbids();

		const byType: Record<string, number> = {};
		for (const group of matched) {
			const key = [group.primaryType ?? 'Album', ...(group.secondaryTypes ?? [])].join(' / ');
			byType[key] = (byType[key] ?? 0) + 1;
		}

		const pending = matched.filter((group) => !stored.has(group.mbid)).length;
		return {
			total,
			matched: matched.length,
			alreadyStored: matched.length - pending,
			pending,
			byType
		};
	}

	/** Add up to `limit` albums that match the policy, oldest first. */
	async addArtist(request: AddArtistRequest): Promise<AddArtistResult> {
		const { artist, policy } = request;
		const limit = Math.max(1, Math.min(request.limit, 25));

		const { groups, total } = await this.browseReleaseGroups(artist);
		const matched = musicAlbumService
			.filterReleaseGroups(groups, policy)
			.sort((a, b) => (a.firstReleaseDate ?? '9999').localeCompare(b.firstReleaseDate ?? '9999'));

		const artistId = this.ensureArtistRow(artist, policy.libraryId, policy.qualityProfileId);
		const stored = musicAlbumService.existingReleaseGroupMbids(artistId);
		const pending = matched.filter((group) => !stored.has(group.mbid));
		const batch = pending.slice(0, limit);

		const albums: AddAlbumResult[] = [];
		const failures: AddArtistFailure[] = [];

		for (const group of batch) {
			try {
				const editions = await musicBrainz.getReleaseGroupReleases(group.mbid);
				const primary = pickPrimaryRelease(editions);
				if (!primary) {
					failures.push({ releaseGroupMbid: group.mbid, title: group.title, error: 'no editions' });
					continue;
				}
				const release = await musicBrainz.getRelease(primary.mbid);
				albums.push(
					musicAlbumService.addAlbum({
						// Browse can omit the credit; the artist being added is the owner.
						releaseGroup: { ...group, artist },
						release,
						libraryId: policy.libraryId ?? null,
						rootFolderId: policy.rootFolderId ?? null,
						monitored: policy.monitored ?? true
					})
				);
			} catch (err) {
				const message = err instanceof MusicBrainzError ? err.message : String(err);
				logger.warn(
					{ releaseGroupMbid: group.mbid, err: message },
					'[MusicArtist] album add failed; continuing with the batch'
				);
				failures.push({ releaseGroupMbid: group.mbid, title: group.title, error: message });
			}
		}

		return {
			artistId,
			added: albums.filter((album) => album.created).length,
			skipped: albums.length - albums.filter((album) => album.created).length,
			remaining: pending.length - batch.length,
			total: matched.length,
			failures,
			albums
		};
	}
}

export const musicArtistService = new MusicArtistService();
