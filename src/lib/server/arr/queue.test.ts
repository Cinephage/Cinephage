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

const { buildQueue } = await import('./queue.js');

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
	testDb.db.insert(movies).values({ id: MOVIE_ID, tmdbId: 1, title: 'Movie', path: '/m' }).run();
	testDb.db.insert(series).values({ id: SERIES_ID, tmdbId: 2, title: 'Series', path: '/s' }).run();
});

/**
 * Regression test for a real crash: NZBDav's C# client deserializes
 * seasonNumber (and movieId/seriesId/episodeId) as non-nullable int32,
 * regardless of the real Radarr/Sonarr spec marking some of these
 * nullable. Sending an explicit `null` for any of them throws
 * System.Text.Json.JsonException on the client side and breaks polling
 * entirely. Every one of these fields must be a real number, never null.
 */
describe('buildQueue - never emits null for int fields real clients expect non-nullable', () => {
	it('defaults seriesId/episodeId/seasonNumber to 0 when a Sonarr queue row has no season set', async () => {
		testDb.db
			.insert(downloadQueue)
			.values({
				downloadClientId: CLIENT_ID,
				downloadId: 'dl-1',
				title: 'Some.Release',
				status: 'downloading',
				seriesId: SERIES_ID,
				seasonNumber: null
			})
			.run();

		const result = await buildQueue('Sonarr', {
			page: 1,
			pageSize: 10,
			sortKey: null,
			sortDirection: 'default'
		});

		expect(result.records).toHaveLength(1);
		const record = result.records[0];
		expect(record.seasonNumber).toBe(0);
		expect(typeof record.seasonNumber).toBe('number');
		expect(record.episodeId).toBe(0);
		expect(typeof record.episodeId).toBe('number');
		expect(typeof record.seriesId).toBe('number');
		expect(record.seriesId).not.toBeNull();
	});

	it('defaults movieId to 0 rather than null for a Radarr queue row', async () => {
		testDb.db
			.insert(downloadQueue)
			.values({
				downloadClientId: CLIENT_ID,
				downloadId: 'dl-2',
				title: 'Movie.Release',
				status: 'downloading',
				movieId: MOVIE_ID
			})
			.run();

		const result = await buildQueue('Radarr', {
			page: 1,
			pageSize: 10,
			sortKey: null,
			sortDirection: 'default'
		});

		expect(result.records).toHaveLength(1);
		expect(typeof result.records[0].movieId).toBe('number');
		expect(result.records[0].movieId).not.toBeNull();
	});
});
