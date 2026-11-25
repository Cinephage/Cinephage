import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper';
import {
	requests,
	userRequestSettings,
	user,
	settings,
	rootFolders,
	mediaItems,
	artists,
	albums
} from '#lib/server/db/schema.js';
import { createTestUser } from '../../../test/fixtures/auth.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis(),
	fatal: vi.fn(),
	trace: vi.fn()
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger),
	createRequestLogger: vi.fn(() => mockLogger),
	runWithLogContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn())
}));

vi.mock('#lib/server/library/LibraryAddService.js', () => ({
	fetchMovieDetails: vi.fn(),
	fetchSeriesDetails: vi.fn(),
	validateRootFolder: vi.fn(async () => undefined),
	triggerMovieSearch: vi.fn(),
	triggerSeriesSearch: vi.fn()
}));

vi.mock('#lib/server/blocked-media/service.js', () => ({
	blockedMediaService: { isBlocked: vi.fn(async () => false) }
}));

const getReleaseGroup = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/music/musicbrainz.js', () => ({
	musicBrainz: { getReleaseGroup },
	pickPrimaryRelease: vi.fn()
}));

const addAlbumFromReleaseGroup = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/music/add-album.js', () => ({ addAlbumFromReleaseGroup }));

const { getRequestService } = await import('./RequestService.js');
const { getRequestSettingsService } = await import('./RequestSettingsService.js');

const MBID = '11111111-1111-4111-8111-111111111111';
const MBID_2 = '22222222-2222-4222-8222-222222222222';

const releaseGroup = {
	mbid: MBID,
	title: 'Discovery',
	primaryType: 'Album',
	secondaryTypes: [],
	firstReleaseDate: '2001-03-12',
	year: 2001,
	artist: { mbid: 'artist-mbid', name: 'Daft Punk' }
};

let viewerId: string;
let adminId: string;

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(requests).run();
	testDb.db.delete(userRequestSettings).run();
	testDb.db.delete(settings).run();
	testDb.db.delete(user).run();
	getRequestSettingsService().invalidateCache();
	vi.clearAllMocks();
	getReleaseGroup.mockResolvedValue(releaseGroup);
	addAlbumFromReleaseGroup.mockReset();

	viewerId = randomUUID();
	adminId = randomUUID();
	testDb.db
		.insert(user)
		.values([
			createTestUser({ id: viewerId, username: 'viewer', email: 'v@test.local', role: 'user' }),
			createTestUser({ id: adminId, username: 'admin', email: 'a@test.local', role: 'admin' })
		])
		.run();
	testDb.db
		.insert(rootFolders)
		.values([
			{ id: 'rf-music', name: 'Music', path: '/media/music', mediaType: 'music', isDefault: true }
		])
		.onConflictDoNothing()
		.run();
});

function viewer() {
	return { id: viewerId, role: 'user' as const };
}

function admin() {
	return { id: adminId, role: 'admin' as const };
}

function insertAlbum(id: string, hasFile: boolean) {
	testDb.db
		.insert(mediaItems)
		.values({ id: `mi-${id}`, kind: 'album', title: 'Discovery', year: 2001 })
		.run();
	testDb.db
		.insert(artists)
		.values({ id: `artist-${id}`, name: 'Daft Punk', mbid: 'artist-mbid' })
		.run();
	testDb.db
		.insert(albums)
		.values({
			id,
			mediaItemId: `mi-${id}`,
			artistId: `artist-${id}`,
			mbid: MBID,
			title: 'Discovery',
			year: 2001,
			monitored: true,
			hasFile
		})
		.run();
}

describe('music requests', () => {
	it('creates a pending request with the release-group identity and cover', async () => {
		const created = await getRequestService().create(viewer(), { mediaType: 'music', mbid: MBID });
		expect(created).toMatchObject({
			mediaType: 'music',
			tmdbId: null,
			mbid: MBID,
			title: 'Discovery',
			coverUrl: `/api/music/cover/release-group/${MBID}/500`,
			year: 2001,
			status: 'pending'
		});
		expect(created.seasons).toBeNull();
		expect(created.episodes).toBeNull();
	});

	it('rejects a second active request for the same release group', async () => {
		const svc = getRequestService();
		await svc.create(viewer(), { mediaType: 'music', mbid: MBID });
		await expect(svc.create(viewer(), { mediaType: 'music', mbid: MBID })).rejects.toMatchObject({
			code: 'duplicate_request'
		});
	});

	it('rejects an album already in the library with files', async () => {
		insertAlbum('album-1', true);
		await expect(
			getRequestService().create(viewer(), { mediaType: 'music', mbid: MBID })
		).rejects.toMatchObject({ code: 'already_available' });
	});

	it('enforces the music quota', async () => {
		const current = await getRequestSettingsService().getRequestSettings();
		await getRequestSettingsService().saveRequestSettings({
			...current,
			defaultQuotas: {
				...current.defaultQuotas,
				music: { limit: 1, days: null }
			}
		});
		const svc = getRequestService();
		await svc.create(viewer(), { mediaType: 'music', mbid: MBID });
		getReleaseGroup.mockResolvedValueOnce({ ...releaseGroup, mbid: MBID_2, title: 'Homework' });
		await expect(svc.create(viewer(), { mediaType: 'music', mbid: MBID_2 })).rejects.toMatchObject({
			code: 'music_quota'
		});
	});

	it('approves into an album and fulfils once files exist', async () => {
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'music', mbid: MBID });
		insertAlbum('album-approved', true);
		addAlbumFromReleaseGroup.mockResolvedValue({ albumId: 'album-approved', created: false });

		const approved = await svc.approve(created.id, admin());
		expect(addAlbumFromReleaseGroup).toHaveBeenCalledWith(
			expect.objectContaining({
				mbid: MBID,
				rootFolderId: 'rf-music',
				search: true,
				monitorExisting: true
			})
		);
		expect(approved.albumId).toBe('album-approved');
		expect(approved.status).toBe('fulfilled');

		const row = testDb.db.select().from(requests).where(eq(requests.id, created.id)).get();
		expect(row?.albumId).toBe('album-approved');
	});

	it('parks the request when no writable music root folder exists', async () => {
		testDb.db.delete(rootFolders).run();
		const created = await getRequestService().create(viewer(), { mediaType: 'music', mbid: MBID });
		const approved = await getRequestService().approve(created.id, admin());
		expect(approved.status).toBe('awaiting_target');
		expect(addAlbumFromReleaseGroup).not.toHaveBeenCalled();
	});

	it('fulfils an active request when its album gains files', async () => {
		const created = await getRequestService().create(viewer(), { mediaType: 'music', mbid: MBID });
		insertAlbum('album-later', true);
		const advanced = await getRequestService().advanceFulfilledMusicByMbid(MBID);
		expect(advanced).toBe(1);
		const row = testDb.db.select().from(requests).where(eq(requests.id, created.id)).get();
		expect(row?.status).toBe('fulfilled');
		expect(row?.albumId).toBe('album-later');
	});
});
