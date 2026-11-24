import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '#lib/server/db/schema.js';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { musicBrainz } from '#lib/server/music/musicbrainz.js';
import type { AlbumCandidate } from '#lib/server/music/playlists/types.js';
import type { MusicRelease, MusicReleaseGroup } from '#lib/server/music/types.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

const mocks = vi.hoisted(() => ({
	fetchPlaylist: vi.fn(),
	resolveTracks: vi.fn(),
	addItem: vi.fn()
}));

vi.mock('#lib/server/music/playlists/sources/index.js', () => ({
	resolveSource: vi.fn(() => ({
		source: { fetchPlaylist: mocks.fetchPlaylist },
		url: 'https://open.spotify.com/playlist/abc'
	}))
}));
vi.mock('#lib/server/music/playlists/resolve.js', () => ({
	resolvePlaylistTracks: mocks.resolveTracks
}));
vi.mock('./add.js', () => ({ addMusicItem: mocks.addItem }));

const { refreshMusicList } = await import('./refresh.js');

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
	mbid: 'rel-discovery',
	title: 'Discovery',
	status: 'Official',
	country: 'GB',
	barcode: null,
	packaging: null,
	labelName: null,
	catalogNumber: null,
	date: '2001-03-12',
	year: 2001,
	mediaCount: 1,
	trackCount: 1,
	duration: 320,
	tracks: [
		{
			recordingMbid: 'rec-1',
			title: 'One More Time',
			artistCredit: 'Daft Punk',
			discNumber: 1,
			trackNumber: 1,
			position: 1,
			duration: 320
		}
	]
};

function candidate(
	releaseGroupMbid: string,
	title: string,
	artistName: string,
	year: number | null = null
): AlbumCandidate {
	return {
		id: releaseGroupMbid,
		releaseGroupMbid,
		title,
		artistName,
		artistMbid: 'artist-1',
		year,
		primaryType: 'Album',
		matchedBy: 'album',
		confidence: 'high',
		tracks: [],
		inLibrary: false,
		albumId: null
	};
}

function createPlaylistList(overrides: Record<string, unknown> = {}) {
	return testDb.db
		.insert(schema.smartLists)
		.values({
			name: 'Playlist',
			mediaType: 'music',
			listSourceType: 'playlist',
			externalSourceConfig: {
				url: 'https://open.spotify.com/playlist/abc',
				trackLimit: 50
			},
			filters: {},
			sortBy: 'popularity.desc',
			itemLimit: 100,
			refreshIntervalHours: 24,
			autoAddBehavior: 'disabled',
			...overrides
		})
		.returning()
		.all()[0];
}

function itemsFor(listId: string) {
	return testDb.db
		.select()
		.from(schema.smartListItems)
		.where(eq(schema.smartListItems.smartListId, listId))
		.orderBy(schema.smartListItems.position)
		.all();
}

