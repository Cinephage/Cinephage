import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../../test/db-helper';
import { api } from '../../../../../test/api-helper';
import {
	downloadClients,
	downloadQueue,
	libraries,
	movieFiles,
	movies,
	rootFolders
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

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		getMovieReleaseInfo: vi.fn().mockResolvedValue(null),
		getMovie: vi.fn().mockResolvedValue(null),
		getCollection: vi.fn().mockResolvedValue(null)
	}
}));

const { DELETE } = await import('./+server');
const { eq } = await import('drizzle-orm');

async function seedMovie(): Promise<string> {
	await testDb.db
		.insert(rootFolders)
		.values({ id: 'rf-batch-movie', name: 'Movies', path: '/media/movies', mediaType: 'movie' })
		.run();
	await testDb.db
		.insert(libraries)
		.values({
			id: 'lib-batch-movie',
			name: 'Movies Library',
			slug: 'movies-library-batch',
			mediaType: 'movie'
		})
		.run();
	await testDb.db
		.insert(movies)
		.values({
			id: 'movie-batch-1',
			tmdbId: 9201,
			title: 'Batch Movie',
			path: 'Batch Movie (2020)',
			rootFolderId: 'rf-batch-movie',
			libraryId: 'lib-batch-movie'
		})
		.run();
	return 'movie-batch-1';
}

async function seedClient(): Promise<void> {
	await testDb.db
		.insert(downloadClients)
		.values({
			id: 'client-batch-movie',
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

async function seedFile(movieId: string): Promise<void> {
	await testDb.db
		.insert(movieFiles)
		.values({
			id: 'file-batch-movie-1',
			movieId,
			relativePath: 'Batch Movie (2020).mkv',
			size: 1000
		})
		.run();
}

async function seedQueueRow(
	movieId: string,
	overrides: { indexerId?: string | null; origin?: string | null } = {}
): Promise<string> {
	const id = `queue-batch-${Math.random().toString(36).slice(2)}`;
	await testDb.db
		.insert(downloadQueue)
		.values({
			id,
			downloadClientId: 'client-batch-movie',
			downloadId: `hash-${id}`,
			title: 'Batch.Movie.2020.1080p.WEB-DL',
			movieId,
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
		'movie_files',
		'movies',
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

describe('DELETE /api/library/movies/batch - footprint parity with single removal', () => {
	it('unmatch releases Unmatched-tab tracking from a file-less row', async () => {
		const movieId = await seedMovie();
		await seedClient();
		const queueId = await seedQueueRow(movieId);

		const { status, data } = await api.delete(DELETE, { movieIds: [movieId] });

		expect(status).toBe(200);
		expect(data).toEqual(expect.objectContaining({ success: true }));
		expect(
			await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, queueId))
		).toHaveLength(0);
		// Metadata is kept; the row stays as missing.
		expect(await testDb.db.select().from(movies).where(eq(movies.id, movieId))).toHaveLength(1);
	});

	it('removing from the library stops a real queued download before the row goes', async () => {
		const movieId = await seedMovie();
		await seedClient();
		await seedFile(movieId);
		const grabId = await seedQueueRow(movieId, { indexerId: 'indexer-1', origin: null });

		const { status, data } = await api.delete(DELETE, {
			movieIds: [movieId],
			removeFromLibrary: true
		});

		expect(status).toBe(200);
		expect(data).toEqual(expect.objectContaining({ removedCount: 1 }));
		expect(
			await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, grabId))
		).toHaveLength(0);
		expect(await testDb.db.select().from(movies).where(eq(movies.id, movieId))).toHaveLength(0);
	});

	it('unmatch still preserves a real grab', async () => {
		const movieId = await seedMovie();
		await seedClient();
		await seedFile(movieId);
		const grabId = await seedQueueRow(movieId, { indexerId: 'indexer-1', origin: null });

		const { status } = await api.delete(DELETE, { movieIds: [movieId] });

		expect(status).toBe(200);
		expect(
			await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, grabId))
		).toHaveLength(1);
		expect(await testDb.db.select().from(movieFiles)).toHaveLength(0);
	});
});
