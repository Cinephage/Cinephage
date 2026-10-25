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
import { movies, rootFolders, series } from '#lib/server/db/schema.js';

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
		} finally {
			await rm(sourceDir, { recursive: true, force: true });
		}
	});
});
