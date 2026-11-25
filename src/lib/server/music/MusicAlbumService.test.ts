import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '#lib/server/db/schema.js';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper.js';
import { musicAlbumService } from './MusicAlbumService.js';
import { musicBrainz } from './musicbrainz.js';
import type { MusicRelease, MusicReleaseGroup } from './types.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

const RELEASE_GROUP: MusicReleaseGroup = {
	mbid: 'rg-discovery',
	title: 'Discovery',
	primaryType: 'Album',
	secondaryTypes: [],
	firstReleaseDate: '2001-02-26',
	year: 2001,
	artist: { mbid: 'artist-daft-punk', name: 'Daft Punk', sortName: 'Daft Punk' }
};

const RELEASE: MusicRelease = {
	mbid: 'rel-discovery-jp',
	title: 'Discovery',
	status: 'Official',
	country: 'JP',
	barcode: '4988006788367',
	packaging: 'Jewel Case',
	labelName: 'Virgin',
	catalogNumber: 'VJCP-68283',
	date: '2001-03-10',
	year: 2001,
	mediaCount: 1,
	trackCount: 2,
	duration: 528,
	tracks: [
		{
			recordingMbid: 'rec-1',
			title: 'One More Time',
			artistCredit: 'Daft Punk',
			discNumber: 1,
			trackNumber: 1,
			position: 1,
			duration: 321
		},
		{
			recordingMbid: 'rec-2',
			title: 'Aerodynamic',
			artistCredit: 'Daft Punk',
			discNumber: 1,
			trackNumber: 2,
			position: 2,
			duration: 207
		}
	]
};

beforeEach(() => clearTestDb(testDb));
afterAll(() => destroyTestDb(testDb));

describe('MusicAlbumService.addCatalogAlbum', () => {
	const CATALOG = {
		album: {
			sourceId: '987654',
			title: 'HIGH HONEY DRIP',
			releaseDate: '2024-06-14',
			year: 2024,
			primaryType: 'Single'
		},
		artist: { name: 'Deadfolk Prophet', mbid: null },
		tracks: [
			{ title: 'HIGH HONEY DRIP', duration: 187, discNumber: 1, trackNumber: 1 },
			{ title: 'WHISTLE WHILE THE WORLD BURNS', duration: 201, discNumber: 1, trackNumber: 2 }
		]
	};

	it('stores an album MusicBrainz has no release group for', () => {
		const result = musicAlbumService.addCatalogAlbum(CATALOG);

		expect(result.created).toBe(true);
		const album = testDb.db
			.select()
			.from(schema.albums)
			.where(eq(schema.albums.id, result.albumId))
			.get();
		expect(album).toMatchObject({
			mbid: null,
			releaseMbid: null,
			title: 'HIGH HONEY DRIP',
			year: 2024,
			releaseDate: '2024-06-14',
			primaryType: 'Single',
			trackCount: 2
		});

		const item = testDb.db
			.select()
			.from(schema.mediaItems)
			.where(eq(schema.mediaItems.id, result.mediaItemId))
			.get();
		expect(item?.providerRefs).toEqual({ deezer: '987654' });

		const rows = testDb.db
			.select({ title: schema.tracks.title, position: schema.tracks.position })
			.from(schema.tracks)
			.where(eq(schema.tracks.albumId, result.albumId))
			.all();
		expect(rows).toEqual([
			{ title: 'HIGH HONEY DRIP', position: 1 },
			{ title: 'WHISTLE WHILE THE WORLD BURNS', position: 2 }
		]);
	});

	it('is idempotent on the artist and title, and keeps one artist row', () => {
		const first = musicAlbumService.addCatalogAlbum(CATALOG);
		const second = musicAlbumService.addCatalogAlbum(CATALOG);

		expect(second.created).toBe(false);
		expect(second.albumId).toBe(first.albumId);

		const artists = testDb.db.select().from(schema.artists).all();
		expect(artists).toHaveLength(1);
		expect(artists[0]).toMatchObject({ name: 'Deadfolk Prophet', mbid: null });
	});

	it('wants only the songs a playlist named', () => {
		const result = musicAlbumService.addCatalogAlbum({
			...CATALOG,
			onlyTracks: ['HIGH HONEY DRIP']
		});

		const rows = testDb.db
			.select({ title: schema.tracks.title, monitored: schema.tracks.monitored })
			.from(schema.tracks)
			.where(eq(schema.tracks.albumId, result.albumId))
			.all();
		expect(rows).toEqual([
			{ title: 'HIGH HONEY DRIP', monitored: true },
			{ title: 'WHISTLE WHILE THE WORLD BURNS', monitored: false }
		]);
	});
});

