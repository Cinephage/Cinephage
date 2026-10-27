import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper.js';
import { downloadHistory, movies, rootFolders, series } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

const testDb: TestDatabase = createTestDb();
const mocks = vi.hoisted(() => ({
	getMovie: vi.fn(),
	validateRootFolder: vi.fn(),
	transferFileWithMode: vi.fn()
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
vi.mock('#lib/server/tmdb.js', () => ({ tmdb: { getMovie: mocks.getMovie } }));
vi.mock('#lib/server/library/LibraryAddService.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/library/LibraryAddService.js')>();
	return { ...actual, validateRootFolder: mocks.validateRootFolder };
});
vi.mock('#lib/server/downloadClients/import/FileTransfer.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#lib/server/downloadClients/import/FileTransfer.js')>();
	return { ...actual, transferFileWithMode: mocks.transferFileWithMode };
});
vi.mock('#lib/logging/index.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
	createChildLogger: vi.fn(() => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: vi.fn()
	}))
}));

const { manualImportService } = await import('./manual-import-service.js');

describe('ManualImportService read-only destinations', () => {
	beforeEach(() => {
		clearTestDb(testDb);
		vi.clearAllMocks();
		mocks.getMovie.mockResolvedValue({
			title: 'Imported Movie',
			original_title: 'Imported Movie',
			release_date: '2024-01-01',
			genres: [],
			production_countries: [],
			belongs_to_collection: null
		});
		mocks.validateRootFolder.mockRejectedValue(new Error('Root folder is read-only'));
	});

	afterAll(() => destroyTestDb(testDb));

	it('rejects a new movie import before transferring the source file', async () => {
		const sourceDir = await mkdtemp(join(tmpdir(), 'cinephage-read-only-import-'));
		const sourcePath = join(sourceDir, 'Imported.Movie.2024.mkv');
		try {
			await writeFile(sourcePath, 'video');
			await testDb.db.insert(rootFolders).values({
				id: 'read-only',
				name: 'Remote movies',
				path: '/remote/movies',
				mediaType: 'movie',
				readOnly: true
			});

			await expect(
				manualImportService.executeImport({
					sourcePath,
					mediaType: 'movie',
					tmdbId: 404,
					importTarget: 'new',
					rootFolderId: 'read-only'
				})
			).rejects.toThrow('Root folder is read-only');

			expect(mocks.transferFileWithMode).not.toHaveBeenCalled();
		} finally {
			await rm(sourceDir, { recursive: true, force: true });
		}
	});

	it('rejects an existing movie import before transferring the source file', async () => {
		const sourceDir = await mkdtemp(join(tmpdir(), 'cinephage-read-only-existing-movie-'));
		const sourcePath = join(sourceDir, 'Existing.Movie.2024.mkv');
		try {
			await writeFile(sourcePath, 'video');
			await testDb.db.insert(rootFolders).values({
				id: 'read-only-movie',
				name: 'Remote movies',
				path: '/remote/movies',
				mediaType: 'movie',
				readOnly: true
			});
			await testDb.db.insert(movies).values({
				id: 'movie-1',
				tmdbId: 405,
				title: 'Existing Movie',
				path: 'Existing Movie (2024)',
				rootFolderId: 'read-only-movie'
			});

			await expect(
				manualImportService.executeImport({
					sourcePath,
					mediaType: 'movie',
					tmdbId: 405,
					importTarget: 'existing'
				})
			).rejects.toThrow('Cannot import to read-only root folder');

			expect(mocks.transferFileWithMode).not.toHaveBeenCalled();

			const [history] = await testDb.db
				.select()
				.from(downloadHistory)
				.where(eq(downloadHistory.movieId, 'movie-1'));
			expect(history.status).toBe('failed');
			expect(history.statusReason).toBe('Cannot import to read-only root folder');
			expect(history.downloadClientName).toBe('Manual Import');
		} finally {
			await rm(sourceDir, { recursive: true, force: true });
		}
	});

	it('rejects an existing TV import before transferring the source file', async () => {
		const sourceDir = await mkdtemp(join(tmpdir(), 'cinephage-read-only-existing-tv-'));
		const sourcePath = join(sourceDir, 'Existing.Show.S01E01.mkv');
		try {
			await writeFile(sourcePath, 'video');
			await testDb.db.insert(rootFolders).values({
				id: 'read-only-tv',
				name: 'Remote TV',
				path: '/remote/tv',
				mediaType: 'tv',
				readOnly: true
			});
			await testDb.db.insert(series).values({
				id: 'series-1',
				tmdbId: 406,
				title: 'Existing Show',
				path: 'Existing Show',
				rootFolderId: 'read-only-tv'
			});

			await expect(
				manualImportService.executeImport({
					sourcePath,
					mediaType: 'tv',
					tmdbId: 406,
					importTarget: 'existing'
				})
			).rejects.toThrow('Cannot import to read-only root folder');

			expect(mocks.transferFileWithMode).not.toHaveBeenCalled();

			const [history] = await testDb.db
				.select()
				.from(downloadHistory)
				.where(eq(downloadHistory.seriesId, 'series-1'));
			expect(history.status).toBe('failed');
			expect(history.statusReason).toBe('Cannot import to read-only root folder');
		} finally {
			await rm(sourceDir, { recursive: true, force: true });
		}
	});

	it('records a successful import as a two-state "imported" history row', async () => {
		await testDb.db.insert(rootFolders).values({
			id: 'success-root',
			name: 'Movies',
			path: '/movies',
			mediaType: 'movie'
		});
		await testDb.db.insert(movies).values({
			id: 'movie-success-1',
			tmdbId: 777,
			title: 'Imported Movie',
			path: 'Imported Movie (2024)',
			rootFolderId: 'success-root'
		});
		const service = manualImportService as unknown as {
			recordImportHistory: (
				request: { sourcePath?: string; mediaType: 'movie' | 'tv'; tmdbId: number },
				outcome: { success: true; result: Record<string, unknown> }
			) => Promise<void>;
		};

		const destDir = await mkdtemp(join(tmpdir(), 'cinephage-history-success-'));
		const importedPath = join(destDir, 'Imported Movie (2024).mkv');
		try {
			await writeFile(importedPath, 'x'.repeat(1234));

			await service.recordImportHistory(
				{
					sourcePath: '/downloads/Imported.Movie.2024.1080p.WEB-DL.x264-GROUP.mkv',
					mediaType: 'movie',
					tmdbId: 777
				},
				{
					success: true,
					result: {
						mediaType: 'movie',
						libraryId: 'movie-success-1',
						importedPath,
						importedPaths: [importedPath],
						transferMode: 'hardlink'
					}
				}
			);

			const [history] = await testDb.db
				.select()
				.from(downloadHistory)
				.where(eq(downloadHistory.movieId, 'movie-success-1'));
			expect(history.status).toBe('imported');
			expect(history.statusReason).toBeNull();
			expect(history.transferMode).toBe('hardlink');
			expect(history.downloadClientName).toBe('Manual Import');
			expect(history.indexerName).toBe('Manual');
			expect(history.size).toBe(1234);
			expect(history.quality).toMatchObject({ resolution: '1080p', source: 'webdl' });
			expect(history.releaseGroup).toBe('GROUP');
		} finally {
			await rm(destDir, { recursive: true, force: true });
		}
	});
});
