import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper.js';
import { api } from '../../../../test/api-helper.js';

/**
 * The add-album route is where a search result becomes stored music: it resolves
 * the release group, chooses an edition, fetches the tracklist and writes it.
 * The tests pin the composition (which paths answer 201/200/422/404) rather than
 * the MusicBrainz mapping, which the client's own suite covers.
 */
const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/server/music/musicbrainz.js', async () => {
	const actual = await vi.importActual<typeof import('#lib/server/music/musicbrainz.js')>(
		'#lib/server/music/musicbrainz.js'
	);
	return {
		...actual,
		musicBrainz: {
			getReleaseGroup: vi.fn(),
			getReleaseGroupReleases: vi.fn(),
			getRelease: vi.fn(),
			searchReleaseGroups: vi.fn()
		}
	};
});

const { musicBrainz, MusicBrainzError } = await import('#lib/server/music/musicbrainz.js');
const mocked = vi.mocked(musicBrainz, true);
const { POST, GET } = await import('./+server.js');

const RELEASE_GROUP_MBID = '48117b90-a16e-34ca-a514-19c702df1158';

const RELEASE_GROUP = {
	mbid: RELEASE_GROUP_MBID,
	title: 'Discovery',
	primaryType: 'Album',
	secondaryTypes: [],
	firstReleaseDate: '2001-02-26',
	year: 2001,
	artist: { mbid: '056e4f3e-d505-4dad-8ec1-d04f521cbb56', name: 'Daft Punk' }
};

const RELEASE = {
	mbid: 'ab5ca495-8983-41b9-86b4-46a981d173be',
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

beforeEach(() => {
	clearTestDb(testDb);
	vi.clearAllMocks();
	mocked.getReleaseGroup.mockResolvedValue(RELEASE_GROUP);
	mocked.getReleaseGroupReleases.mockResolvedValue([
		{
			mbid: RELEASE.mbid,
			title: 'Discovery',
			status: 'Official',
			date: '2001-03-10',
			year: 2001,
			country: 'JP',
			trackCount: 2
		}
	]);
	mocked.getRelease.mockResolvedValue(RELEASE);
});

afterAll(() => destroyTestDb(testDb));

describe('POST /api/music/albums', () => {
	it('resolves the release group, picks the primary edition and stores the tracklist', async () => {
		const { status, data } = await api.post<any>(POST, { releaseGroupMbid: RELEASE_GROUP_MBID });

		expect(status).toBe(201);
		expect(data.created).toBe(true);
		expect(data.album).toMatchObject({
			title: 'Discovery',
			artistName: 'Daft Punk',
			year: 2001,
			status: 'Official',
			labelName: 'Virgin',
			hasFile: false
		});
		expect(data.album.tracks.map((track: { title: string }) => track.title)).toEqual([
			'One More Time',
			'Aerodynamic'
		]);
		expect(mocked.getRelease).toHaveBeenCalledWith(RELEASE.mbid);
	});

	it('returns the existing album instead of duplicating it', async () => {
		const first = await api.post<any>(POST, { releaseGroupMbid: RELEASE_GROUP_MBID });
		const second = await api.post<any>(POST, { releaseGroupMbid: RELEASE_GROUP_MBID });

		expect(first.status).toBe(201);
		expect(second.status).toBe(200);
		expect(second.data.created).toBe(false);
		expect(second.data.albumId).toBe(first.data.albumId);
	});

	it('rejects a release group with no editions', async () => {
		mocked.getReleaseGroupReleases.mockResolvedValue([]);
		const { status, data } = await api.post<any>(POST, { releaseGroupMbid: RELEASE_GROUP_MBID });

		expect(status).toBe(422);
		expect(data.error).toMatch(/no editions/i);
	});

	it('maps a MusicBrainz 404 to a 404 without writing anything', async () => {
		mocked.getReleaseGroup.mockRejectedValue(new MusicBrainzError('not found', 404, false));

		const { status } = await api.post<any>(POST, { releaseGroupMbid: RELEASE_GROUP_MBID });

		expect(status).toBe(404);
		const list = await api.get<any>(GET, { auth: 'admin' });
		expect(list.data.albums).toHaveLength(0);
	});

	it('attributes an album with no library to the default music library and its root folder', async () => {
		const { libraries, rootFolders } = await import('#lib/server/db/schema.js');
		testDb.db
			.insert(rootFolders)
			.values({
				id: 'rf-music',
				name: 'Music',
				path: '/media/Music',
				mediaType: 'music',
				mediaSubType: 'standard'
			})
			.run();
		testDb.db
			.insert(libraries)
			.values({
				id: 'lib-music',
				name: 'Music',
				slug: 'music',
				mediaType: 'music',
				mediaSubType: 'standard',
				isSystem: true,
				isDefault: true,
				defaultRootFolderId: 'rf-music',
				sortOrder: 0
			})
			.run();

		const { status, data } = await api.post<any>(POST, { releaseGroupMbid: RELEASE_GROUP_MBID });

		expect(status).toBe(201);
		const album = testDb.db
			.select()
			.from((await import('#lib/server/db/schema.js')).albums)
			.all()[0];
		expect(album.libraryId).toBe('lib-music');
		expect(album.rootFolderId).toBe('rf-music');
		expect(data.album.id).toBe(album.id);
	});

	it('rejects a body without a release group mbid', async () => {
		const { status } = await api.post<any>(POST, {});
		expect(status).toBe(400);
		expect(mocked.getReleaseGroup).not.toHaveBeenCalled();
	});
});

describe('GET /api/music/albums', () => {
	it('lists stored albums with artist and cover availability', async () => {
		await api.post<any>(POST, { releaseGroupMbid: RELEASE_GROUP_MBID });

		const { status, data } = await api.get<any>(GET, { auth: 'admin' });

		expect(status).toBe(200);
		expect(data.albums).toHaveLength(1);
		expect(data.albums[0]).toMatchObject({
			title: 'Discovery',
			artistName: 'Daft Punk',
			year: 2001,
			trackCount: 2,
			hasCover: true
		});
	});
});
