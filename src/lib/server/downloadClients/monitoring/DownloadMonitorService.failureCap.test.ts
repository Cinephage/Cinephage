/**
 * markFailed() is the single funnel every failure path converges on - this
 * verifies it increments the consecutive-failure counter
 * (FailureCapSpecification) for whichever movie/episode(s) the failed queue
 * item was for, including the season-pack case where one failed queue item
 * covers several episodes.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, clearTestDb } from '../../../../test/db-helper';
import { downloadClients, downloadQueue, movies, episodes, series } from '#lib/server/db/schema.js';

const testDb = createTestDb();

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

const CLIENT_ID = randomUUID();

async function insertTorrentRow(
	overrides: Partial<typeof downloadQueue.$inferInsert> = {}
): Promise<string> {
	const id = randomUUID();
	await testDb.db.insert(downloadQueue).values({
		id,
		downloadClientId: CLIENT_ID,
		downloadId: `hash-${id}`,
		infoHash: `info-${id}`,
		title: `Test.Release.${id}`,
		protocol: 'torrent',
		status: 'downloading',
		addedAt: new Date().toISOString(),
		...overrides
	});
	return id;
}

beforeEach(async () => {
	clearTestDb(testDb);
	await testDb.db.insert(downloadClients).values({
		id: CLIENT_ID,
		name: 'Test Client',
		implementation: 'qbittorrent',
		enabled: true,
		host: 'localhost',
		port: 8080,
		useSsl: false
	});
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('DownloadMonitorService.markFailed - consecutive failure count', () => {
	it('increments the movie consecutive failure count on failure', async () => {
		const movieId = randomUUID();
		await testDb.db
			.insert(movies)
			.values({ id: movieId, tmdbId: 1, title: 'Test Movie', path: '/movies/test' });

		const queueId = await insertTorrentRow({ movieId });

		const monitor = getDownloadMonitor();
		await monitor.markFailed(queueId, 'Test failure');

		const [movie] = await testDb.db.select().from(movies).where(eq(movies.id, movieId));
		expect(movie.consecutiveFailureCount).toBe(1);
	});

	it('accumulates across repeated failures, each against a different release', async () => {
		const movieId = randomUUID();
		await testDb.db
			.insert(movies)
			.values({ id: movieId, tmdbId: 2, title: 'Test Movie 2', path: '/movies/test2' });

		const monitor = getDownloadMonitor();
		for (let i = 0; i < 3; i++) {
			// A fresh queue row each time - simulating a different release being
			// grabbed and failing, the exact scenario the per-release cooldown
			// and blocklist don't catch.
			const queueId = await insertTorrentRow({ movieId });
			await monitor.markFailed(queueId, `Failure ${i}`);
		}

		const [movie] = await testDb.db.select().from(movies).where(eq(movies.id, movieId));
		expect(movie.consecutiveFailureCount).toBe(3);
	});

	it('increments every episode in a season-pack failure', async () => {
		const seriesId = randomUUID();
		await testDb.db
			.insert(series)
			.values({ id: seriesId, tmdbId: 10, title: 'Test Series', path: '/tv/test' });

		const episodeIds = [randomUUID(), randomUUID(), randomUUID()];
		await testDb.db.insert(episodes).values(
			episodeIds.map((id, i) => ({
				id,
				seriesId,
				seasonNumber: 1,
				episodeNumber: i + 1
			}))
		);

		const queueId = await insertTorrentRow({ seriesId, episodeIds, seasonNumber: 1 });

		const monitor = getDownloadMonitor();
		await monitor.markFailed(queueId, 'Season pack failed');

		const rows = await testDb.db.select().from(episodes).where(eq(episodes.seriesId, seriesId));
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(row.consecutiveFailureCount).toBe(1);
		}
	});
});
