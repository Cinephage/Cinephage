import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';
import {
	indexers,
	downloadClients,
	rootFolders,
	settings,
	albums,
	artists,
	mediaItems,
	trackFiles
} from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		getMovieReleaseInfo: vi.fn()
	}
}));

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

import { getDashboardStats, getMissingAlbums, getRecentlyAdded } from './queries.js';

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(() => {
	testDb.db.delete(trackFiles).run();
	testDb.db.delete(albums).run();
	testDb.db.delete(mediaItems).run();
	testDb.db.delete(artists).run();
	testDb.db.delete(indexers).run();
	testDb.db.delete(downloadClients).run();
	testDb.db.delete(rootFolders).run();
	testDb.db.delete(settings).run();
});

function seedAlbum(options: { hasCover?: boolean } = {}) {
	testDb.db.insert(mediaItems).values({ id: 'mi-1', kind: 'album', title: 'Test Album' }).run();
	testDb.db.insert(artists).values({ id: 'ar-1', name: 'Test Artist' }).run();
	testDb.db
		.insert(albums)
		.values({
			id: 'al-1',
			mediaItemId: 'mi-1',
			artistId: 'ar-1',
			title: 'Test Album',
			year: 2024,
			hasFile: true,
			monitored: true,
			trackCount: 2,
			releaseMbid: options.hasCover ? 'release-1' : null
		})
		.run();
	testDb.db
		.insert(trackFiles)
		.values({ id: 'tf-1', albumId: 'al-1', relativePath: '01 - One.flac', sizeBytes: 1234 })
		.run();
}

describe('getDashboardStats config and storage', () => {
	it('reports zeroed config and free space when nothing is configured', async () => {
		const stats = await getDashboardStats();

		expect(stats.config.indexerCount).toBe(0);
		expect(stats.config.downloadClientCount).toBe(0);
		expect(stats.config.rootFolderCount).toBe(0);
		expect(stats.config.tmdbConfigured).toBe(false);
		expect(stats.storage.freeBytes).toBe(0);
		expect(stats.movies.total).toBe(0);
	});

	it('counts configured integrations and sums root folder free space', async () => {
		testDb.db
			.insert(indexers)
			.values([
				{ name: 'Indexer A', definitionId: 'def-a', baseUrl: 'http://a.example' },
				{ name: 'Indexer B', definitionId: 'def-b', baseUrl: 'http://b.example' }
			])
			.run();
		testDb.db
			.insert(downloadClients)
			.values({ name: 'Client A', implementation: 'qbittorrent', host: 'localhost', port: 8080 })
			.run();
		testDb.db
			.insert(rootFolders)
			.values([
				{ name: 'Movies', path: '/media/movies', mediaType: 'movie', freeSpaceBytes: 100 },
				{ name: 'TV', path: '/media/tv', mediaType: 'tv', freeSpaceBytes: 250 },
				{ name: 'Anime', path: '/media/anime', mediaType: 'tv', freeSpaceBytes: null }
			])
			.run();
		testDb.db.insert(settings).values({ key: 'tmdb_api_key', value: 'secret' }).run();

		const stats = await getDashboardStats();

		expect(stats.config.indexerCount).toBe(2);
		expect(stats.config.downloadClientCount).toBe(1);
		expect(stats.config.rootFolderCount).toBe(3);
		expect(stats.config.tmdbConfigured).toBe(true);
		expect(stats.storage.freeBytes).toBe(350);
	});

	it('treats an unrelated settings row as TMDB not configured', async () => {
		testDb.db.insert(settings).values({ key: 'global_filters', value: '{}' }).run();

		const stats = await getDashboardStats();

		expect(stats.config.tmdbConfigured).toBe(false);
	});
});

describe('music on the dashboard', () => {
	it('counts albums and their audio bytes as music', async () => {
		seedAlbum();

		const stats = await getDashboardStats();

		expect(stats.albums).toEqual({ total: 1, withFile: 1, missing: 0, monitored: 1 });
		expect(stats.storage.musicBytes).toBe(1234);
		expect(stats.storage.totalBytes).toBe(1234);
	});

	it('puts the newest albums on the recently-added shelf with their artist', async () => {
		seedAlbum({ hasCover: true });

		const recent = await getRecentlyAdded();

		expect(recent.albums).toHaveLength(1);
		expect(recent.albums[0]).toMatchObject({
			title: 'Test Album',
			artistName: 'Test Artist',
			year: 2024,
			hasFile: true,
			monitored: true,
			hasCover: true
		});
	});
});

describe('missing albums', () => {
	it('lists monitored albums with no files', async () => {
		seedAlbum();
		testDb.db.update(albums).set({ hasFile: false }).run();

		const missing = await getMissingAlbums();

		expect(missing).toHaveLength(1);
		expect(missing[0]).toMatchObject({
			title: 'Test Album',
			artistName: 'Test Artist',
			year: 2024,
			hasCover: false
		});
	});

	it('leaves an unmonitored album out', async () => {
		seedAlbum();
		testDb.db.update(albums).set({ hasFile: false, monitored: false }).run();

		expect(await getMissingAlbums()).toHaveLength(0);
	});
});

describe('streaming albums on the dashboard', () => {
	it('counts a stream-backed album as neither missing nor with file', async () => {
		seedAlbum();
		testDb.db
			.update(albums)
			.set({ hasFile: false, streamSource: 'Cinephage Library' })
			.run();

		const stats = await getDashboardStats();

		expect(stats.albums).toMatchObject({ total: 1, withFile: 0, missing: 0 });
		expect(await getMissingAlbums()).toHaveLength(0);
	});
});
