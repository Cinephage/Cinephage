import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { movies, series } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

const testDb: TestDatabase = createTestDb();

const { mockGetMovie, mockGetTVShow } = vi.hoisted(() => ({
	mockGetMovie: vi.fn(),
	mockGetTVShow: vi.fn()
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
		getTVShow: mockGetTVShow
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

const { executeOriginalLanguageBackfillTask } = await import('./OriginalLanguageBackfillTask.js');

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

function insertSeries(overrides: Record<string, unknown> = {}) {
	const id = (overrides.id as string) ?? `series-${Math.random().toString(36).slice(2, 8)}`;
	testDb.db
		.insert(series)
		.values({
			id,
			tmdbId: (overrides.tmdbId as number) ?? 1,
			title: (overrides.title as string) ?? 'Test Series',
			path: (overrides.path as string) ?? `/tv/${id}`,
			...overrides
		})
		.run();
	return id;
}

function resetDb() {
	testDb.db.delete(movies).run();
	testDb.db.delete(series).run();
}

beforeEach(() => {
	resetDb();
	vi.clearAllMocks();
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('OriginalLanguageBackfillTask', () => {
	it('fills original_language for movies and series that are missing it', async () => {
		insertMovie({ id: 'm-null', tmdbId: 100, title: 'Null Movie' });
		insertSeries({ id: 's-null', tmdbId: 200, title: 'Null Series' });

		mockGetMovie.mockResolvedValue({ original_language: 'ja' });
		mockGetTVShow.mockResolvedValue({ original_language: 'ko' });

		const result = await executeOriginalLanguageBackfillTask(null);

		expect(result.taskType).toBe('original-language-backfill');
		expect(result.itemsProcessed).toBe(2);
		expect(result.itemsGrabbed).toBe(2);
		expect(result.errors).toBe(0);

		const movie = testDb.db.select().from(movies).where(eq(movies.id, 'm-null')).get();
		expect(movie!.originalLanguage).toBe('ja');
		const s = testDb.db.select().from(series).where(eq(series.id, 's-null')).get();
		expect(s!.originalLanguage).toBe('ko');

		// Details were requested with no explicit language (global default).
		expect(mockGetMovie).toHaveBeenCalledWith(100, null);
		expect(mockGetTVShow).toHaveBeenCalledWith(200, null);
	});

	it('honors an explicit per-item metadata language override', async () => {
		insertMovie({
			id: 'm-explicit',
			tmdbId: 101,
			title: 'Explicit Movie',
			metadataLanguageMode: 'explicit',
			metadataLanguageValue: 'de'
		});
		mockGetMovie.mockResolvedValue({ original_language: 'fr' });

		await executeOriginalLanguageBackfillTask(null);

		expect(mockGetMovie).toHaveBeenCalledWith(101, 'de');
		const movie = testDb.db.select().from(movies).where(eq(movies.id, 'm-explicit')).get();
		expect(movie!.originalLanguage).toBe('fr');
	});

	it('skips rows that already have an original language', async () => {
		insertMovie({ id: 'm-filled', tmdbId: 102, title: 'Filled Movie', originalLanguage: 'en' });
		insertSeries({ id: 's-filled', tmdbId: 202, title: 'Filled Series', originalLanguage: 'de' });

		const result = await executeOriginalLanguageBackfillTask(null);

		expect(mockGetMovie).not.toHaveBeenCalled();
		expect(mockGetTVShow).not.toHaveBeenCalled();
		expect(result.itemsProcessed).toBe(0);
		expect(result.itemsGrabbed).toBe(0);
	});

	it('leaves rows untouched when the TMDB response carries no original language', async () => {
		insertMovie({ id: 'm-unknown', tmdbId: 103, title: 'Unknown Movie' });
		mockGetMovie.mockResolvedValue({ title: 'No language here' });

		const result = await executeOriginalLanguageBackfillTask(null);

		expect(result.itemsProcessed).toBe(1);
		expect(result.itemsGrabbed).toBe(0);
		expect(result.errors).toBe(0);
		const movie = testDb.db.select().from(movies).where(eq(movies.id, 'm-unknown')).get();
		expect(movie!.originalLanguage).toBeNull();
	});

	it('counts per-item TMDB failures as errors and continues', async () => {
		insertMovie({ id: 'm-err', tmdbId: 104, title: 'Error Movie' });
		insertSeries({ id: 's-ok', tmdbId: 204, title: 'Ok Series' });
		mockGetMovie.mockRejectedValue(new Error('API down'));
		mockGetTVShow.mockResolvedValue({ original_language: 'it' });

		const result = await executeOriginalLanguageBackfillTask(null);

		expect(result.itemsProcessed).toBe(2);
		expect(result.errors).toBe(1);
		expect(result.itemsGrabbed).toBe(1);
	});

	it('respects cancellation via context', async () => {
		insertMovie({ id: 'm-cancel', tmdbId: 105, title: 'Cancelled Movie' });

		const abortController = new AbortController();
		const { TaskExecutionContext } = await import('#lib/server/tasks/TaskExecutionContext.js');
		const ctx = new TaskExecutionContext(
			'original-language-backfill',
			'history-1',
			abortController.signal
		);

		abortController.abort();

		await expect(executeOriginalLanguageBackfillTask(ctx)).rejects.toThrow();
		expect(mockGetMovie).not.toHaveBeenCalled();
	});
});
