import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type {
	SubtitleSearchCriteria,
	SubtitleSearchResult,
	AggregatedSearchResult
} from '../types';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { movies, movieFiles, rootFolders } from '#lib/server/db/schema.js';

const mockGetMovieExternalIds = vi.fn();
const mockGetTvExternalIds = vi.fn();

const mockGetEnabledProviders = vi.hoisted(() => vi.fn());
const mockRecordSuccess = vi.hoisted(() => vi.fn());
const mockRecordError = vi.hoisted(() => vi.fn());
const mockAcquireRateLimit = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		getMovieExternalIds: (...args: unknown[]) => mockGetMovieExternalIds(...args),
		getTvExternalIds: (...args: unknown[]) => mockGetTvExternalIds(...args)
	}
}));

vi.mock('./SubtitleProviderManager', () => ({
	getSubtitleProviderManager: () => ({
		getEnabledProviders: mockGetEnabledProviders,
		recordSuccess: mockRecordSuccess,
		recordError: mockRecordError,
		acquireRateLimit: mockAcquireRateLimit
	})
}));

vi.mock('./SubtitleScoringService', () => ({
	getSubtitleScoringService: () => ({
		score: (result: SubtitleSearchResult) => {
			result.matchScore = 80;
			return 80;
		},
		rank: (results: SubtitleSearchResult[]) => results
	})
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

const { SubtitleSearchService, clearIdCacheForTests } = await import('./SubtitleSearchService');

afterAll(() => {
	destroyTestDb(testDb);
});

type TestableSubtitleSearchService = {
	enrichCriteria(criteria: SubtitleSearchCriteria): Promise<SubtitleSearchCriteria>;
};

describe('SubtitleSearchService - enrichCriteria', () => {
	let service: TestableSubtitleSearchService;

	beforeEach(() => {
		service = SubtitleSearchService.getInstance() as unknown as TestableSubtitleSearchService;
		mockGetMovieExternalIds.mockReset();
		mockGetTvExternalIds.mockReset();
		clearIdCacheForTests();
	});

	it('should return criteria unchanged when no tmdbId', async () => {
		const criteria: SubtitleSearchCriteria = {
			title: 'Inception',
			year: 2010,
			languages: ['en']
		};

		const result = await service.enrichCriteria(criteria);

		expect(result).toBe(criteria);
		expect(mockGetMovieExternalIds).not.toHaveBeenCalled();
	});

	it('should return criteria unchanged when imdbId already present', async () => {
		const criteria: SubtitleSearchCriteria = {
			title: 'Inception',
			year: 2010,
			tmdbId: 27205,
			imdbId: 'tt1375666',
			languages: ['en']
		};

		const result = await service.enrichCriteria(criteria);

		expect(result.imdbId).toBe('tt1375666');
		expect(mockGetMovieExternalIds).not.toHaveBeenCalled();
	});

	it('should resolve imdbId for movies via TMDB', async () => {
		mockGetMovieExternalIds.mockResolvedValue({
			imdb_id: 'tt1375666',
			tvdb_id: null,
			wikidata_id: null,
			facebook_id: null,
			instagram_id: null,
			twitter_id: null
		});

		const criteria: SubtitleSearchCriteria = {
			title: 'Inception',
			year: 2010,
			tmdbId: 27205,
			languages: ['en']
		};

		const result = await service.enrichCriteria(criteria);

		expect(result.imdbId).toBe('tt1375666');
		expect(mockGetMovieExternalIds).toHaveBeenCalledWith(27205);
	});

	it('should resolve imdbId and tvdbId for TV shows via TMDB', async () => {
		mockGetTvExternalIds.mockResolvedValue({
			imdb_id: 'tt0903747',
			tvdb_id: 81189,
			wikidata_id: null,
			facebook_id: null,
			instagram_id: null,
			twitter_id: null
		});

		const criteria: SubtitleSearchCriteria = {
			title: 'Breaking Bad',
			seriesTitle: 'Breaking Bad',
			season: 1,
			episode: 1,
			tmdbId: 1396,
			languages: ['en']
		};

		const result = await service.enrichCriteria(criteria);

		expect(result.imdbId).toBe('tt0903747');
		expect(result.tvdbId).toBe(81189);
		expect(mockGetTvExternalIds).toHaveBeenCalledWith(1396);
	});

	it('should not resolve tvdbId for movies', async () => {
		mockGetMovieExternalIds.mockResolvedValue({
			imdb_id: 'tt1375666',
			tvdb_id: 123,
			wikidata_id: null,
			facebook_id: null,
			instagram_id: null,
			twitter_id: null
		});

		const criteria: SubtitleSearchCriteria = {
			title: 'Inception',
			year: 2010,
			tmdbId: 27205,
			languages: ['en']
		};

		const result = await service.enrichCriteria(criteria);

		expect(result.imdbId).toBe('tt1375666');
		expect(result.tvdbId).toBeUndefined();
		expect(mockGetMovieExternalIds).toHaveBeenCalledWith(27205);
	});

	it('should handle TMDB API failure gracefully', async () => {
		mockGetMovieExternalIds.mockRejectedValue(new Error('TMDB API down'));

		const criteria: SubtitleSearchCriteria = {
			title: 'Inception',
			year: 2010,
			tmdbId: 27205,
			languages: ['en']
		};

		const result = await service.enrichCriteria(criteria);

		expect(result.imdbId).toBeUndefined();
		expect(result.title).toBe('Inception');
	});

	it('should handle null imdb_id from TMDB', async () => {
		mockGetMovieExternalIds.mockResolvedValue({
			imdb_id: null,
			tvdb_id: null,
			wikidata_id: null,
			facebook_id: null,
			instagram_id: null,
			twitter_id: null
		});

		const criteria: SubtitleSearchCriteria = {
			title: 'Unknown Movie',
			tmdbId: 999999,
			languages: ['en']
		};

		const result = await service.enrichCriteria(criteria);

		expect(result.imdbId).toBeUndefined();
	});

	it('should use cached results on second call', async () => {
		mockGetMovieExternalIds.mockResolvedValue({
			imdb_id: 'tt1375666',
			tvdb_id: null,
			wikidata_id: null,
			facebook_id: null,
			instagram_id: null,
			twitter_id: null
		});

		const criteria1: SubtitleSearchCriteria = {
			title: 'Inception',
			tmdbId: 27205,
			languages: ['en']
		};

		await service.enrichCriteria(criteria1);
		expect(mockGetMovieExternalIds).toHaveBeenCalledTimes(1);

		const criteria2: SubtitleSearchCriteria = {
			title: 'Inception',
			tmdbId: 27205,
			languages: ['en']
		};

		const result2 = await service.enrichCriteria(criteria2);
		expect(result2.imdbId).toBe('tt1375666');
		expect(mockGetMovieExternalIds).toHaveBeenCalledTimes(1);
	});

	it('should cache TV and movie separately for same tmdbId', async () => {
		mockGetMovieExternalIds.mockResolvedValue({
			imdb_id: 'ttMovie',
			tvdb_id: null,
			wikidata_id: null,
			facebook_id: null,
			instagram_id: null,
			twitter_id: null
		});
		mockGetTvExternalIds.mockResolvedValue({
			imdb_id: 'ttTv',
			tvdb_id: 99999,
			wikidata_id: null,
			facebook_id: null,
			instagram_id: null,
			twitter_id: null
		});

		const movieCriteria: SubtitleSearchCriteria = {
			title: 'Battlestar',
			tmdbId: 12345,
			languages: ['en']
		};

		const tvCriteria: SubtitleSearchCriteria = {
			title: 'Battlestar',
			tmdbId: 12345,
			season: 1,
			episode: 1,
			languages: ['en']
		};

		const movieResult = await service.enrichCriteria(movieCriteria);
		const tvResult = await service.enrichCriteria(tvCriteria);

		expect(movieResult.imdbId).toBe('ttMovie');
		expect(movieResult.tvdbId).toBeUndefined();
		expect(tvResult.imdbId).toBe('ttTv');
		expect(tvResult.tvdbId).toBe(99999);
	});
});

describe('SubtitleSearchService - searchForMovie', () => {
	const ROOT_PATH = '/tmp/cinephage-subtitle-search-service';

	function buildSearchResult(overrides: Partial<SubtitleSearchResult> = {}): SubtitleSearchResult {
		return {
			providerId: 'opensubtitles',
			providerName: 'OpenSubtitles',
			providerSubtitleId: 'sub-default',
			language: 'en',
			title: 'Test Movie',
			isForced: false,
			isHearingImpaired: false,
			format: 'srt',
			isHashMatch: false,
			matchScore: 80,
			...overrides
		};
	}

	function buildAggregatedResult(results: SubtitleSearchResult[]): AggregatedSearchResult {
		return {
			results,
			totalResults: results.length,
			searchTimeMs: 5,
			providerResults: [
				{
					providerId: 'opensubtitles',
					providerName: 'OpenSubtitles',
					resultCount: results.length,
					searchTimeMs: 5
				}
			]
		};
	}

	async function seedRootFolderAndMovie(): Promise<string> {
		const rootFolderId = 'root-1';
		const movieId = 'movie-1';
		await testDb.db.insert(rootFolders).values({
			id: rootFolderId,
			name: 'Movies',
			path: ROOT_PATH,
			mediaType: 'movie'
		});
		await testDb.db.insert(movies).values({
			id: movieId,
			tmdbId: 101,
			title: 'Test Movie',
			path: 'Test Movie (2024)',
			rootFolderId
		});
		return movieId;
	}

	beforeEach(() => {
		testDb.db.delete(movieFiles).run();
		testDb.db.delete(movies).run();
		testDb.db.delete(rootFolders).run();
	});

	it('runs one search per movie file and tags each result with its movieFileId', async () => {
		const movieId = await seedRootFolderAndMovie();
		await testDb.db.insert(movieFiles).values([
			{ id: 'file-2160p', movieId, relativePath: 'Test.Movie.2024.2160p.mkv', size: 1000 },
			{ id: 'file-1080p', movieId, relativePath: 'Test.Movie.2024.1080p.mkv', size: 2000 }
		]);

		const service = SubtitleSearchService.getInstance();
		let callIndex = 0;
		const searchSpy = vi.spyOn(service, 'search').mockImplementation(async () => {
			const idx = callIndex++;
			return buildAggregatedResult([buildSearchResult({ providerSubtitleId: `sub-${idx}` })]);
		});

		try {
			const result = await service.searchForMovie(movieId, ['en']);

			expect(searchSpy).toHaveBeenCalledTimes(2);
			expect(result.results).toHaveLength(2);
			expect(result.totalResults).toBe(2);

			const taggedIds = result.results.map((r) => r.movieFileId).sort();
			expect(taggedIds).toEqual(['file-1080p', 'file-2160p']);

			// Lock the file->batch mapping (robust to processing order): the spy
			// returns sub-${callIndex} per call, so find which call searched a
			// given file (by matching filePath) and assert that result carries
			// that file's movieFileId.
			for (const file of [
				{ id: 'file-2160p', marker: '2160p' },
				{ id: 'file-1080p', marker: '1080p' }
			]) {
				const callIdx = searchSpy.mock.calls.findIndex((call) => {
					const c = call[0] as SubtitleSearchCriteria;
					return c.filePath?.includes(file.marker) ?? false;
				});
				expect(callIdx).toBeGreaterThanOrEqual(0);

				const matching = result.results.find((r) => r.providerSubtitleId === `sub-${callIdx}`);
				expect(matching, `result for ${file.id} should exist`).toBeTruthy();
				expect(matching!.movieFileId).toBe(file.id);
			}

			const firstCriteria = searchSpy.mock.calls[0][0] as SubtitleSearchCriteria;
			const secondCriteria = searchSpy.mock.calls[1][0] as SubtitleSearchCriteria;
			expect(firstCriteria.filePath).toContain('.mkv');
			expect(firstCriteria.fileSize).toBeTypeOf('number');
			expect(secondCriteria.filePath).toContain('.mkv');
			expect(secondCriteria.fileSize).toBeTypeOf('number');
		} finally {
			searchSpy.mockRestore();
		}
	});

	it('continues searching remaining files when one file search throws', async () => {
		const movieId = await seedRootFolderAndMovie();
		await testDb.db.insert(movieFiles).values([
			{ id: 'file-broken', movieId, relativePath: 'Test.Movie.2024.2160p.mkv', size: 1000 },
			{ id: 'file-ok', movieId, relativePath: 'Test.Movie.2024.1080p.mkv', size: 2000 }
		]);

		const service = SubtitleSearchService.getInstance();
		const searchSpy = vi.spyOn(service, 'search').mockImplementation(async (criteria) => {
			// The file whose path contains '2160p' blows up; the other returns a result.
			if (criteria.filePath?.includes('2160p')) {
				throw new Error('unexpected DB error');
			}
			return buildAggregatedResult([buildSearchResult({ providerSubtitleId: 'sub-ok' })]);
		});

		try {
			const result = await service.searchForMovie(movieId, ['en']);

			expect(searchSpy).toHaveBeenCalledTimes(2);
			// Only the surviving file produced results; the call did not reject.
			expect(result.results).toHaveLength(1);
			expect(result.results[0].providerSubtitleId).toBe('sub-ok');
			expect(result.results[0].movieFileId).toBe('file-ok');
			expect(result.totalResults).toBe(1);
		} finally {
			searchSpy.mockRestore();
		}
	});

	it('runs a single search for a single-file movie and tags the result (backward compat)', async () => {
		const movieId = await seedRootFolderAndMovie();
		await testDb.db.insert(movieFiles).values({
			id: 'file-1',
			movieId,
			relativePath: 'Test.Movie.2024.mkv',
			size: 5000
		});

		const service = SubtitleSearchService.getInstance();
		const searchSpy = vi
			.spyOn(service, 'search')
			.mockResolvedValue(
				buildAggregatedResult([buildSearchResult({ providerSubtitleId: 'sub-single' })])
			);

		try {
			const result = await service.searchForMovie(movieId, ['en']);

			expect(searchSpy).toHaveBeenCalledTimes(1);
			expect(result.results).toHaveLength(1);
			expect(result.results[0].movieFileId).toBe('file-1');
			expect(result.totalResults).toBe(1);
		} finally {
			searchSpy.mockRestore();
		}
	});

	it('falls back to a metadata-only search when the movie has no files', async () => {
		const movieId = await seedRootFolderAndMovie();

		const service = SubtitleSearchService.getInstance();
		const searchSpy = vi
			.spyOn(service, 'search')
			.mockResolvedValue(
				buildAggregatedResult([buildSearchResult({ providerSubtitleId: 'sub-meta' })])
			);

		try {
			const result = await service.searchForMovie(movieId, ['en']);

			expect(searchSpy).toHaveBeenCalledTimes(1);
			expect(result.results).toHaveLength(1);
			expect(result.results[0].movieFileId).toBeUndefined();

			const criteria = searchSpy.mock.calls[0][0] as SubtitleSearchCriteria;
			expect(criteria.filePath).toBeUndefined();
			expect(criteria.fileSize).toBeUndefined();
			expect(criteria.title).toBe('Test Movie');
		} finally {
			searchSpy.mockRestore();
		}
	});

	it('passes the movie original language to providers as a canonical tag', async () => {
		const rootFolderId = 'root-original-language';
		const movieId = 'movie-original-language';
		await testDb.db.insert(rootFolders).values({
			id: rootFolderId,
			name: 'Movies',
			path: ROOT_PATH,
			mediaType: 'movie'
		});
		await testDb.db.insert(movies).values({
			id: movieId,
			tmdbId: 202,
			title: 'Idioma Original',
			path: 'Idioma Original (2024)',
			rootFolderId,
			originalLanguage: 'spa'
		});
		await testDb.db.insert(movieFiles).values({
			id: 'file-original-language',
			movieId,
			relativePath: 'Idioma.Original.2024.mkv',
			size: 1000
		});

		const service = SubtitleSearchService.getInstance();
		const searchSpy = vi.spyOn(service, 'search').mockResolvedValue(buildAggregatedResult([]));

		try {
			await service.searchForMovie(movieId, ['es']);

			const criteria = searchSpy.mock.calls[0][0] as SubtitleSearchCriteria;
			// ISO-639-3 input ('spa') reaches providers as the canonical tag.
			expect(criteria.originalLanguage).toBe('es');
		} finally {
			searchSpy.mockRestore();
		}
	});
});

describe('SubtitleSearchService - capability gating and priority tiers', () => {
	type MockProvider = {
		id: string;
		name: string;
		implementation: string;
		priority: number;
		capabilities: {
			hashVerifiable: boolean;
			hearingImpairedVerifiable: boolean;
			skipWrongFps: boolean;
			supportsTvShows: boolean;
			supportsMovies: boolean;
			supportsAnime: boolean;
		};
		supportedLanguages: string[];
		supportsHashSearch: boolean;
		canSearch: ReturnType<typeof vi.fn>;
		search: ReturnType<typeof vi.fn>;
		download: ReturnType<typeof vi.fn>;
		test: ReturnType<typeof vi.fn>;
	};

	function makeProvider(overrides: Partial<MockProvider> = {}): MockProvider {
		return {
			id: 'provider-1',
			name: 'Provider One',
			implementation: 'mock',
			priority: 10,
			capabilities: {
				hashVerifiable: false,
				hearingImpairedVerifiable: false,
				skipWrongFps: true,
				supportsTvShows: true,
				supportsMovies: true,
				supportsAnime: false
			},
			supportedLanguages: ['en'],
			supportsHashSearch: false,
			canSearch: vi.fn().mockReturnValue(true),
			search: vi.fn().mockResolvedValue([]),
			download: vi.fn(),
			test: vi.fn(),
			...overrides
		};
	}

	function result(overrides: Partial<SubtitleSearchResult> = {}): SubtitleSearchResult {
		return {
			providerId: 'provider-1',
			providerName: 'Provider One',
			providerSubtitleId: 'sub-1',
			language: 'en',
			title: 'Test Movie',
			isForced: false,
			isHearingImpaired: false,
			format: 'srt',
			isHashMatch: false,
			matchScore: 80,
			...overrides
		};
	}

	const enRequirement = {
		tag: 'en',
		variant: 'regular',
		accessibility: 'any'
	} as const;

	const criteria = {
		title: 'Test Movie',
		languages: ['en'] as never
	};

	const service = SubtitleSearchService.getInstance();

	beforeEach(() => {
		mockGetEnabledProviders.mockReset();
		mockRecordSuccess.mockReset().mockResolvedValue(undefined);
		mockRecordError.mockReset().mockResolvedValue(undefined);
		mockAcquireRateLimit.mockReset().mockResolvedValue(undefined);
	});

	it('skips an anime-only provider for a movie search and logs the reason', async () => {
		const animeOnly = makeProvider({
			id: 'anime-only',
			capabilities: {
				hashVerifiable: false,
				hearingImpairedVerifiable: false,
				skipWrongFps: true,
				supportsTvShows: false,
				supportsMovies: false,
				supportsAnime: true
			}
		});
		const normal = makeProvider({ id: 'normal', search: vi.fn().mockResolvedValue([result()]) });
		mockGetEnabledProviders.mockResolvedValue([animeOnly, normal]);

		const aggregated = await service.search(criteria, {}, { mediaKind: 'movie' });

		expect(animeOnly.search).not.toHaveBeenCalled();
		expect(normal.search).toHaveBeenCalledTimes(1);
		expect(aggregated.providerResults.find((p) => p.providerId === 'anime-only')?.skipped).toBe(
			'provider does not support movies'
		);
		expect(aggregated.results).toHaveLength(1);
	});

	it('skips an anime-only provider for a TV search too', async () => {
		const animeOnly = makeProvider({
			id: 'anime-only',
			capabilities: {
				hashVerifiable: false,
				hearingImpairedVerifiable: false,
				skipWrongFps: true,
				supportsTvShows: false,
				supportsMovies: false,
				supportsAnime: true
			}
		});
		mockGetEnabledProviders.mockResolvedValue([animeOnly]);

		const aggregated = await service.search(criteria, {}, { mediaKind: 'tv' });

		expect(animeOnly.search).not.toHaveBeenCalled();
		expect(aggregated.providerResults[0].skipped).toBe('provider does not support TV shows');
	});

	it('treats TV-capable providers as anime-eligible (default capabilities)', async () => {
		// Default capabilities: supportsMovies/supportsTvShows true, supportsAnime false.
		const general = makeProvider({
			id: 'general',
			search: vi.fn().mockResolvedValue([result({ providerId: 'general' })])
		});
		mockGetEnabledProviders.mockResolvedValue([general]);

		const aggregated = await service.search(criteria, {}, { mediaKind: 'anime' });

		expect(general.search).toHaveBeenCalledTimes(1);
		expect(aggregated.providerResults[0].skipped).toBeUndefined();
		expect(aggregated.results).toHaveLength(1);
	});

	it('skips a movies-only provider for an anime search', async () => {
		const moviesOnly = makeProvider({
			id: 'movies-only',
			capabilities: {
				hashVerifiable: false,
				hearingImpairedVerifiable: false,
				skipWrongFps: true,
				supportsTvShows: false,
				supportsMovies: true,
				supportsAnime: false
			}
		});
		mockGetEnabledProviders.mockResolvedValue([moviesOnly]);

		const aggregated = await service.search(criteria, {}, { mediaKind: 'anime' });

		expect(moviesOnly.search).not.toHaveBeenCalled();
		expect(aggregated.providerResults[0].skipped).toBe('provider does not support anime');
	});

	it('still applies movie/TV gating unchanged', async () => {
		const moviesOnly = makeProvider({
			id: 'movies-only',
			capabilities: {
				hashVerifiable: false,
				hearingImpairedVerifiable: false,
				skipWrongFps: true,
				supportsTvShows: false,
				supportsMovies: true,
				supportsAnime: false
			}
		});
		const tvOnly = makeProvider({
			id: 'tv-only',
			capabilities: {
				hashVerifiable: false,
				hearingImpairedVerifiable: false,
				skipWrongFps: true,
				supportsTvShows: true,
				supportsMovies: false,
				supportsAnime: false
			}
		});
		mockGetEnabledProviders.mockResolvedValue([moviesOnly, tvOnly]);

		const movieSearch = await service.search(criteria, {}, { mediaKind: 'movie' });
		expect(moviesOnly.search).toHaveBeenCalledTimes(1);
		expect(movieSearch.providerResults.find((p) => p.providerId === 'tv-only')?.skipped).toBe(
			'provider does not support movies'
		);

		moviesOnly.search.mockClear();
		tvOnly.search.mockClear();
		const tvSearch = await service.search(criteria, {}, { mediaKind: 'tv' });
		expect(tvOnly.search).toHaveBeenCalledTimes(1);
		expect(tvSearch.providerResults.find((p) => p.providerId === 'movies-only')?.skipped).toBe(
			'provider does not support TV shows'
		);
	});

	it('skips providers that cannot verify HI when a require-hi requirement is acquired', async () => {
		const unverifiable = makeProvider({ id: 'no-hi' });
		const verifiable = makeProvider({
			id: 'hi-ok',
			capabilities: {
				hashVerifiable: false,
				hearingImpairedVerifiable: true,
				skipWrongFps: true,
				supportsTvShows: true,
				supportsMovies: true,
				supportsAnime: false
			},
			search: vi.fn().mockResolvedValue([result({ isHearingImpaired: true })])
		});
		mockGetEnabledProviders.mockResolvedValue([unverifiable, verifiable]);

		const aggregated = await service.search(criteria, {}, { requireHearingImpaired: true });

		expect(unverifiable.search).not.toHaveBeenCalled();
		expect(verifiable.search).toHaveBeenCalledTimes(1);
		expect(aggregated.providerResults.find((p) => p.providerId === 'no-hi')?.skipped).toBe(
			'provider cannot verify hearing-impaired subtitles'
		);
	});

	it('stops at the first tier that accepts a candidate for the requirement', async () => {
		const tierOne = makeProvider({
			id: 'tier-1',
			priority: 10,
			search: vi.fn().mockResolvedValue([result({ providerId: 'tier-1', matchScore: 85 })])
		});
		const tierTwo = makeProvider({
			id: 'tier-2',
			priority: 20,
			search: vi.fn().mockResolvedValue([result({ providerId: 'tier-2', matchScore: 90 })])
		});
		mockGetEnabledProviders.mockResolvedValue([tierTwo, tierOne]);

		const aggregated = await service.search(
			criteria,
			{},
			{
				requirement: enRequirement,
				minimumScore: 70
			}
		);

		expect(tierOne.search).toHaveBeenCalledTimes(1);
		expect(tierTwo.search).not.toHaveBeenCalled();
		expect(aggregated.tierTimings).toHaveLength(1);
		expect(aggregated.tierTimings?.[0]).toMatchObject({
			priority: 10,
			accepted: true,
			stopped: true
		});
	});

	it('falls through to the next tier when the first yields no acceptable candidate', async () => {
		const tierOne = makeProvider({
			id: 'tier-1',
			priority: 10,
			search: vi.fn().mockResolvedValue([])
		});
		const tierTwo = makeProvider({
			id: 'tier-2',
			priority: 20,
			search: vi.fn().mockResolvedValue([result({ providerId: 'tier-2', matchScore: 88 })])
		});
		mockGetEnabledProviders.mockResolvedValue([tierOne, tierTwo]);

		const aggregated = await service.search(
			criteria,
			{},
			{
				requirement: enRequirement,
				minimumScore: 70
			}
		);

		expect(tierOne.search).toHaveBeenCalledTimes(1);
		expect(tierTwo.search).toHaveBeenCalledTimes(1);
		expect(aggregated.tierTimings).toHaveLength(2);
		expect(aggregated.tierTimings?.[0]?.accepted).toBe(false);
		expect(aggregated.tierTimings?.[1]?.accepted).toBe(true);
	});

	it('awaits the shared rate limiter before each provider search', async () => {
		const provider = makeProvider({ id: 'limited', search: vi.fn().mockResolvedValue([result()]) });
		mockGetEnabledProviders.mockResolvedValue([provider]);

		await service.search(criteria, {}, {});

		expect(mockAcquireRateLimit).toHaveBeenCalledWith('limited');
	});
});
