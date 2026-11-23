/**
 * The music detail pages, one loader per entity with two providers behind it.
 *
 * A tile can come from two places: MusicBrainz (the library's identity — an
 * MBID, a tracklist, a person's discography) or Deezer (everything Discover
 * browses). They are not interchangeable: MusicBrainz allows one request per
 * second, so a Deezer tile that resolved through it cost 2.8–3.4 s per click,
 * measured. So the loader answers with the provider the tile came from, and
 * maps both onto one page shape — the pages render a view model, not a
 * provider's payload.
 *
 * Identity stays lazy: a Deezer page carries no MBID, and the one action that
 * needs it (adding to the library) resolves it then, behind a spinner.
 */

import { error } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, artists } from '#lib/server/db/schema.js';
import { musicBrainz, pickPrimaryRelease } from './musicbrainz.js';
import { musicAlbumService } from './MusicAlbumService.js';
import { deezer, pickImage, type DeezerAlbum } from '#lib/server/catalog/deezerApi.js';
import { cachedByKey } from './pageCache.js';
import { deriveFeaturedArtists } from '#lib/components/music/music-card.js';
import type { MusicRelease } from './types.js';

export const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEEZER_ID_RE = /^deezer-(album|artist)-(\d+)$/;

export type MusicProvider = 'musicbrainz' | 'deezer';

export interface MusicPageArtistRef {
	mbid: string | null;
	deezerId: number | null;
	name: string;
}

export interface MusicAlbumPageData {
	provider: MusicProvider;
	group: {
		mbid: string | null;
		deezerId: number | null;
		title: string;
		primaryType: string | null;
		secondaryTypes: string[];
		firstReleaseDate: string | null;
		year: number | null;
		artist: MusicPageArtistRef;
	};
	release: {
		labelName: string | null;
		catalogNumber: string | null;
		barcode: string | null;
		country: string | null;
		status: string | null;
		year: number | null;
		mediaCount: number;
		trackCount: number;
		duration: number;
		tracks: Array<{
			title: string;
			artistCredit: string | null;
			discNumber: number;
			trackNumber: number | null;
			duration: number | null;
		}>;
	} | null;
	libraryAlbumId: string | null;
	/** The stored album's file state; null when the album is not in the library. */
	libraryAlbumHasFile: boolean | null;
	featured: string[];
	/** Provider artwork. Null on a MusicBrainz album: the page falls back to
	 *  the Cover Art Archive url it derives from the MBID. */
	artworkUrl: string | null;
}

export interface MusicArtistReleaseGroup {
	mbid: string | null;
	deezerId: number | null;
	title: string;
	primaryType: string | null;
	secondaryTypes: string[];
	year: number | null;
	artworkUrl: string | null;
}

export interface MusicArtistPageData {
	provider: MusicProvider;
	artist: {
		mbid: string | null;
		deezerId: number | null;
		name: string;
		disambiguation: string | null;
		type: string | null;
		country: string | null;
		genres: string[];
	};
	releaseGroups: MusicArtistReleaseGroup[];
	storedMbids: string[];
	artworkUrl: string | null;
}

function yearOf(date: string | undefined | null): number | null {
	if (!date) return null;
	const year = Number(date.slice(0, 4));
	return Number.isFinite(year) && year > 0 ? year : null;
}

/** Deezer's own type vocabulary, mapped onto the MusicBrainz one the cards read. */
export function deezerPrimaryType(album: DeezerAlbum): string {
	const type = album.record_type;
	if (type === 'single' || type === 'ep') return type === 'ep' ? 'EP' : 'Single';
	if (type === 'compile') return 'Compilation';
	return 'Album';
}

/**
 * A library album already in the collection, found without an MBID.
 *
 * Deezer ids and MusicBrainz ids have no relation, so the only bridge is the
 * pair a person sees: the album's title and its credited artist. Exact
 * (case-insensitive) on both, so a deluxe edition is not mistaken for the
 * album it extends.
 */
async function findStoredAlbum(
	title: string,
	artistName: string
): Promise<{ id: string; hasFile: boolean | null } | null> {
	if (!title.trim() || !artistName.trim()) return null;
	try {
		const rows = await db
			.select({ id: albums.id, hasFile: albums.hasFile })
			.from(albums)
			.innerJoin(artists, eq(albums.artistId, artists.id))
			.where(
				and(
					sql`lower(${albums.title}) = ${title.trim().toLowerCase()}`,
					sql`lower(${artists.name}) = ${artistName.trim().toLowerCase()}`
				)
			)
			.limit(1);
		return rows[0] ?? null;
	} catch {
		return null;
	}
}

