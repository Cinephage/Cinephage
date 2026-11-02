import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper';
import { api } from '../../../../../test/api-helper';
import { movies, rootFolders } from '#lib/server/db/schema.js';

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
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() },
	createChildLogger: vi.fn(() => ({
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		child: vi.fn()
	}))
}));

vi.mock('#lib/server/library/LibraryAddService.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/library/LibraryAddService.js')>();
	return {
		...actual,
		validateRootFolder: actual.validateRootFolder,
		getAnimeSubtypeEnforcement: vi.fn().mockResolvedValue(false),
		fetchMovieDetails: vi.fn(),
		fetchMovieExternalIds: vi.fn().mockResolvedValue({ imdbId: null }),
		triggerMovieSearch: vi.fn().mockResolvedValue(undefined)
	};
});

vi.mock('#lib/server/library/naming/NamingSettingsService.js', () => ({
	namingSettingsService: {
		getConfigSync: vi.fn(() => ({
			movieFolderFormat: '{Title} ({Year})',
			movieFileFormat: '{Title} ({Year})'
		}))
	}
}));

vi.mock('#lib/server/library/naming/localization.js', () => ({
	extractLanguageCodes: vi.fn(() => []),
	resolveLocalizedTitles: vi.fn().mockResolvedValue(undefined)
}));

const { POST } = await import('./+server');

describe('Bulk movie additions', () => {
	beforeEach(() => clearTestDb(testDb));

	afterAll(() => destroyTestDb(testDb));

	it('rejects a read-only destination before inserting movies', async () => {
		const rootFolderId = 'read-only-movie-root';
		await testDb.db.insert(rootFolders).values({
			id: rootFolderId,
			name: 'Remote movies',
			path: '/tmp/read-only-movies',
			mediaType: 'movie',
			readOnly: true
		});

		const { status, data } = await api.post(POST, {
			tmdbIds: [9001],
			rootFolderId
		});

		expect(status).toBe(500);
		expect(data).toEqual(
			expect.objectContaining({ success: false, error: 'Root folder is read-only' })
		);
		expect(testDb.db.select().from(movies).all()).toHaveLength(0);
	});

	it('adds movies without stamping a language profile override', async () => {
		const { fetchMovieDetails } = await import('#lib/server/library/LibraryAddService.js');
		vi.mocked(fetchMovieDetails).mockResolvedValue({
			id: 9002,
			title: 'Bulk Movie',
			original_title: 'Bulk Movie',
			overview: 'x',
			release_date: '2024-01-05',
			runtime: 100,
			poster_path: null,
			backdrop_path: null,
			genres: [{ name: 'Drama' }],
			original_language: 'en',
			production_countries: [{ iso_3166_1: 'US' }],
			belongs_to_collection: null
		} as never);

		await testDb.db.insert(rootFolders).values({
			id: 'writable-movie-root',
			name: 'Movies root',
			path: '/tmp/movies-root',
			mediaType: 'movie',
			readOnly: false
		});

		const { status, data } = await api.post(POST, {
			tmdbIds: [9002],
			rootFolderId: 'writable-movie-root',
			monitored: false,
			searchOnAdd: false,
			wantsSubtitles: true
		});

		expect(status).toBe(200);
		expect(data).toEqual(expect.objectContaining({ success: true, added: 1 }));

		const [inserted] = testDb.db.select().from(movies).all();
		expect(inserted.tmdbId).toBe(9002);
		expect(inserted.wantsSubtitles).toBe(true);
		// Per-item override stays NULL so library/instance inheritance applies.
		expect(inserted.languageProfileId).toBeNull();
	});
});
