import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { indexers, downloadClients, rootFolders, settings } from '#lib/server/db/schema.js';

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

import { getDashboardStats } from './queries.js';

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(() => {
	testDb.db.delete(indexers).run();
	testDb.db.delete(downloadClients).run();
	testDb.db.delete(rootFolders).run();
	testDb.db.delete(settings).run();
});

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