describe('MusicAlbumService.addAlbum', () => {
	it('writes one media item, one album and the tracklist', () => {
		const result = musicAlbumService.addAlbum({ releaseGroup: RELEASE_GROUP, release: RELEASE });

		expect(result.created).toBe(true);

		const item = testDb.db
			.select()
			.from(schema.mediaItems)
			.where(eq(schema.mediaItems.id, result.mediaItemId))
			.get();
		expect(item).toMatchObject({
			kind: 'album',
			title: 'Discovery',
			year: 2001,
			monitored: true
		});

		const album = testDb.db
			.select()
			.from(schema.albums)
			.where(eq(schema.albums.id, result.albumId))
			.get();
		expect(album).toMatchObject({
			mbid: 'rg-discovery',
			releaseMbid: 'rel-discovery-jp',
			title: 'Discovery',
			status: 'Official',
			labelName: 'Virgin',
			catalogNumber: 'VJCP-68283',
			barcode: '4988006788367',
			trackCount: 2,
			duration: 528,
			hasFile: false
		});

		const trackRows = testDb.db
			.select()
			.from(schema.tracks)
			.where(eq(schema.tracks.albumId, result.albumId))
			.all();
		expect(trackRows).toHaveLength(2);
		expect(trackRows.map((row) => [row.position, row.title, row.duration])).toEqual([
			[1, 'One More Time', 321],
			[2, 'Aerodynamic', 207]
		]);
	});

	it('wants only the songs a playlist named, and keeps the rest of the tracklist', () => {
		const result = musicAlbumService.addAlbum({
			releaseGroup: RELEASE_GROUP,
			release: RELEASE,
			onlyTracks: ['One More Time']
		});

		const rows = testDb.db
			.select({ title: schema.tracks.title, monitored: schema.tracks.monitored })
			.from(schema.tracks)
			.where(eq(schema.tracks.albumId, result.albumId))
			.all();

		expect(rows).toEqual([
			{ title: 'One More Time', monitored: true },
			{ title: 'Aerodynamic', monitored: false }
		]);
		// The album itself is still the subject: it is what gets acquired.
		const album = testDb.db
			.select({ monitored: schema.albums.monitored })
			.from(schema.albums)
			.where(eq(schema.albums.id, result.albumId))
			.get();
		expect(album?.monitored).toBe(true);
	});

	it('matches a decorated playlist title to the album track', () => {
		const result = musicAlbumService.addAlbum({
			releaseGroup: RELEASE_GROUP,
			release: RELEASE,
			onlyTracks: ['One More Time (Remastered 2015)']
		});

		const rows = testDb.db
			.select({ title: schema.tracks.title, monitored: schema.tracks.monitored })
			.from(schema.tracks)
			.where(eq(schema.tracks.albumId, result.albumId))
			.all();

		expect(rows).toEqual([
			{ title: 'One More Time', monitored: true },
			{ title: 'Aerodynamic', monitored: false }
		]);
	});

	it('is idempotent on the same release group instead of duplicating', () => {
		const first = musicAlbumService.addAlbum({ releaseGroup: RELEASE_GROUP, release: RELEASE });
		const second = musicAlbumService.addAlbum({ releaseGroup: RELEASE_GROUP, release: RELEASE });

		expect(second).toEqual({
			albumId: first.albumId,
			mediaItemId: first.mediaItemId,
			created: false
		});
		expect(testDb.db.select().from(schema.albums).all()).toHaveLength(1);
		expect(testDb.db.select().from(schema.mediaItems).all()).toHaveLength(1);
	});

	it('reuses the artist row across albums', () => {
		const discovery = musicAlbumService.addAlbum({ releaseGroup: RELEASE_GROUP, release: RELEASE });
		const homework = musicAlbumService.addAlbum({
			releaseGroup: { ...RELEASE_GROUP, mbid: 'rg-homework', title: 'Homework', year: 1997 },
			release: { ...RELEASE, mbid: 'rel-homework', title: 'Homework' }
		});

		const artistRows = testDb.db.select().from(schema.artists).all();
		expect(artistRows).toHaveLength(1);

		const albumRows = testDb.db.select().from(schema.albums).all();
		expect(albumRows).toHaveLength(2);
		expect(new Set(albumRows.map((row) => row.artistId))).toEqual(new Set([artistRows[0].id]));
		expect(discovery.albumId).not.toBe(homework.albumId);
	});

	it('rolls the whole album back when a track breaks the insert', () => {
		// Two tracks with the same (disc, number) violate the tracklist unique index,
		// and the failure must not leave a half-written album behind.
		const broken: MusicRelease = {
			...RELEASE,
			mbid: 'rel-broken',
			tracks: [RELEASE.tracks[0], { ...RELEASE.tracks[1], trackNumber: 1 }]
		};

		expect(() =>
			musicAlbumService.addAlbum({
				releaseGroup: { ...RELEASE_GROUP, mbid: 'rg-broken', title: 'Broken' },
				release: broken
			})
		).toThrow();

		expect(testDb.db.select().from(schema.albums).all()).toHaveLength(0);
		expect(testDb.db.select().from(schema.mediaItems).all()).toHaveLength(0);
		expect(testDb.db.select().from(schema.tracks).all()).toHaveLength(0);
	});
});

