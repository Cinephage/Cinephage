import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper';
import {
	albums,
	artists,
	downloadClients,
	downloadQueue,
	mediaItems,
	monitoringHistory
} from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

const autoSearchMock = vi.fn();
vi.mock('./MusicAutoSearch.js', () => ({
	autoSearchAlbum: (...args: unknown[]) => autoSearchMock(...args)
}));

const { searchMissingMusic } = await import('./MusicMonitoringSearch');

afterAll(() => destroyTestDb(testDb));

beforeEach(() => {
	autoSearchMock.mockReset();
	testDb.db.delete(monitoringHistory).run();
	testDb.db.delete(downloadQueue).run();
	testDb.db.delete(downloadClients).run();
	testDb.db.delete(albums).run();
	testDb.db.delete(artists).run();
	testDb.db.delete(mediaItems).run();
});

function seedAlbum(options: {
	monitored?: boolean;
	hasFile?: boolean;
	artistMonitored?: boolean;
	lastSearchedAt?: string | null;
}): { albumId: string; mediaItemId: string } {
	const artistId = randomUUID();
	const albumId = randomUUID();
	const mediaItemId = randomUUID();

	testDb.db
		.insert(artists)
		.values({ id: artistId, name: 'Artist', mbid: randomUUID(), monitored: options.artistMonitored ?? true })
		.run();
	testDb.db
		.insert(mediaItems)
		.values({ id: mediaItemId, kind: 'album', title: 'Album' })
		.run();
	testDb.db
		.insert(albums)
		.values({
			id: albumId,
			mediaItemId,
			artistId,
			title: 'Album',
			monitored: options.monitored ?? true,
			hasFile: options.hasFile ?? false,
			lastSearchedAt: options.lastSearchedAt ?? null
		})
		.run();
	return { albumId, mediaItemId };
}

describe('searchMissingMusic', () => {
	it('searches monitored, missing albums and stamps the cooldown', async () => {
		const { albumId } = seedAlbum({});
		seedAlbum({ hasFile: true });
		seedAlbum({ monitored: false });
		seedAlbum({ artistMonitored: false });
		autoSearchMock.mockResolvedValue({ albumId, title: 'Album', grabbed: true, release: 'Album FLAC' });

		const result = await searchMissingMusic(undefined, { cooldownHours: 24 });

		expect(result.summary).toMatchObject({ searched: 1, grabbed: 1, errors: 0 });
		expect(autoSearchMock).toHaveBeenCalledTimes(1);
		expect(autoSearchMock.mock.calls[0][0]).toMatchObject({ id: albumId, title: 'Album' });
		const row = testDb.db.select().from(albums).where(eq(albums.id, albumId)).get();
		expect(row?.lastSearchedAt).toBeTruthy();
	});

	it('skips an album searched inside the cooldown window', async () => {
		seedAlbum({ lastSearchedAt: new Date().toISOString() });
		autoSearchMock.mockResolvedValue({ albumId: 'x', title: 'Album', grabbed: true });

		const result = await searchMissingMusic(undefined, { cooldownHours: 24 });

		expect(result.summary).toMatchObject({ searched: 0, skipped: 1 });
		expect(autoSearchMock).not.toHaveBeenCalled();
	});

	it('skips an album that is already queued', async () => {
		const { mediaItemId } = seedAlbum({});
		testDb.db
			.insert(downloadClients)
			.values({
				id: 'client-1',
				name: 'Client',
				implementation: 'qbittorrent',
				host: 'localhost',
				port: 8080
			})
			.run();
		testDb.db
			.insert(downloadQueue)
			.values({
				id: randomUUID(),
				downloadClientId: 'client-1',
				downloadId: 'album-download',
				mediaItemId,
				title: 'Album FLAC',
				protocol: 'torrent',
				status: 'downloading'
			})
			.run();

		const result = await searchMissingMusic(undefined, { ignoreCooldown: true });

		expect(result.summary).toMatchObject({ searched: 0, skipped: 1 });
		expect(autoSearchMock).not.toHaveBeenCalled();
	});

	it('records the attempt against the album identity', async () => {
		const { albumId, mediaItemId } = seedAlbum({});
		autoSearchMock.mockResolvedValue({
			albumId,
			title: 'Album',
			grabbed: false,
			releasesFound: 4,
			error: 'no accepted release'
		});

		await searchMissingMusic();

		const rows = testDb.db.select().from(monitoringHistory).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			taskType: 'missing',
			mediaItemId,
			status: 'error',
			releasesFound: 4,
			errorMessage: 'no accepted release'
		});
	});
});
