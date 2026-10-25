import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper.js';
import { api } from '../../../test/api-helper.js';
import { movies, series } from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();
const mocks = vi.hoisted(() => ({
	validateRootFolder: vi.fn(),
	fetchMovieDetails: vi.fn(),
	fetchSeriesDetails: vi.fn(),
	getAnimeSubtypeEnforcement: vi.fn().mockResolvedValue(false),
	tmdbGetCollection: vi.fn()
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
vi.mock('#lib/server/library/LibraryAddService.js', () => ({
	validateRootFolder: mocks.validateRootFolder,
	fetchMovieDetails: mocks.fetchMovieDetails,
	fetchSeriesDetails: mocks.fetchSeriesDetails,
	getAnimeSubtypeEnforcement: mocks.getAnimeSubtypeEnforcement,
	getEffectiveScoringProfileId: vi.fn(),
	getLanguageProfileId: vi.fn(),
	fetchMovieExternalIds: vi.fn(),
	fetchSeriesExternalIds: vi.fn(),
	triggerMovieSearch: vi.fn(),
	triggerSeriesSearch: vi.fn()
}));
vi.mock('#lib/server/tmdb.js', () => ({ tmdb: { getCollection: mocks.tmdbGetCollection } }));
vi.mock('#lib/server/services/AlternateTitleService.js', () => ({
	fetchAndStoreMovieAlternateTitles: vi.fn(),
	fetchAndStoreSeriesAlternateTitles: vi.fn()
}));
vi.mock('#lib/server/library/LibraryEntityService.js', () => ({
	getLibraryEntityService: vi.fn(() => ({
		resolveOwningLibraryForRootFolder: vi.fn()
	}))
}));
vi.mock('#lib/server/library/LibraryMediaEvents.js', () => ({
	libraryMediaEvents: { emitLibraryDataChanged: vi.fn() }
}));
vi.mock('#lib/server/metadata/EpisodeGroupService.js', () => ({
	getEffectiveEpisodeGroup: vi.fn(),
	buildSeasonsAndEpisodesFromGroup: vi.fn()
}));
vi.mock('#lib/server/naming/NamingSettingsService.js', () => ({
	namingSettingsService: {
		getConfigSync: vi.fn(() => ({ movieFolderFormat: '', movieFileFormat: '' }))
	}
}));
vi.mock('#lib/server/library/naming/NamingSettingsService.js', () => ({
	namingSettingsService: {
		getConfigSync: vi.fn(() => ({ movieFolderFormat: '', movieFileFormat: '' }))
	}
}));
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

const { POST: addMovie } = await import('./movies/+server.js');
const { POST: addSeries } = await import('./series/+server.js');
const { POST: trackCollection } = await import('./collections/[tmdbId]/track/+server.js');

const movieDetails = {
	title: 'Guarded Movie',
	original_title: 'Guarded Movie',
	release_date: '2024-01-01',
	genres: [],
	production_countries: [],
	overview: '',
	poster_path: null,
	backdrop_path: null,
	runtime: 90
};
const seriesDetails = {
	name: 'Guarded Series',
	original_name: 'Guarded Series',
	first_air_date: '2024-01-01',
	genres: [],
	origin_country: [],
	production_countries: [],
	overview: '',
	poster_path: null,
	backdrop_path: null,
	status: 'Ended',
	networks: [],
	seasons: []
};

describe('read-only library destinations', () => {
	beforeEach(() => {
		clearTestDb(testDb);
		vi.clearAllMocks();
		mocks.getAnimeSubtypeEnforcement.mockResolvedValue(false);
		mocks.validateRootFolder.mockRejectedValue(new Error('Root folder is read-only'));
	});

	afterAll(() => destroyTestDb(testDb));

	it('rejects a movie add before inserting the movie', async () => {
		mocks.fetchMovieDetails.mockResolvedValue(movieDetails);

		const result = await api.post(addMovie, { tmdbId: 101, rootFolderId: 'read-only' });

		expect(result.status).toBe(500);
		expect(result.data).toEqual(expect.objectContaining({ error: 'Root folder is read-only' }));
		expect(mocks.validateRootFolder).toHaveBeenCalledWith(
			'read-only',
			'movie',
			expect.objectContaining({ requireWritable: true })
		);
		expect(testDb.db.select().from(movies).all()).toHaveLength(0);
	});

	it('rejects a series add before inserting the series', async () => {
		mocks.fetchSeriesDetails.mockResolvedValue(seriesDetails);

		const result = await api.post(addSeries, { tmdbId: 202, rootFolderId: 'read-only' });

		expect(result.status).toBe(500);
		expect(result.data).toEqual(expect.objectContaining({ error: 'Root folder is read-only' }));
		expect(mocks.validateRootFolder).toHaveBeenCalledWith(
			'read-only',
			'tv',
			expect.objectContaining({ requireWritable: true })
		);
		expect(testDb.db.select().from(series).all()).toHaveLength(0);
	});

	it('skips every collection part when the destination is read-only', async () => {
		mocks.tmdbGetCollection.mockResolvedValue({
			name: 'Guarded Collection',
			parts: [
				{ id: 301, title: 'Part One' },
				{ id: 302, title: 'Part Two' }
			]
		});
		mocks.fetchMovieDetails.mockResolvedValue(movieDetails);

		const result = await api.post(
			trackCollection,
			{ rootFolderId: 'read-only' },
			{ params: { tmdbId: '77' } }
		);

		expect(result.status).toBe(200);
		expect(result.data).toEqual(expect.objectContaining({ added: 0, errors: expect.any(Array) }));
		expect((result.data as { errors: unknown[] }).errors).toHaveLength(2);
		expect(mocks.validateRootFolder).toHaveBeenCalledTimes(2);
		expect(mocks.validateRootFolder).toHaveBeenCalledWith(
			'read-only',
			'movie',
			expect.objectContaining({ requireWritable: true })
		);
		expect(testDb.db.select().from(movies).all()).toHaveLength(0);
	});
});