export function mapDeezerAlbum(
	album: DeezerAlbum,
	libraryAlbumId: string | null,
	libraryAlbumHasFile: boolean | null = null
): MusicAlbumPageData {
	const tracks = album.tracks?.data ?? [];
	const artistName = album.artist?.name ?? '';
	const contributors = (album.contributors ?? [])
		.map((contributor) => contributor.name?.trim() ?? '')
		.filter((name) => name !== '' && name !== artistName);
	return {
		provider: 'deezer',
		group: {
			mbid: null,
			deezerId: album.id,
			title: album.title,
			primaryType: deezerPrimaryType(album),
			secondaryTypes: [],
			firstReleaseDate: album.release_date ?? null,
			year: yearOf(album.release_date),
			artist: { mbid: null, deezerId: album.artist?.id ?? null, name: artistName }
		},
		release: {
			labelName: album.label || null,
			catalogNumber: null,
			barcode: album.upc || null,
			country: null,
			status: null,
			year: yearOf(album.release_date),
			mediaCount: 1,
			trackCount: album.nb_tracks ?? tracks.length,
			duration: album.duration ?? tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0),
			tracks: tracks.map((track, index) => ({
				title: track.title,
				artistCredit: track.artist?.name ?? null,
				discNumber: track.disk_number ?? 1,
				trackNumber: track.track_position ?? index + 1,
				duration: track.duration ?? null
			}))
		},
		libraryAlbumId,
		libraryAlbumHasFile,
		featured: [...new Set(contributors)],
		artworkUrl: pickImage(album.cover_big, album.cover_xl, album.cover_medium)
	};
}

async function loadAlbumFromDeezer(id: number, rawId: string): Promise<MusicAlbumPageData> {
	return cachedByKey(`album:${rawId}`, async () => {
		const album = await deezer.album(id);
		if (!album) throw error(404, 'Album not found on Deezer');
		const stored = await findStoredAlbum(album.title, album.artist?.name ?? '');
		return mapDeezerAlbum(album, stored?.id ?? null, stored?.hasFile ?? null);
	});
}

async function loadAlbumFromMusicBrainz(mbid: string): Promise<MusicAlbumPageData> {
	return cachedByKey(`album:${mbid}`, async () => {
		// Group and editions arrive together, so the page costs two gated lookups
		// instead of three: the primary edition, then its tracklist.
		let group: Awaited<ReturnType<typeof musicBrainz.getReleaseGroupWithReleases>>['group'];
		let release: MusicRelease | null = null;
		try {
			const found = await musicBrainz.getReleaseGroupWithReleases(mbid);
			group = found.group;
			const primary = pickPrimaryRelease(found.releases);
			if (primary) release = await musicBrainz.getRelease(primary.mbid);
		} catch {
			throw error(404, 'Album not found on MusicBrainz');
		}

		const stored = await db.query.albums.findFirst({ where: eq(albums.mbid, mbid) });

		return {
			provider: 'musicbrainz',
			group: {
				mbid: group.mbid,
				deezerId: null,
				title: group.title,
				primaryType: group.primaryType ?? null,
				secondaryTypes: group.secondaryTypes ?? [],
				firstReleaseDate: group.firstReleaseDate ?? null,
				year: group.year ?? null,
				artist: { mbid: group.artist.mbid, deezerId: null, name: group.artist.name }
			},
			release: release
				? {
						labelName: release.labelName ?? null,
						catalogNumber: release.catalogNumber ?? null,
						barcode: release.barcode ?? null,
						country: release.country ?? null,
						status: release.status ?? null,
						year: release.year ?? null,
						mediaCount: release.mediaCount,
						trackCount: release.trackCount,
						duration: release.duration,
						tracks: release.tracks.map((track) => ({
							title: track.title,
							artistCredit: track.artistCredit ?? null,
							discNumber: track.discNumber,
							trackNumber: track.trackNumber,
							duration: track.duration ?? null
						}))
					}
				: null,
			libraryAlbumId: stored?.id ?? null,
			libraryAlbumHasFile: stored?.hasFile ?? null,
			featured: deriveFeaturedArtists(
				(release?.tracks ?? []).map((track) => track.artistCredit ?? null),
				group.artist.name
			),
			artworkUrl: null
		} satisfies MusicAlbumPageData;
	});
}

