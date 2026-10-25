/**
 * Unit tests for the shared series-add orchestrator, focused on episode
 * selection: monitoredEpisodes wins over monitorType, seasons containing
 * picked episodes become monitored, and the historical monitoredSeasons
 * path keeps working. TMDB boundary mocked; database real.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper';
import { series, seasons, episodes, rootFolders, libraries } from '#lib/server/db/schema.js';

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
	fetchSeriesDetails: vi.fn(),
	fetchSeriesExternalIds: vi.fn(async () => ({ imdbId: 'tt0000222', tvdbId: 4242 })),
	validateRootFolder: vi.fn(async () => undefined),
	getAnimeSubtypeEnforcement: vi.fn(async () => false),
	getEffectiveScoringProfileId: vi.fn(async () => null),
	triggerSeriesSearch: vi.fn(async () => ({ triggered: true }))
}));
vi.mock('#lib/server/library/LibraryAddService.js', () => libraryAddMock);

vi.mock('#lib/server/subtitles/services/LanguageProfileService.js', () => ({
	getLanguageProfileService: () => ({ getProfile: vi.fn(async () => null) })
}));

vi.mock('#lib/server/services/AlternateTitleService.js', () => ({
	fetchAndStoreSeriesAlternateTitles: vi.fn(async () => undefined)
}));

vi.mock('#lib/server/library/LibraryEntityService.js', () => ({
	getLibraryEntityService: () => ({
		resolveOwningLibraryForRootFolder: vi.fn(async () => ({ id: 'lib' }))
	})
}));

vi.mock('#lib/server/library/naming/NamingSettingsService.js', () => ({
	namingSettingsService: {
		getConfigSync: () => ({ seriesFolderFormat: '{title}', episodeFileFormat: '{title}' })
	}
}));

vi.mock('#lib/server/library/naming/NamingService.js', () => ({
	NamingService: class {
		generateSeriesFolderName() {
			return 'Test Show (2020)';
		}
	}
}));

vi.mock('#lib/server/library/naming/localization.js', () => ({
	extractLanguageCodes: vi.fn(() => []),
	resolveLocalizedTitles: vi.fn(async () => ({})),
	resolveLocalizedTitlesForFormats: vi.fn(async () => ({}))
}));

vi.mock('#lib/server/metadata/EpisodeGroupService.js', () => ({
	getEffectiveEpisodeGroup: vi.fn(async () => ({ group: null, selectedGroupId: null })),
	buildSeasonsAndEpisodesFromGroup: vi.fn(() => ({ seasonValues: [], episodeValues: [] }))
}));

const tmdbMock = vi.hoisted(() => ({
	tmdb: {
		getSeason: vi.fn()
	}
}));
vi.mock('#lib/server/tmdb.js', () => tmdbMock);

const { addSeriesToLibrary } = await import('./add-series.js');
const { ValidationError } = await import('#lib/errors/index.js');

const SEASONS = [
	{ season_number: 1, episode_count: 2, name: 'S1', air_date: '2020-01-01' },
	{ season_number: 2, episode_count: 2, name: 'S2', air_date: '2021-01-01' }
];

function seasonEpisodes(seasonNumber: number) {
	return {
		episodes: [1, 2].map((n) => ({
			id: seasonNumber * 100 + n,
			season_number: seasonNumber,
			episode_number: n,
			name: `S${seasonNumber}E${n}`,
			overview: '',
			air_date: '2020-06-01',
			runtime: 42
		}))
	};
}

const baseInput = {
	tmdbId: 77,
	rootFolderId: 'rftv',
	monitored: true,
	seasonFolder: true,
	seriesType: 'standard',
	monitorType: 'all',
	monitorNewItems: 'all',
	monitorSpecials: false,
	searchOnAdd: false,
	wantsSubtitles: true
} as const;

afterAll(() => destroyTestDb(testDb));

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(episodes).run();
	testDb.db.delete(seasons).run();
	testDb.db.delete(series).run();
	testDb.db.delete(libraries).run();
	testDb.db.delete(rootFolders).run();
	testDb.db
		.insert(rootFolders)
		.values({ id: 'rftv', name: 'Shows', path: '/shows', mediaType: 'tv' })
		.run();
	testDb.db
		.insert(libraries)
		.values({ id: 'lib', name: 'Shows', slug: 'shows', mediaType: 'tv' })
		.run();
	libraryAddMock.fetchSeriesDetails.mockReset().mockResolvedValue({
		name: 'Test Show',
		poster_path: '/p.jpg',
		first_air_date: '2020-01-01',
		original_language: 'en',
		original_name: 'Test Show',
		genres: [],
		overview: '',
		status: 'Returning Series',
		networks: [],
		origin_country: [],
		seasons: SEASONS
	});
	tmdbMock.tmdb.getSeason
		.mockReset()
		.mockImplementation(async (_id: number, season: number) => seasonEpisodes(season));
});

function seasonRow(n: number) {
	return testDb.db
		.select()
		.from(seasons)
		.all()
		.find((s) => s.seasonNumber === n);
}

describe('addSeriesToLibrary', () => {
	it('creates the series, seasons, and episodes under default ordering', async () => {
		const result = await addSeriesToLibrary({ ...baseInput });
		expect(result.outcome).toBe('added');
		if (result.outcome !== 'added') return;
		expect(result.path).toBe('Test Show (2020)');
		expect(result.episodeCount).toBe(4);

		const rows = testDb.db.select().from(series).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].tvdbId).toBe(4242);
		// monitorType 'all' monitors every non-special season and episode.
		expect(seasonRow(1)?.monitored).toBe(true);
		expect(seasonRow(2)?.monitored).toBe(true);
		const episodeRows = testDb.db.select().from(episodes).all();
		expect(episodeRows.filter((e) => e.monitored)).toHaveLength(4);
	});

	it('monitors exactly the picked episodes when monitoredEpisodes is given', async () => {
		await addSeriesToLibrary({
			...baseInput,
			monitorType: 'all',
			monitoredEpisodes: [{ seasonNumber: 1, episodeNumber: 2 }]
		});

		expect(seasonRow(1)?.monitored).toBe(true);
		expect(seasonRow(2)?.monitored).toBe(false);
		const episodeRows = testDb.db.select().from(episodes).all();
		const monitored = episodeRows.filter((e) => e.monitored);
		expect(monitored).toHaveLength(1);
		expect(monitored[0]).toMatchObject({ seasonNumber: 1, episodeNumber: 2 });
	});

	it('monitors every episode of explicitly selected seasons', async () => {
		await addSeriesToLibrary({ ...baseInput, monitorType: 'none', monitoredSeasons: [2] });

		expect(seasonRow(1)?.monitored).toBe(false);
		expect(seasonRow(2)?.monitored).toBe(true);
		const episodeRows = testDb.db.select().from(episodes).all();
		const monitored = episodeRows.filter((e) => e.monitored);
		expect(monitored).toHaveLength(2);
		expect(monitored.every((e) => e.seasonNumber === 2)).toBe(true);
	});

	it('monitors all picked-episode seasons even when they are not listed', async () => {
		await addSeriesToLibrary({
			...baseInput,
			monitoredEpisodes: [
				{ seasonNumber: 1, episodeNumber: 1 },
				{ seasonNumber: 2, episodeNumber: 1 }
			]
		});
		expect(seasonRow(1)?.monitored).toBe(true);
		expect(seasonRow(2)?.monitored).toBe(true);
		const episodeRows = testDb.db.select().from(episodes).all();
		expect(episodeRows.filter((e) => e.monitored)).toHaveLength(2);
	});

	it('returns exists for a series already in the library', async () => {
		testDb.db
			.insert(series)
			.values({
				tmdbId: 77,
				title: 'Existing',
				path: 'Existing',
				libraryId: 'lib',
				rootFolderId: 'rftv'
			})
			.run();

		const result = await addSeriesToLibrary({ ...baseInput });
		expect(result).toEqual({ outcome: 'exists', seriesId: expect.any(String) });
		expect(libraryAddMock.fetchSeriesDetails).not.toHaveBeenCalled();
	});

	it('throws ValidationError for an unknown language profile', async () => {
		await expect(
			addSeriesToLibrary({
				...baseInput,
				languageProfileId: '00000000-0000-0000-0000-000000000000'
			})
		).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(ValidationError);
			return true;
		});
	});
});
