import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../../test/db-helper';
import { api } from '../../../../../test/api-helper';
import {
	downloadClients,
	downloadQueue,
	episodeFiles,
	libraries,
	rootFolders,
	series
} from '#lib/server/db/schema.js';

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

// The client itself is not what these tests are about; keeping the manager
// offline makes the cancellation assertion deterministic.
vi.mock('#lib/server/downloadClients/DownloadClientManager.js', () => ({
	getDownloadClientManager: () => ({ getClientInstance: vi.fn().mockResolvedValue(null) })
}));

const { DELETE } = await import('./+server');
const { eq } = await import('drizzle-orm');

async function seedSeries(): Promise<string> {
	await testDb.db
		.insert(rootFolders)
		.values({ id: 'rf-batch-tv', name: 'TV', path: '/media/tv', mediaType: 'tv' })
		.run();
	await testDb.db
		.insert(libraries)
		.values({
			id: 'lib-batch-tv',
			name: 'TV Library',
			slug: 'tv-library-batch',
			mediaType: 'tv'
		})
		.run();
	await testDb.db
		.insert(series)
		.values({
			id: 'series-batch-1',
			tmdbId: 9301,
			title: 'Batch Series',
			path: 'Batch Series',
			rootFolderId: 'rf-batch-tv',
			libraryId: 'lib-batch-tv'
		})
		.run();
	return 'series-batch-1';
}

async function seedClient(): Promise<void> {
	await testDb.db
		.insert(downloadClients)
		.values({
			id: 'client-batch-tv',
			name: 'qbit',
			implementation: 'qbittorrent',
			enabled: true,
			host: 'localhost',
			port: 8080,
			useSsl: false,
			movieCategory: 'movies',
			tvCategory: 'tv'
		})
		.run();
}

async function seedFile(seriesId: string): Promise<void> {
	await testDb.db
		.insert(episodeFiles)
		.values({
			id: 'efile-batch-tv-1',
			seriesId,
			seasonNumber: 1,
			relativePath: 'Season 01/Batch Series S01E01.mkv',
			size: 1000
		})
		.run();
}

async function seedQueueRow(
	seriesId: string,
	overrides: { indexerId?: string | null; origin?: string | null } = {}
): Promise<string> {
	const id = `queue-batch-tv-${Math.random().toString(36).slice(2)}`;
	await testDb.db
		.insert(downloadQueue)
		.values({
			id,
			downloadClientId: 'client-batch-tv',
			downloadId: `hash-${id}`,
			title: 'Batch.Series.S01.1080p.WEB-DL',
			seriesId,
			indexerId: overrides.indexerId ?? null,
			protocol: 'torrent',
			origin: overrides.origin === undefined ? 'unmatched_track' : overrides.origin,
			status: 'seeding'
		})
		.run();
	return id;
}

async function resetTables(): Promise<void> {
	for (const table of [
		'episode_files',
		'episodes',
		'seasons',
		'series',
		'libraries',
		'root_folders',
		'download_queue',
		'download_clients'
	]) {
		testDb.sqlite.prepare(`DELETE FROM ${table}`).run();
	}
}

beforeEach(resetTables);

afterAll(() => destroyTestDb(testDb));

describe('DELETE /api/library/series/batch - footprint parity with single removal', () => {
	it('unmatch releases Unmatched-tab tracking from a file-less row', async () => {
		const seriesId = await seedSeries();
		await seedClient();
		const queueId = await seedQueueRow(seriesId);

		const { status, data } = await api.delete(DELETE, { seriesIds: [seriesId] });

		expect(status).toBe(200);
		expect(data).toEqual(expect.objectContaining({ success: true }));
		expect(
			await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, queueId))
		).toHaveLength(0);
		expect(await testDb.db.select().from(series).where(eq(series.id, seriesId))).toHaveLength(1);
	});

	it('removing from the library stops a real queued download before the row goes', async () => {
		const seriesId = await seedSeries();
		await seedClient();
		await seedFile(seriesId);
		const grabId = await seedQueueRow(seriesId, { indexerId: 'indexer-1', origin: null });

		const { status, data } = await api.delete(DELETE, {
			seriesIds: [seriesId],
			removeFromLibrary: true
		});

		expect(status).toBe(200);
		expect(data).toEqual(expect.objectContaining({ removedCount: 1 }));
		expect(
			await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, grabId))
		).toHaveLength(0);
		expect(await testDb.db.select().from(series).where(eq(series.id, seriesId))).toHaveLength(0);
	});

	it('unmatch still preserves a real grab', async () => {
		const seriesId = await seedSeries();
		await seedClient();
		await seedFile(seriesId);
		const grabId = await seedQueueRow(seriesId, { indexerId: 'indexer-1', origin: null });

		const { status } = await api.delete(DELETE, { seriesIds: [seriesId] });

		expect(status).toBe(200);
		expect(
			await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, grabId))
		).toHaveLength(1);
		expect(await testDb.db.select().from(episodeFiles)).toHaveLength(0);
	});
});
