/**
 * Unit tests for the shared movie-add orchestrator (POST /api/library/movies
 * AND request approvals both run through this). The TMDB/library boundary is
 * mocked; the database is real.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper';
import { movies, rootFolders, libraries } from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis(),
	fatal: vi.fn(),
	trace: vi.fn()
}));
vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger),
	createRequestLogger: vi.fn(() => mockLogger),
	runWithLogContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn())
}));

const libraryAddMock = vi.hoisted(() => ({
	fetchMovieDetails: vi.fn(),
	fetchMovieExternalIds: vi.fn(async () => ({ imdbId: 'tt0000111' })),
	validateRootFolder: vi.fn(async () => undefined),
	getAnimeSubtypeEnforcement: vi.fn(async () => false),
	getEffectiveScoringProfileId: vi.fn(async () => null),
	triggerMovieSearch: vi.fn(async () => ({ triggered: true }))
}));
vi.mock('#lib/server/library/LibraryAddService.js', () => libraryAddMock);

vi.mock('#lib/server/subtitles/services/LanguageProfileService.js', () => ({
	getLanguageProfileService: () => ({ getProfile: vi.fn(async () => null) })
}));

vi.mock('#lib/server/services/AlternateTitleService.js', () => ({
	fetchAndStoreMovieAlternateTitles: vi.fn(async () => undefined)
}));

vi.mock('#lib/server/library/LibraryEntityService.js', () => ({
	getLibraryEntityService: () => ({
		resolveOwningLibraryForRootFolder: vi.fn(async () => ({ id: 'lib' }))
	})
}));

vi.mock('#lib/server/library/naming/NamingSettingsService.js', () => ({
	namingSettingsService: {
		getConfigSync: () => ({ movieFolderFormat: '{title}', movieFileFormat: '{title}' })
	}
}));

const { addMovieToLibrary } = await import('./add-movie.js');
const { ValidationError } = await import('#lib/errors/index.js');

function movieDetails(overrides: Record<string, unknown> = {}) {
	return {
		title: 'Test Movie',
		poster_path: '/p.jpg',
		release_date: '2023-05-05',
		original_language: 'en',
		original_title: 'Test Movie',
		genres: [{ name: 'Drama' }],
		overview: 'Overview',
		...overrides
	};
}

const baseInput = {
	tmdbId: 99,
	rootFolderId: 'rf',
	desiredQualities: null,
	monitored: true,
	minimumAvailability: 'released',
	availabilityDelay: 0,
	searchOnAdd: true,
	wantsSubtitles: true
} as const;

afterAll(() => destroyTestDb(testDb));

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(movies).run();
	testDb.db.delete(libraries).run();
	testDb.db.delete(rootFolders).run();
	testDb.db
		.insert(rootFolders)
		.values({ id: 'rf', name: 'Movies', path: '/movies', mediaType: 'movie' })
		.run();
	testDb.db
		.insert(libraries)
		.values({ id: 'lib', name: 'Movies', slug: 'movies', mediaType: 'movie' })
		.run();
	libraryAddMock.fetchMovieDetails.mockReset().mockResolvedValue(movieDetails());
	libraryAddMock.triggerMovieSearch.mockReset().mockResolvedValue({ triggered: true });
	libraryAddMock.validateRootFolder.mockReset().mockResolvedValue(undefined);
});

describe('addMovieToLibrary', () => {
	it('inserts the movie, external ids, and triggers a search on add', async () => {
		const result = await addMovieToLibrary({ ...baseInput });

		expect(result.outcome).toBe('added');
		if (result.outcome !== 'added') return;
		expect(result.tmdbId).toBe(99);
		expect(result.monitored).toBe(true);
		expect(result.searchTriggered).toBe(true);

		const row = testDb.db
			.select()
			.from(movies)
			.all()
			.find((m) => m.tmdbId === 99);
		expect(row).toBeDefined();
		expect(row!.imdbId).toBe('tt0000111');
		expect(row!.hasFile).toBe(false);
		expect(row!.title).toContain('Test Movie');
		expect(row!.path).toContain('Test Movie');
		expect(libraryAddMock.triggerMovieSearch).toHaveBeenCalledTimes(1);
	});

	it('skips the search when searchOnAdd is false', async () => {
		await addMovieToLibrary({ ...baseInput, searchOnAdd: false });
		expect(libraryAddMock.triggerMovieSearch).not.toHaveBeenCalled();
	});

	it('returns exists without touching TMDB when the movie is already present', async () => {
		testDb.db
			.insert(movies)
			.values({
				tmdbId: 99,
				title: 'Existing',
				path: 'Existing',
				libraryId: 'lib',
				rootFolderId: 'rf'
			})
			.run();

		const result = await addMovieToLibrary({ ...baseInput });
		expect(result).toEqual({ outcome: 'exists', movieId: expect.any(String) });
		expect(libraryAddMock.fetchMovieDetails).not.toHaveBeenCalled();
		expect(libraryAddMock.triggerMovieSearch).not.toHaveBeenCalled();
	});

	it('throws ValidationError for an unknown language profile', async () => {
		await expect(
			addMovieToLibrary({ ...baseInput, languageProfileId: '00000000-0000-0000-0000-000000000000' })
		).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(ValidationError);
			return true;
		});
	});

	it('propagates root-folder validation failures', async () => {
		libraryAddMock.validateRootFolder.mockRejectedValue(
			new ValidationError('Root folder is not writable')
		);
		await expect(addMovieToLibrary({ ...baseInput })).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(ValidationError);
			return true;
		});
		expect(testDb.db.select().from(movies).all()).toHaveLength(0);
	});
});