describe('MusicAlbumService.updateMetadata', () => {
	it('edits and clears the release facts the page shows', () => {
		const { albumId } = musicAlbumService.addAlbum({
			releaseGroup: RELEASE_GROUP,
			release: RELEASE
		});

		expect(
			musicAlbumService.updateMetadata(albumId, {
				title: 'Discovery (Remaster)',
				year: 2002,
				primaryType: 'Album',
				labelName: 'Parlophone',
				catalogNumber: null,
				barcode: null,
				country: 'GB'
			})
		).toBe(true);

		const album = musicAlbumService.getAlbum(albumId)!;
		expect(album.title).toBe('Discovery (Remaster)');
		expect(album.year).toBe(2002);
		expect(album.labelName).toBe('Parlophone');
		expect(album.catalogNumber).toBeNull();
		expect(album.country).toBe('GB');
	});

	it('rejects an empty title and reports a no-op patch', () => {
		const { albumId } = musicAlbumService.addAlbum({
			releaseGroup: RELEASE_GROUP,
			release: RELEASE
		});

		expect(() => musicAlbumService.updateMetadata(albumId, { title: '   ' })).toThrow(/empty/i);
		expect(musicAlbumService.updateMetadata(albumId, {})).toBe(false);
	});
});

describe('MusicAlbumService.patchAlbum', () => {
	it('applies monitor and metadata in one write', () => {
		const { albumId } = musicAlbumService.addAlbum({
			releaseGroup: RELEASE_GROUP,
			release: RELEASE
		});

		expect(
			musicAlbumService.patchAlbum(albumId, { monitored: false, title: 'Discovery (Deluxe)' })
		).toBe(true);
		const album = musicAlbumService.getAlbum(albumId)!;
		expect(album.monitored).toBe(false);
		expect(album.title).toBe('Discovery (Deluxe)');
	});

	it('rejects an unknown profile without applying the other fields', () => {
		const { albumId } = musicAlbumService.addAlbum({
			releaseGroup: RELEASE_GROUP,
			release: RELEASE
		});

		expect(() =>
			musicAlbumService.patchAlbum(albumId, { monitored: false, qualityProfileId: 'nope' })
		).toThrow(/Unknown/);
		const album = musicAlbumService.getAlbum(albumId)!;
		expect(album.monitored).toBe(true);
		expect(album.title).toBe('Discovery');
	});
});

describe('MusicAlbumService.setQualityProfile', () => {
	it('stores, clears and rejects unknown profile ids', () => {
		const { albumId } = musicAlbumService.addAlbum({
			releaseGroup: RELEASE_GROUP,
			release: RELEASE
		});
		testDb.db
			.insert(schema.scoringProfiles)
			.values({
				id: 'music-lossy',
				name: 'Lossy first',
				mediaKind: 'music',
				musicTiers: [{ kind: 'lossy', label: 'Lossy' }]
			})
			.run();

		expect(musicAlbumService.getAlbum(albumId)!.qualityProfileId).toBeNull();
		expect(musicAlbumService.setQualityProfile(albumId, 'music-lossy')).toBe(true);
		expect(musicAlbumService.getAlbum(albumId)!.qualityProfileId).toBe('music-lossy');
		expect(musicAlbumService.setQualityProfile(albumId, null)).toBe(true);
		expect(musicAlbumService.getAlbum(albumId)!.qualityProfileId).toBeNull();
		expect(() => musicAlbumService.setQualityProfile(albumId, 'nope')).toThrow(/Unknown/);
	});
});