/** `/discover/music/<id>`: an MBID, or `deezer-album-<id>` from a browse row. */
export async function loadAlbumPage(id: string): Promise<MusicAlbumPageData> {
	const deezerId = DEEZER_ID_RE.exec(id);
	if (deezerId) {
		if (deezerId[1] !== 'album') throw error(404, 'Not an album id');
		return loadAlbumFromDeezer(Number(deezerId[2]), id);
	}
	if (!MBID_RE.test(id)) throw error(400, 'Invalid album id');
	return loadAlbumFromMusicBrainz(id);
}

async function loadArtistFromDeezer(id: number, rawId: string): Promise<MusicArtistPageData> {
	return cachedByKey(`artist:${rawId}`, async () => {
		const artist = await deezer.artist(id);
		if (!artist) throw error(404, 'Artist not found on Deezer');
		// Discography and header arrive from two endpoints; one owns the name.
		const albums = await deezer.artistAlbums(id, 100);
		return {
			provider: 'deezer',
			artist: {
				mbid: null,
				deezerId: artist.id,
				name: artist.name,
				disambiguation: artist.nb_album ? `${artist.nb_album} releases` : null,
				type: null,
				country: null,
				genres: []
			},
			releaseGroups: albums.map((album) => ({
				mbid: null,
				deezerId: album.id,
				title: album.title,
				primaryType: deezerPrimaryType(album),
				secondaryTypes: [],
				year: yearOf(album.release_date),
				artworkUrl: pickImage(album.cover_big, album.cover_medium)
			})),
			storedMbids: [],
			artworkUrl: pickImage(artist.picture_big, artist.picture_xl, artist.picture_medium)
		} satisfies MusicArtistPageData;
	});
}

async function loadArtistFromMusicBrainz(mbid: string): Promise<MusicArtistPageData> {
	return cachedByKey(`artist:${mbid}`, async () => {
		let artist;
		try {
			artist = await musicBrainz.getArtist(mbid);
		} catch {
			throw error(404, 'Artist not found on MusicBrainz');
		}

		// One page of 100 release groups covers any realistic discography the page
		// needs; deeper browsing belongs to the add-artist flow, not this page.
		let releaseGroups: Awaited<
			ReturnType<typeof musicBrainz.getArtistReleaseGroups>
		>['releaseGroups'] = [];
		try {
			({ releaseGroups } = await musicBrainz.getArtistReleaseGroups(
				mbid,
				{ mbid, name: artist.name },
				{ limit: 100 }
			));
		} catch {
			// The page still shows the artist header.
		}

		return {
			provider: 'musicbrainz',
			artist: {
				mbid,
				deezerId: null,
				name: artist.name,
				disambiguation: artist.disambiguation ?? null,
				type: artist.type ?? null,
				country: artist.country ?? null,
				genres: artist.genres ?? []
			},
			releaseGroups: releaseGroups.map((group) => ({
				mbid: group.mbid,
				deezerId: null,
				title: group.title,
				primaryType: group.primaryType ?? null,
				secondaryTypes: group.secondaryTypes ?? [],
				year: group.year ?? null,
				artworkUrl: null
			})),
			storedMbids: [...musicAlbumService.existingReleaseGroupMbids()],
			artworkUrl: null
		} satisfies MusicArtistPageData;
	});
}

/** `/discover/music/artist/<id>`: an MBID, or `deezer-artist-<id>`. */
export async function loadArtistPage(id: string): Promise<MusicArtistPageData> {
	const deezerId = DEEZER_ID_RE.exec(id);
	if (deezerId) {
		if (deezerId[1] !== 'artist') throw error(404, 'Not an artist id');
		return loadArtistFromDeezer(Number(deezerId[2]), id);
	}
	if (!MBID_RE.test(id)) throw error(400, 'Invalid artist id');
	return loadArtistFromMusicBrainz(id);
}

/** The page an album row opens: an MBID when one exists, else its Deezer id. */
export function albumPageHref(ref: { mbid?: string | null; deezerId?: number | null }): string | null {
	if (ref.mbid) return `/discover/music/${ref.mbid}`;
	if (typeof ref.deezerId === 'number') return `/discover/music/deezer-album-${ref.deezerId}`;
	return null;
}

/** The page an artist row opens: an MBID when one exists, else its Deezer id. */
export function artistPageHref(ref: { mbid?: string | null; deezerId?: number | null }): string | null {
	if (ref.mbid) return `/discover/music/artist/${ref.mbid}`;
	if (typeof ref.deezerId === 'number') return `/discover/music/artist/deezer-artist-${ref.deezerId}`;
	return null;
}