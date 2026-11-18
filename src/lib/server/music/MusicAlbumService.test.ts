import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '#lib/server/db/schema.js';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper.js';
import { musicAlbumService } from './MusicAlbumService.js';
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
