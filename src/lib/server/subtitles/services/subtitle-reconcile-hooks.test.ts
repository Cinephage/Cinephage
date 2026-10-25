import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { movies, rootFolders, series, episodeFiles } from '#lib/server/db/schema.js';

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

const scannerMock = vi.hoisted(() => ({
	scanMovieSubtitles: vi.fn().mockResolvedValue({}),
	scanSeriesSubtitles: vi.fn().mockResolvedValue({})
}));

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

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

vi.mock('./SubtitleScannerService', () => ({
	getSubtitleScannerService: () => scannerMock,
	SubtitleScannerService: class {}
}));

const {
	scheduleReconcileRootFolder,
	scheduleReconcileMovie,
	resetSubtitleReconcileHooks,
	SUBTITLE_RECONCILE_DEBOUNCE_MS
} = await import('./subtitle-reconcile-hooks');

describe('subtitle reconcile hooks', () => {
	beforeEach(async () => {
		testDb.db.delete(episodeFiles).run();
		testDb.db.delete(movies).run();
		testDb.db.delete(series).run();
		testDb.db.delete(rootFolders).run();
		scannerMock.scanMovieSubtitles.mockClear();
		scannerMock.scanSeriesSubtitles.mockClear();
		vi.useFakeTimers();
	});

	afterEach(() => {
		resetSubtitleReconcileHooks();
		vi.useRealTimers();
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	it('enumerates a root folder and schedules one debounced reconcile per media item with files', async () => {
		testDb.db
			.insert(rootFolders)
			.values({ id: 'rf-1', name: 'Media', path: '/media', mediaType: 'movie' })
			.run();
		testDb.db
			.insert(movies)
			.values({
				id: 'movie-1',
				tmdbId: 1,
				title: 'Movie',
				path: 'Movie',
				rootFolderId: 'rf-1',
				hasFile: true
			})
			.run();
		testDb.db
			.insert(series)
			.values({ id: 'series-1', tmdbId: 2, title: 'Show', path: 'Show', rootFolderId: 'rf-1' })
			.run();
		testDb.db
			.insert(episodeFiles)
			.values({
				seriesId: 'series-1',
				seasonNumber: 1,
				episodeIds: ['ep-1'],
				relativePath: 'Season 01/e.mkv',
				size: 1024
			})
			.run();

		await scheduleReconcileRootFolder('rf-1');

		// Debounced: nothing has run yet.
		expect(scannerMock.scanMovieSubtitles).not.toHaveBeenCalled();
		expect(scannerMock.scanSeriesSubtitles).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(SUBTITLE_RECONCILE_DEBOUNCE_MS + 1);

		expect(scannerMock.scanMovieSubtitles).toHaveBeenCalledWith('movie-1');
		expect(scannerMock.scanSeriesSubtitles).toHaveBeenCalledWith('series-1');
	});

	it('does not schedule items with no media files (wanted-but-missing, arr parity)', async () => {
		testDb.db
			.insert(rootFolders)
			.values({ id: 'rf-2', name: 'Media 2', path: '/media2', mediaType: 'movie' })
			.run();
		// hasFile=false movie: no folder on disk by design.
		testDb.db
			.insert(movies)
			.values({ id: 'movie-2', tmdbId: 3, title: 'Wanted', path: 'Wanted', rootFolderId: 'rf-2' })
			.run();
		// Series with zero episode files: files were removed / never acquired.
		testDb.db
			.insert(series)
			.values({ id: 'series-2', tmdbId: 4, title: 'Zombie', path: 'Zombie', rootFolderId: 'rf-2' })
			.run();

		await scheduleReconcileRootFolder('rf-2');
		await vi.advanceTimersByTimeAsync(SUBTITLE_RECONCILE_DEBOUNCE_MS + 1);

		expect(scannerMock.scanMovieSubtitles).not.toHaveBeenCalled();
		expect(scannerMock.scanSeriesSubtitles).not.toHaveBeenCalled();
	});

	it('coalesces repeated schedules for the same media item into one run', async () => {
		scheduleReconcileMovie('movie-1');
		await vi.advanceTimersByTimeAsync(10);
		scheduleReconcileMovie('movie-1');

		await vi.advanceTimersByTimeAsync(SUBTITLE_RECONCILE_DEBOUNCE_MS + 1);

		expect(scannerMock.scanMovieSubtitles).toHaveBeenCalledTimes(1);
	});

	it('never throws when enumeration fails', async () => {
		await expect(scheduleReconcileRootFolder('missing-root')).resolves.toBeUndefined();
	});
});