beforeEach(() => {
	clearTestDb(testDb);
	mocks.fetchPlaylist.mockReset();
	mocks.resolveTracks.mockReset();
	mocks.addItem.mockReset();
	mocks.addItem.mockResolvedValue({ success: true });
	mocks.fetchPlaylist.mockResolvedValue({
		playlist: { provider: 'spotify', id: 'abc', name: 'Test', trackCount: 2 },
		tracks: [{ title: 'One More Time', artist: 'Daft Punk' }],
		truncated: false
	});
	mocks.resolveTracks.mockResolvedValue({
		candidates: [
			candidate('rg-discovery', 'Discovery', 'Daft Punk', 2001),
			candidate('rg-random', 'Random Access Memories', 'Daft Punk', 2013)
		],
		unmatched: []
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => destroyTestDb(testDb));

describe('refreshMusicList (playlist)', () => {
	it('writes one row per album in source order with its artist and cover', async () => {
		const list = createPlaylistList();

		const result = await refreshMusicList(list, 'manual');

		expect(result.status).toBe('success');
		expect(result.itemsFound).toBe(2);
		expect(result.itemsNew).toBe(2);

		const rows = itemsFor(list.id);
		expect(rows.map((row) => row.mbid)).toEqual(['rg-discovery', 'rg-random']);
		expect(rows.map((row) => row.position)).toEqual([0, 1]);
		expect(rows[0].artistName).toBe('Daft Punk');
		expect(rows[0].coverUrl).toBe(
			'https://coverartarchive.org/release-group/rg-discovery/front-250'
		);
		expect(rows.every((row) => row.tmdbId === null)).toBe(true);
		expect(rows.every((row) => row.mediaType === 'music')).toBe(true);

		const refreshed = testDb.db
			.select()
			.from(schema.smartLists)
			.where(eq(schema.smartLists.id, list.id))
			.get();
		expect(refreshed?.cachedItemCount).toBe(2);
		expect(refreshed?.lastRefreshStatus).toBe('success');

		const history = testDb.db
			.select()
			.from(schema.smartListRefreshHistory)
			.where(eq(schema.smartListRefreshHistory.smartListId, list.id))
			.all();
		expect(history).toHaveLength(1);
		expect(history[0].itemsFound).toBe(2);
	});

	it('links an album already in the library instead of listing it as missing', async () => {
		const added = musicAlbumService.addAlbum({ releaseGroup: RELEASE_GROUP, release: RELEASE });
		const list = createPlaylistList();

		await refreshMusicList(list, 'manual');

		const row = testDb.db
			.select()
			.from(schema.smartListItems)
			.where(
				and(
					eq(schema.smartListItems.smartListId, list.id),
					eq(schema.smartListItems.mbid, 'rg-discovery')
				)
			)
			.get();
		expect(row?.inLibrary).toBe(true);
		expect(row?.albumId).toBe(added.albumId);
	});

	it('updates positions and retires source items that vanished', async () => {
		const list = createPlaylistList();
		await refreshMusicList(list, 'manual');

		mocks.resolveTracks.mockResolvedValue({
			candidates: [candidate('rg-random', 'Random Access Memories', 'Daft Punk', 2013)],
			unmatched: []
		});

		const second = await refreshMusicList(list, 'automatic');
		expect(second.itemsFound).toBe(1);
		expect(second.itemsRemoved).toBe(1);

		const rows = itemsFor(list.id);
		const discovery = rows.find((row) => row.mbid === 'rg-discovery');
		const random = rows.find((row) => row.mbid === 'rg-random');
		expect(discovery?.position).toBe(9999);
		expect(random?.position).toBe(0);

		const refreshed = testDb.db
			.select()
			.from(schema.smartLists)
			.where(eq(schema.smartLists.id, list.id))
			.get();
		expect(refreshed?.cachedItemCount).toBe(1);
	});

	it('auto-adds only eligible items and leaves exclusions alone', async () => {
		const folder = testDb.db
			.insert(schema.rootFolders)
			.values({ name: 'Music', path: '/music', mediaType: 'music' })
			.returning()
			.all()[0];
		const list = createPlaylistList({
			autoAddBehavior: 'add_only',
			rootFolderId: folder.id,
			autoAddMonitored: true
		});
		await refreshMusicList(list, 'manual');

		const [first] = itemsFor(list.id);
		testDb.db
			.update(schema.smartListItems)
			.set({ isExcluded: true })
			.where(eq(schema.smartListItems.id, first.id))
			.run();

		mocks.addItem.mockClear();
		await refreshMusicList(list, 'manual');

		// The excluded row is skipped; the other one is still not in the library
		// because addMusicItem is mocked here.
		expect(mocks.addItem).toHaveBeenCalledTimes(1);
		expect(mocks.addItem.mock.calls[0][1].mbid).toBe('rg-random');
		expect(mocks.addItem.mock.calls[0][2]).toMatchObject({ auto: true, search: false });
	});

	it('refuses a second refresh of the same list while one is running', async () => {
		const list = createPlaylistList();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let entered!: () => void;
		const enteredPromise = new Promise<void>((resolve) => (entered = resolve));

		mocks.fetchPlaylist.mockImplementation(async () => {
			entered();
			await gate;
			return {
				playlist: { provider: 'spotify', id: 'abc', name: 'Test', trackCount: 2 },
				tracks: [{ title: 'One More Time', artist: 'Daft Punk' }],
				truncated: false
			};
		});

		const first = refreshMusicList(list, 'manual');
		await enteredPromise;
		const second = await refreshMusicList(list, 'manual');

		expect(second.status).toBe('running');
		expect(second.errorMessage).toContain('already running');

		release();
		expect((await first).status).toBe('success');
		expect(itemsFor(list.id)).toHaveLength(2);
	});

	it('fails cleanly when a playlist list has no URL', async () => {
		const list = createPlaylistList({ externalSourceConfig: {} });

		const result = await refreshMusicList(list, 'manual');

		expect(result.status).toBe('failed');
		expect(result.errorMessage).toContain('playlist URL');

		const refreshed = testDb.db
			.select()
			.from(schema.smartLists)
			.where(eq(schema.smartLists.id, list.id))
			.get();
		expect(refreshed?.lastRefreshStatus).toBe('failed');
	});
});

describe('refreshMusicList (new releases)', () => {
	it('keeps only in-window release groups of the wanted types', async () => {
		const today = new Date().toISOString().slice(0, 10);
		testDb.db
			.insert(schema.artists)
			.values({ name: 'Daft Punk', mbid: 'artist-daft-punk', monitored: true })
			.run();
		const browse = vi.spyOn(musicBrainz, 'getArtistReleaseGroups').mockResolvedValue({
			releaseGroups: [
				{
					mbid: 'rg-new',
					title: 'New Album',
					primaryType: 'Album',
					secondaryTypes: [],
					firstReleaseDate: today,
					year: Number(today.slice(0, 4)),
					artist: { mbid: 'artist-daft-punk', name: 'Daft Punk', sortName: 'Daft Punk' }
				},
				{
					mbid: 'rg-single',
					title: 'New Single',
					primaryType: 'Single',
					secondaryTypes: [],
					firstReleaseDate: today,
					year: Number(today.slice(0, 4)),
					artist: { mbid: 'artist-daft-punk', name: 'Daft Punk', sortName: 'Daft Punk' }
				},
				{
					mbid: 'rg-old',
					title: 'Old Album',
					primaryType: 'Album',
					secondaryTypes: [],
					firstReleaseDate: '1999-01-01',
					year: 1999,
					artist: { mbid: 'artist-daft-punk', name: 'Daft Punk', sortName: 'Daft Punk' }
				}
			]
		} as never);

		const list = testDb.db
			.insert(schema.smartLists)
			.values({
				name: 'New releases',
				mediaType: 'music',
				listSourceType: 'musicbrainz-new-releases',
				externalSourceConfig: { releaseTypes: ['Album'], lookbackDays: 30, artistLimit: 10 },
				filters: {},
				sortBy: 'popularity.desc',
				itemLimit: 100,
				refreshIntervalHours: 24,
				autoAddBehavior: 'disabled'
			})
			.returning()
			.all()[0];

		const result = await refreshMusicList(list, 'manual');

		expect(result.status).toBe('success');
		expect(browse).toHaveBeenCalledTimes(1);
		const rows = itemsFor(list.id);
		expect(rows.map((row) => row.mbid)).toEqual(['rg-new']);
	});
});
