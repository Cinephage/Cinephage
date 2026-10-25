import { describe, expect, it, vi, afterAll, afterEach } from 'vitest';
import { createTestDb, destroyTestDb } from '../../../test/db-helper.js';
import { movies, blockedMedia } from '#lib/server/db/schema.js';
import { invalidateBlockedCache } from '#lib/server/library/status.js';
import { randomUUID } from 'node:crypto';
import type { TestDatabase } from '../../../test/db-helper.js';

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

vi.mock('#lib/logging/index.js', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn()
	},
	createChildLogger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn()
	}),
	createRequestLogger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn()
	}),
	runWithLogContext: (_ctx: unknown, cb: () => unknown) => cb(),
	getRequestLogger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn()
	}),
	getRequestId: () => undefined,
	getSupportId: () => undefined,
	registerServerLogSinks: () => {}
}));

const { ContentFilterPipeline } = await import('./ContentFilterPipeline.js');

const pipeline = new ContentFilterPipeline();

interface TestItem {
	id: number;
	media_type?: string;
	title?: string;
	inLibrary?: boolean;
	hasFile?: boolean;
}

describe('ContentFilterPipeline', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	afterEach(() => {
		testDb.sqlite.exec('DELETE FROM blocked_media');
		testDb.sqlite.exec('DELETE FROM movies');
		testDb.sqlite.exec('DELETE FROM series');
		invalidateBlockedCache();
	});

	it('returns empty array for empty input', async () => {
		const result = await pipeline.apply([], { mediaType: 'movie' });
		expect(result.results).toEqual([]);
		expect(result.stages).toHaveLength(2);
	});

	it('enriches items with library status when items are in DB', async () => {
		const movieId = randomUUID();
		const tmdbId = 12345;

		testDb.db
			.insert(movies)
			.values({
				id: movieId,
				tmdbId,
				title: 'Test Movie',
				path: '/movies/test',
				hasFile: true
			})
			.run();

		const items: TestItem[] = [{ id: tmdbId }];
		const result = await pipeline.apply(items, { mediaType: 'movie' });

		expect(result.results).toHaveLength(1);
		expect(result.results[0]).toMatchObject({
			id: tmdbId,
			inLibrary: true,
			hasFile: true
		});
		expect(result.stages[0].stageName).toBe('library');
		expect(result.stages[1].stageName).toBe('blockedMedia');
	});

	it('excludes in-library items when excludeInLibrary is true', async () => {
		const movieId = randomUUID();
		const tmdbId = 55555;

		testDb.db
			.insert(movies)
			.values({
				id: movieId,
				tmdbId,
				title: 'In Library Movie',
				path: '/movies/in-library',
				hasFile: true
			})
			.run();

		const items: TestItem[] = [{ id: tmdbId }, { id: 99999 }];

		const result = await pipeline.apply(items, {
			mediaType: 'movie',
			excludeInLibrary: true
		});

		expect(result.results).toHaveLength(1);
		expect(result.results[0].id).toBe(99999);
	});

	it('keeps in-library items when excludeInLibrary is false', async () => {
		const movieId = randomUUID();
		const tmdbId = 55556;

		testDb.db
			.insert(movies)
			.values({
				id: movieId,
				tmdbId,
				title: 'In Library Movie',
				path: '/movies/in-library2',
				hasFile: true
			})
			.run();

		const items: TestItem[] = [{ id: tmdbId }, { id: 99998 }];

		const result = await pipeline.apply(items, {
			mediaType: 'movie',
			excludeInLibrary: false
		});

		expect(result.results).toHaveLength(2);
	});

	it('filters blocked media', async () => {
		const blockedId = 77777;

		testDb.db
			.insert(blockedMedia)
			.values({
				tmdbId: blockedId,
				mediaType: 'movie',
				title: 'Blocked Movie',
				reason: 'blocked for test',
				createdAt: new Date().toISOString()
			})
			.run();

		const items: TestItem[] = [{ id: blockedId }, { id: 88888 }];

		const result = await pipeline.apply(items, { mediaType: 'movie' });

		expect(result.results).toHaveLength(1);
		expect(result.results[0].id).toBe(88888);
	});

	it('skips blocked media filtering when skipBlockedMedia is true', async () => {
		const blockedId = 77778;

		testDb.db
			.insert(blockedMedia)
			.values({
				tmdbId: blockedId,
				mediaType: 'movie',
				title: 'Blocked Movie 2',
				reason: 'blocked for test',
				createdAt: new Date().toISOString()
			})
			.run();

		const items: TestItem[] = [{ id: blockedId }, { id: 88889 }];

		const result = await pipeline.apply(items, {
			mediaType: 'movie',
			skipBlockedMedia: true
		});

		expect(result.results).toHaveLength(2);
	});

	it('tracks stage runs metadata correctly', async () => {
		const items: TestItem[] = [{ id: 1 }, { id: 2 }, { id: 3 }];

		const result = await pipeline.apply(items, { mediaType: 'movie' });

		expect(result.stages).toHaveLength(2);

		const libraryStage = result.stages[0];
		expect(libraryStage.stageName).toBe('library');
		expect(libraryStage.before).toBe(3);
		expect(libraryStage.after).toBe(3);
		expect(libraryStage.skipped).toBe(false);

		const blockedStage = result.stages[1];
		expect(blockedStage.stageName).toBe('blockedMedia');
		expect(blockedStage.skipped).toBe(false);
	});

	it('combines library exclusion and blocked media filtering', async () => {
		const inLibraryId = 11111;
		const blockedId = 22222;
		const keptId = 33333;

		testDb.db
			.insert(movies)
			.values({
				id: randomUUID(),
				tmdbId: inLibraryId,
				title: 'In Library',
				path: '/movies/in-lib',
				hasFile: true
			})
			.run();

		testDb.db
			.insert(blockedMedia)
			.values({
				tmdbId: blockedId,
				mediaType: 'movie',
				title: 'Blocked Movie 3',
				reason: 'blocked',
				createdAt: new Date().toISOString()
			})
			.run();

		const items: TestItem[] = [{ id: inLibraryId }, { id: blockedId }, { id: keptId }];

		const result = await pipeline.apply(items, {
			mediaType: 'movie',
			excludeInLibrary: true
		});

		expect(result.results).toHaveLength(1);
		expect(result.results[0].id).toBe(keptId);
	});
});