describe('MusicAlbumService.refreshAlbum', () => {
	it('writes the provider facts back and keeps track ids for the same positions', async () => {
		const { albumId } = musicAlbumService.addAlbum({
			releaseGroup: RELEASE_GROUP,
			release: RELEASE
		});
		const before = testDb.db
			.select()
			.from(schema.tracks)
			.where(eq(schema.tracks.albumId, albumId))
			.all();

		vi.spyOn(musicBrainz, 'getReleaseGroupWithReleases').mockResolvedValue({
			group: { ...RELEASE_GROUP, title: 'Discovery (Remastered)' },
			releases: [
				{
					mbid: RELEASE.mbid,
					title: 'Discovery',
					status: 'Official',
					date: '2001-03-10',
					year: 2001,
					country: 'JP',
					trackCount: 2
				}
			]
		});
		vi.spyOn(musicBrainz, 'getRelease').mockResolvedValue({
			...RELEASE,
			tracks: [{ ...RELEASE.tracks[0], title: 'One More Time (Remastered)' }, RELEASE.tracks[1]]
		});

		const album = await musicAlbumService.refreshAlbum(albumId);

		expect(album.title).toBe('Discovery (Remastered)');
		expect(album.tracks.map((track) => track.id)).toEqual(before.map((track) => track.id));
		expect(album.tracks[0].title).toBe('One More Time (Remastered)');
	});
});

describe('MusicAlbumService.rematchAlbum', () => {
	afterEach(() => vi.restoreAllMocks());

	it('refuses a release group that belongs to another artist', async () => {
		const { albumId } = musicAlbumService.addAlbum({
			releaseGroup: RELEASE_GROUP,
			release: RELEASE
		});
		vi.spyOn(musicBrainz, 'getReleaseGroupWithReleases').mockResolvedValue({
			group: {
				...RELEASE_GROUP,
				mbid: 'rg-other',
				artist: { mbid: 'artist-other', name: 'Another Artist' }
			},
			releases: []
		});

		await expect(musicAlbumService.rematchAlbum(albumId, 'rg-other')).rejects.toThrow(
			/belongs to Another Artist/
		);
	});

	it('replaces the identity and keeps a track that has a file', async () => {
		const { albumId } = musicAlbumService.addAlbum({
			releaseGroup: RELEASE_GROUP,
			release: RELEASE
		});
		testDb.db
			.update(schema.tracks)
			.set({ hasFile: true })
			.where(eq(schema.tracks.trackNumber, 1))
			.run();

		vi.spyOn(musicBrainz, 'getReleaseGroupWithReleases').mockResolvedValue({
			group: { ...RELEASE_GROUP, mbid: 'rg-new', title: 'The New Album', year: 2020 },
			releases: [
				{
					mbid: 'rel-new',
					title: 'The New Album',
					status: 'Official',
					date: '2020-01-01',
					year: 2020,
					country: 'US',
					trackCount: 1
				}
			]
		});
		vi.spyOn(musicBrainz, 'getRelease').mockResolvedValue({
			...RELEASE,
			mbid: 'rel-new',
			title: 'The New Album',
			year: 2020,
			country: 'US',
			trackCount: 1,
			tracks: [{ ...RELEASE.tracks[1], title: 'Aerodynamic (New)' }]
		});

		const album = await musicAlbumService.rematchAlbum(albumId, 'rg-new');

		expect(album).toMatchObject({
			mbid: 'rg-new',
			releaseMbid: 'rel-new',
			title: 'The New Album',
			year: 2020
		});
		expect(album.tracks).toHaveLength(2);
		expect(album.tracks.find((track) => track.trackNumber === 1)).toMatchObject({
			title: 'One More Time',
			hasFile: true
		});
		expect(album.tracks.find((track) => track.trackNumber === 2)?.title).toBe('Aerodynamic (New)');
	});
});

describe('MusicAlbumService.listAlbums', () => {
	it('carries library, profile and the summed file size for list filters', () => {
		const added = musicAlbumService.addAlbum({
			releaseGroup: RELEASE_GROUP,
			release: RELEASE,
			libraryId: null,
			rootFolderId: null,
			monitored: true,
			qualityProfileId: null
		});
		testDb.db
			.insert(schema.trackFiles)
			.values([
				{ albumId: added.albumId, relativePath: '01.flac', sizeBytes: 100 },
				{ albumId: added.albumId, relativePath: '02.flac', sizeBytes: 250 }
			])
			.run();

		const row = musicAlbumService.listAlbums().find((album) => album.id === added.albumId);

		expect(row).toBeDefined();
		expect(row?.libraryId).toBeNull();
		expect(row?.qualityProfileId).toBeNull();
		expect(row?.sizeBytes).toBe(350);
	});
});

describe('MusicAlbumService genres', () => {
	it('caches the release group genres on the album', () => {
		const added = musicAlbumService.addAlbum({
			releaseGroup: { ...RELEASE_GROUP, genres: ['electronic', 'french house'] },
			release: RELEASE,
			libraryId: null,
			rootFolderId: null,
			monitored: true,
			qualityProfileId: null
		});

		expect(musicAlbumService.getAlbum(added.albumId)?.genres).toEqual(['electronic', 'french house']);
	});
});
