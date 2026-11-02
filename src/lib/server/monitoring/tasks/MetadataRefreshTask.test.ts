import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { movies } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

const testDb: TestDatabase = createTestDb();

const { mockGetMovie, mockGetMovieExternalIds } = vi.hoisted(() => ({
	mockGetMovie: vi.fn(),
	mockGetMovieExternalIds: vi.fn()
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

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		getMovie: mockGetMovie,
		getMovieExternalIds: mockGetMovieExternalIds,
		getRegion: vi.fn().mockResolvedValue('US')
	}
}));

vi.mock('#lib/server/tasks/TaskCancelledException.js', () => {
	class TaskCancelledException extends Error {
		readonly taskId: string;
		constructor(taskId: string) {
			super(`Task '${taskId}' was cancelled`);
			this.name = 'TaskCancelledException';
			this.taskId = taskId;
		}
		static isTaskCancelled(error: unknown): error is TaskCancelledException {
			return error instanceof TaskCancelledException;
		}
	}
	return { TaskCancelledException };
});

const { executeMetadataRefreshTask } = await import('./MetadataRefreshTask.js');

function insertMovie(overrides: Record<string, unknown> = {}) {
	const id = (overrides.id as string) ?? `movie-${Math.random().toString(36).slice(2, 8)}`;
	testDb.db
		.insert(movies)
		.values({
			id,
			tmdbId: (overrides.tmdbId as number) ?? 1,
			title: (overrides.title as string) ?? 'Test Movie',
			path: (overrides.path as string) ?? `/movies/${id}`,
			...overrides
		})
		.run();
	return id;
}

function resetDb() {
	testDb.db.delete(movies).run();
}

beforeEach(() => {
	resetDb();
	vi.clearAllMocks();
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('MetadataRefreshTask', () => {
	it('processes movies with missing collection data', async () => {
		insertMovie({ id: 'm1', tmdbId: 100, title: 'Old Title' });

		mockGetMovie.mockResolvedValue({
			title: 'New Title',
			original_title: 'Original Title',
			overview: 'An overview',
			poster_path: '/poster.jpg',
			backdrop_path: '/backdrop.jpg',
			runtime: 120,
			genres: [
				{ id: 1, name: 'Action' },
				{ id: 2, name: 'Drama' }
			],
			release_date: '2024-01-15',
			belongs_to_collection: { id: 500, name: 'Test Collection' }
		});
		mockGetMovieExternalIds.mockResolvedValue({ imdb_id: 'tt1234567' });

		const result = await executeMetadataRefreshTask(null);

		expect(result.taskType).toBe('metadata-refresh');
		expect(result.itemsProcessed).toBe(1);
		expect(result.itemsGrabbed).toBe(1);
		expect(result.errors).toBe(0);

		const updated = testDb.db.select().from(movies).where(eq(movies.id, 'm1')).get();
		expect(updated).toBeDefined();
		expect(updated!.title).toBe('New Title');
		expect(updated!.tmdbCollectionId).toBe(500);
		expect(updated!.collectionName).toBe('Test Collection');
		expect(updated!.imdbId).toBe('tt1234567');
		expect(updated!.genres).toEqual(['Action', 'Drama']);
		expect(updated!.year).toBe(2024);
	});

	it('handles TMDB API errors gracefully', async () => {
		insertMovie({ id: 'm1', tmdbId: 100, title: 'Movie 1' });
		insertMovie({ id: 'm2', tmdbId: 200, title: 'Movie 2' });

		mockGetMovie.mockRejectedValueOnce(new Error('API error')).mockResolvedValueOnce({
			title: 'Movie 2 Updated',
			original_title: 'Movie 2',
			overview: 'Overview',
			poster_path: null,
			backdrop_path: null,
			runtime: 90,
			genres: [],
			release_date: '2023-06-01',
			belongs_to_collection: null
		});
		mockGetMovieExternalIds.mockResolvedValue({ imdb_id: null });

		const result = await executeMetadataRefreshTask(null);

		expect(result.itemsProcessed).toBe(2);
		expect(result.itemsGrabbed).toBe(1);
		expect(result.errors).toBe(1);
	});

	it('handles external IDs fetch failure gracefully', async () => {
		insertMovie({ id: 'm1', tmdbId: 100, title: 'Movie 1' });

		mockGetMovie.mockResolvedValue({
			title: 'Movie 1',
			original_title: 'Movie 1',
			overview: 'Overview',
			poster_path: null,
			backdrop_path: null,
			runtime: 100,
			genres: [],
			release_date: '2024-01-01',
			belongs_to_collection: { id: 10, name: 'Collection' }
		});
		mockGetMovieExternalIds.mockRejectedValue(new Error('External IDs failed'));

		const result = await executeMetadataRefreshTask(null);

		expect(result.errors).toBe(0);
		expect(result.itemsGrabbed).toBe(1);
	});

	it('respects cancellation via context', async () => {
		insertMovie({ id: 'm1', tmdbId: 100, title: 'Movie 1' });

		const abortController = new AbortController();
		const { TaskExecutionContext } = await import('#lib/server/tasks/TaskExecutionContext.js');
		const ctx = new TaskExecutionContext('metadata-refresh', 'history-1', abortController.signal);

		abortController.abort();

		await expect(executeMetadataRefreshTask(ctx)).rejects.toThrow();
	});

	it('returns zero counts when no movies need refresh', async () => {
		const result = await executeMetadataRefreshTask(null);

		expect(result.itemsProcessed).toBe(0);
		expect(result.itemsGrabbed).toBe(0);
		expect(result.errors).toBe(0);
	});
});
