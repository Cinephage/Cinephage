import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { downloadClients, downloadQueue, movies } from '#lib/server/db/schema.js';

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

const { getDownloadMonitor } = await import('./DownloadMonitorService');

describe('DownloadMonitorService.addToQueue', () => {
	afterAll(() => destroyTestDb(testDb));

	beforeEach(() => {
		testDb.sqlite.exec(
			'DELETE FROM download_queue; DELETE FROM download_clients; DELETE FROM movies;'
		);
		testDb.db
			.insert(movies)
			.values({ id: 'movie-2', tmdbId: 42, title: 'Fresh Movie', path: 'Fresh Movie (2026)' })
			.run();
		testDb.db
			.insert(downloadClients)
			.values({
				id: 'client-1',
				name: 'qBittorrent',
				implementation: 'qbittorrent',
				host: 'localhost',
				port: 8080
			})
			.run();
	});

	it('admits only one queue row when the same torrent is submitted concurrently', async () => {
		const params = {
			downloadClientId: 'client-1',
			downloadId: 'remote-id-1',
			infoHash: '0123456789abcdef0123456789abcdef01234567',
			title: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
			protocol: 'torrent',
			movieId: undefined
		};

		const results = await Promise.all([
			getDownloadMonitor().addToQueue(params),
			getDownloadMonitor().addToQueue(params)
		]);

		expect(new Set(results.map((result) => result.id)).size).toBe(1);
		expect(testDb.db.select().from(downloadQueue).all()).toHaveLength(1);
	});

	it('stores the hash extracted from a magnet when the caller omits infoHash', async () => {
		const infoHash = '0123456789abcdef0123456789abcdef01234567';

		await getDownloadMonitor().addToQueue({
			downloadClientId: 'client-1',
			downloadId: infoHash,
			title: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
			magnetUrl: `magnet:?xt=urn:btih:${infoHash}`,
			protocol: 'torrent'
		});

		expect(
			testDb.db.select({ infoHash: downloadQueue.infoHash }).from(downloadQueue).all()
		).toEqual([{ infoHash }]);
	});

	it('prefers a valid magnet hash when the supplied hash is not canonical', async () => {
		const infoHash = '0123456789abcdef0123456789abcdef01234567';

		await getDownloadMonitor().addToQueue({
			downloadClientId: 'client-1',
			downloadId: infoHash,
			infoHash: 'not-a-torrent-hash',
			title: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
			magnetUrl: `magnet:?xt=urn:btih:${infoHash}`,
			protocol: 'torrent'
		});

		expect(
			testDb.db.select({ infoHash: downloadQueue.infoHash }).from(downloadQueue).all()
		).toEqual([{ infoHash }]);
	});

	it('creates a new row when a previous row with the hash is terminal', async () => {
		const infoHash = '0123456789abcdef0123456789abcdef01234567';
		testDb.db
			.insert(downloadQueue)
			.values({
				id: 'removed-row',
				downloadClientId: 'client-1',
				downloadId: infoHash,
				infoHash,
				title: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
				status: 'removed',
				protocol: 'torrent'
			})
			.run();

		const item = await getDownloadMonitor().addToQueue({
			downloadClientId: 'client-1',
			downloadId: infoHash,
			infoHash,
			title: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
			protocol: 'torrent'
		});

		expect(item.id).not.toBe('removed-row');
		expect(testDb.db.select().from(downloadQueue).all()).toHaveLength(2);
	});

	it('creates a fresh row instead of resurrecting a failed row with the same hash', async () => {
		// Resurrecting a failed row returned the PREVIOUS target and upgrade
		// flags to the new grab (stale-row reuse bug) — a new grab must get a
		// clean row.
		const infoHash = '0123456789abcdef0123456789abcdef01234567';
		testDb.db
			.insert(downloadQueue)
			.values({
				id: 'failed-row',
				downloadClientId: 'client-1',
				downloadId: infoHash,
				infoHash,
				title: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
				status: 'failed',
				protocol: 'torrent'
			})
			.run();

		const item = await getDownloadMonitor().addToQueue({
			downloadClientId: 'client-1',
			downloadId: infoHash,
			infoHash,
			title: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
			protocol: 'torrent',
			movieId: 'movie-2',
			isUpgrade: true
		});

		expect(item.id).not.toBe('failed-row');
		expect(item.movieId).toBe('movie-2');
		expect(item.isUpgrade).toBe(true);
		const rows = testDb.db.select().from(downloadQueue).all();
		expect(rows).toHaveLength(2);
		const failed = rows.find((row) => row.id === 'failed-row');
		expect(failed?.status).toBe('failed');
		expect(failed?.movieId).toBeNull();
	});
});
