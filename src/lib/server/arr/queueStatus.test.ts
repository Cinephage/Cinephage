import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { downloadClients, downloadQueue, movies, series } from '#lib/server/db/schema.js';

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

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const { buildQueueStatus } = await import('./queueStatus.js');

const CLIENT_ID = 'client-1';
const MOVIE_ID = 'movie-1';
const SERIES_ID = 'series-1';

beforeEach(() => {
	testDb.db.delete(downloadQueue).run();
	testDb.db.delete(movies).run();
	testDb.db.delete(series).run();
	testDb.db.delete(downloadClients).run();

	testDb.db
		.insert(downloadClients)
		.values({ id: CLIENT_ID, name: 'Client', implementation: 'qbittorrent', host: 'x', port: 1 })
		.run();
	testDb.db
		.insert(movies)
		.values({ id: MOVIE_ID, tmdbId: 1, title: 'Movie', path: '/movies/movie' })
		.run();
	testDb.db
		.insert(series)
		.values({ id: SERIES_ID, tmdbId: 2, title: 'Series', path: '/tv/series' })
		.run();
});

function insertQueueItem(overrides: Partial<typeof downloadQueue.$inferInsert> = {}) {
	testDb.db
		.insert(downloadQueue)
		.values({
			downloadClientId: CLIENT_ID,
			downloadId: 'dl-1',
			title: 'Some.Release',
			status: 'downloading',
			...overrides
		})
		.run();
}

describe('buildQueueStatus', () => {
	it('only counts active items scoped to the requested media type', async () => {
		insertQueueItem({ movieId: MOVIE_ID, status: 'downloading' });
		insertQueueItem({ movieId: MOVIE_ID, status: 'imported' }); // terminal, excluded
		insertQueueItem({ seriesId: SERIES_ID, status: 'downloading' }); // wrong media type

		const movieStatus = await buildQueueStatus('movie');
		expect(movieStatus).toEqual({
			id: 1,
			totalCount: 1,
			count: 1,
			unknownCount: 0,
			errors: false,
			warnings: false,
			unknownErrors: false,
			unknownWarnings: false
		});

		const tvStatus = await buildQueueStatus('tv');
		expect(tvStatus.count).toBe(1);
	});

	it('sets errors true when any active item has failed', async () => {
		insertQueueItem({ movieId: MOVIE_ID, status: 'failed' });

		const status = await buildQueueStatus('movie');
		expect(status.errors).toBe(true);
	});

	it('returns zero counts with no queue items', async () => {
		const status = await buildQueueStatus('movie');
		expect(status.count).toBe(0);
		expect(status.errors).toBe(false);
	});
});
