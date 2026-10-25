import { describe, it, expect, vi } from 'vitest';
import { SearchOrchestrator } from './SearchOrchestrator';
import {
	Category,
	isTvSearch,
	isMovieSearch,
	type IIndexer,
	type IndexerCapabilities,
	type IndexerProtocol,
	type SearchCriteria,
	type TvSearchCriteria,
	type MovieSearchCriteria,
	type MusicSearchCriteria,
	type ReleaseResult,
	type RejectedIndexer
} from '../types';
import { createMockIndexer as _createMockIndexer } from '../../../../test/fixtures/indexers.js';

const mockCapabilities: IndexerCapabilities = {
	search: { available: true, supportedParams: ['q'] },
	tvSearch: { available: true, supportedParams: ['q', 'season', 'ep'] },
	movieSearch: { available: true, supportedParams: ['q', 'year'] },
	categories: new Map(),
	supportsPagination: true,
	supportsInfoHash: false,
	limitMax: 100,
	limitDefault: 50,
	searchFormats: {
		episode: ['standard', 'european', 'compact']
	}
};

function buildIndexer(
	overrides: {
		name?: string;
		baseUrl?: string;
		capabilities?: IndexerCapabilities;
		search?: (criteria: SearchCriteria) => Promise<ReleaseResult[]>;
	} = {}
): IIndexer {
	return _createMockIndexer({
		id: 'test-indexer',
		name: overrides.name ?? 'FakeIndexer',
		capabilities: (overrides.capabilities ?? mockCapabilities) as unknown as Record<
			string,
			unknown
		>,
		baseUrl: overrides.baseUrl ?? 'https://example.test',
		search: (overrides.search ?? (async () => [])) as unknown as (...args: unknown[]) => unknown
	}) as unknown as IIndexer;
}

function createTvCriteria(overrides: Partial<TvSearchCriteria> = {}): TvSearchCriteria {
	return { searchType: 'tv', ...overrides };
}

function createMovieCriteria(overrides: Partial<MovieSearchCriteria> = {}): MovieSearchCriteria {
	return { searchType: 'movie', ...overrides };
}

function createMusicCriteria(overrides: Partial<MusicSearchCriteria> = {}): MusicSearchCriteria {
	return { searchType: 'music', ...overrides };
}

function createRelease(overrides: Partial<ReleaseResult> = {}): ReleaseResult {
	return {
		guid: 'test-guid',
		title: '',
		downloadUrl: 'https://example.test/download',
		publishDate: new Date(),
		size: 0,
		indexerId: 'test-indexer',
		indexerName: 'FakeIndexer',
		protocol: 'torrent' as IndexerProtocol,
		categories: [],
		...overrides
	};
}

type OrchestratorPrivateApi = {
	executeMultiTitleTextSearch(
		indexer: IIndexer,
		criteria: SearchCriteria
	): Promise<ReleaseResult[]>;
	executeWithTiering(
		indexer: IIndexer,
		criteria: SearchCriteria
	): Promise<{ releases: ReleaseResult[]; searchMethod: 'id' | 'text' }>;
	filterBySeasonEpisode(
		releases: ReleaseResult[],
		criteria: SearchCriteria,
		context?: { seasonEpisodeCount?: number }
	): ReleaseResult[];
	filterByCategoryMatch(
		releases: ReleaseResult[],
		searchType: 'movie' | 'tv' | 'music' | 'book',
		criteria?: SearchCriteria
	): ReleaseResult[];
	isSeasonOnlyTvSearch(criteria: SearchCriteria): boolean;
	filterByIdOrTitleMatch(releases: ReleaseResult[], criteria: SearchCriteria): ReleaseResult[];
	filterOutNonVideoArtifacts(releases: ReleaseResult[], criteria: SearchCriteria): ReleaseResult[];
	filterIndexers(
		indexers: IIndexer[],
		criteria: SearchCriteria,
		options: {
			respectEnabled: boolean;
			respectBackoff: boolean;
			useTieredSearch: boolean;
			timeout: number;
			useCache: boolean;
			searchSource?: 'interactive' | 'automatic';
			protocolFilter?: string[];
		}
	): { eligible: IIndexer[]; rejected: RejectedIndexer[] };
	searchIndexer(
		indexer: IIndexer,
		criteria: SearchCriteria,
		timeout: number,
		useTieredSearch: boolean
	): Promise<{ error?: string }>;
	statusTracker: {
		recordSuccess: (...args: unknown[]) => Promise<void>;
		recordFailure: (...args: unknown[]) => Promise<void>;
		recordQuotaExceeded: (...args: unknown[]) => Promise<void>;
		getStatusSync: (...args: unknown[]) => { priority: number };
	};
};

function privateApi(orchestrator: SearchOrchestrator): OrchestratorPrivateApi {
	return orchestrator as unknown as OrchestratorPrivateApi;
}

describe('SearchOrchestrator.executeMultiTitleTextSearch', () => {
	it('embeds episode format into query for TV searches', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			search: async (criteria) => {
				captured.push(criteria);
				return [];
			}
		});

		const criteria = createTvCriteria({ query: 'My Show', season: 1, episode: 5 });

		await privateApi(orchestrator).executeMultiTitleTextSearch(fakeIndexer, criteria);

		expect(captured.length).toBeGreaterThan(0);

		const queries = captured.map((c) => c.query ?? '');
		const formats = captured.filter(isTvSearch).map((c) => c.preferredEpisodeFormat);

		expect(queries.every((q) => q === 'My Show')).toBe(true);

		expect(formats).toContain('standard');
		expect(formats).toContain('european');
		expect(formats).toContain('compact');
	});

	it('embeds season-only format into query when no episode specified', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			search: async (criteria) => {
				captured.push(criteria);
				return [];
			}
		});

		const criteria = createTvCriteria({ query: 'My Show', season: 2 });

		await privateApi(orchestrator).executeMultiTitleTextSearch(fakeIndexer, criteria);

		expect(captured.length).toBeGreaterThan(0);

		const queries = captured.map((c) => c.query ?? '');
		const formats = captured.filter(isTvSearch).map((c) => c.preferredEpisodeFormat);

		expect(queries.every((q) => q === 'My Show')).toBe(true);
		expect(formats).toContain('standard');
	});

	it('ignores empty title variants and avoids season-0 keyword suffix variants', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			search: async (criteria) => {
				captured.push(criteria);
				return [];
			}
		});

		const criteria = createTvCriteria({
			query: 'One Piece',
			searchTitles: ['One Piece', '', '   ', 'One Piece'],
			season: 0
		});

		await privateApi(orchestrator).executeMultiTitleTextSearch(fakeIndexer, criteria);

		expect(captured).toHaveLength(1);
		expect(captured[0].query).toBe('One Piece');
		const tv0 = captured.filter(isTvSearch)[0];
		expect(tv0?.preferredEpisodeFormat).toBeUndefined();
	});

	it('uses title for movie searches without episode format', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			search: async (criteria) => {
				captured.push(criteria);
				return [];
			}
		});

		const criteria = createMovieCriteria({ query: 'The Matrix', year: 1999 });

		await privateApi(orchestrator).executeMultiTitleTextSearch(fakeIndexer, criteria);

		expect(captured.length).toBeGreaterThan(0);

		const queries = captured.map((c) => c.query ?? '');
		expect(queries.some((q) => q.includes('The Matrix'))).toBe(true);
		expect(captured.some((c) => isMovieSearch(c) && c.year === 1999)).toBe(true);
		expect(captured.some((c) => isMovieSearch(c) && c.year === undefined)).toBe(true);
	});

	it('returns movie results without waiting for slower redundant variants', async () => {
		const orchestrator = new SearchOrchestrator();
		let releaseSlowVariant!: () => void;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlowVariant = resolve;
		});

		const fakeIndexer = buildIndexer({
			search: async (criteria) => {
				if (isMovieSearch(criteria) && criteria.year !== undefined) {
					await slowGate;
					return [];
				}
				return [createRelease({ guid: 'grown-ups-noyear', title: 'Grown Ups 2 2013 1080p' })];
			}
		});

		const criteria = createMovieCriteria({ query: 'Grown Ups 2', year: 2013 });
		const searchPromise = privateApi(orchestrator).executeMultiTitleTextSearch(
			fakeIndexer,
			criteria
		);

		const outcome = await Promise.race([
			searchPromise.then((releases) => ({ state: 'resolved' as const, releases })),
			new Promise<{ state: 'pending' }>((resolve) =>
				setTimeout(() => resolve({ state: 'pending' }), 100)
			)
		]);

		expect(outcome.state).toBe('resolved');
		if (outcome.state === 'resolved') {
			expect(outcome.releases.map((release) => release.guid)).toContain('grown-ups-noyear');
		}

		releaseSlowVariant();
		await searchPromise;
	});

	it('keeps searching later titles when earlier titles only return unrelated releases', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			search: async (criteria) => {
				captured.push(criteria);
				if (criteria.query === 'The Hangover') {
					return [
						createRelease({ guid: 'hangover', title: 'The.Hangover.2009.1080p.BluRay.x264-GRP' })
					];
				}
				// A generic localized title matches unrelated content.
				return [
					createRelease({
						guid: `junk-${captured.length}`,
						title: 'Leoni.Della.Savana.2015.1080p.WEB-DL.x264-GRP'
					})
				];
			}
		});

		const criteria = createMovieCriteria({
			query: 'Una notte da leoni',
			searchTitles: ['Una notte da leoni', 'Leoni', 'The Hangover'],
			year: 2009
		});

		const releases = await privateApi(orchestrator).executeMultiTitleTextSearch(
			fakeIndexer,
			criteria
		);

		// 'The Hangover' only appears in the second batch of variants.
		expect(captured.some((c) => c.query === 'The Hangover')).toBe(true);
		expect(releases.map((release) => release.guid)).toContain('hangover');
	});

	it('stops after the first title when it returns a matching release', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			search: async (criteria) => {
				captured.push(criteria);
				return [
					createRelease({ guid: 'hangover', title: 'The.Hangover.2009.1080p.BluRay.x264-GRP' })
				];
			}
		});

		const criteria = createMovieCriteria({
			query: 'The Hangover',
			searchTitles: ['The Hangover', 'Una notte da leoni', 'Very Bad Trip'],
			year: 2009
		});

		await privateApi(orchestrator).executeMultiTitleTextSearch(fakeIndexer, criteria);

		expect(captured.some((c) => c.query === 'Very Bad Trip')).toBe(false);
	});

	it('keeps waiting for all TV episode-format variants before merging', async () => {
		const orchestrator = new SearchOrchestrator();
		let releaseSlowVariant!: () => void;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlowVariant = resolve;
		});

		const fakeIndexer = buildIndexer({
			search: async (criteria) => {
				const tv = isTvSearch(criteria) ? criteria : undefined;
				if (tv?.preferredEpisodeFormat === 'standard') {
					await slowGate;
					return [];
				}
				return [createRelease({ guid: 'show-european', title: 'My Show 1x05 720p' })];
			}
		});

		const criteria = createTvCriteria({ query: 'My Show', season: 1, episode: 5 });
		const searchPromise = privateApi(orchestrator).executeMultiTitleTextSearch(
			fakeIndexer,
			criteria
		);

		const outcome = await Promise.race([
			searchPromise.then((releases) => ({ state: 'resolved' as const, releases })),
			new Promise<{ state: 'pending' }>((resolve) =>
				setTimeout(() => resolve({ state: 'pending' }), 100)
			)
		]);

		expect(outcome.state).toBe('pending');

		releaseSlowVariant();
		await searchPromise;
	});

	it('adds title-only fallback variant for interactive TV episode searches', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			search: async (criteria) => {
				captured.push(criteria);
				return [];
			}
		});

		const criteria = createTvCriteria({
			searchSource: 'interactive',
			query: 'Stranger Things',
			season: 2,
			episode: 1
		});

		await privateApi(orchestrator).executeMultiTitleTextSearch(fakeIndexer, criteria);

		expect(captured.filter(isTvSearch).some((c) => c.preferredEpisodeFormat === 'standard')).toBe(
			true
		);
		expect(
			captured
				.filter(isTvSearch)
				.some(
					(c) =>
						c.query === 'Stranger Things' &&
						c.season === undefined &&
						c.episode === undefined &&
						c.preferredEpisodeFormat === undefined
				)
		).toBe(true);
	});

	it('uses only Cyrillic title variants for RuTracker when native titles are available', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			name: 'RuTracker.org',
			search: async (criteria) => {
				captured.push(criteria);
				return [];
			}
		});

		const criteria = createTvCriteria({
			searchSource: 'interactive',
			query: 'How Derevyanko Chekhov Played',
			searchTitles: [
				'How Derevyanko Chekhov Played',
				'How Derevyanko Played',
				'Как Деревянко Чехова играл',
				'Как Деревянко играл',
				'Kak Derevyanko Chekhova igral'
			],
			season: 1
		});

		await privateApi(orchestrator).executeMultiTitleTextSearch(fakeIndexer, criteria);

		expect(captured.length).toBeGreaterThan(0);
		expect(captured[0].query).toBe('Как Деревянко Чехова играл');
		expect(captured.some((c) => c.query === 'Как Деревянко играл')).toBe(true);
		expect(captured.some((c) => c.query === 'How Derevyanko Chekhov Played')).toBe(false);
		expect(captured.some((c) => c.query === 'Kak Derevyanko Chekhova igral')).toBe(false);
	});

	it('reuses cached RuTracker season search results across automatic episode variants', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			name: 'RuTracker.org',
			baseUrl: 'https://rutracker.org/forum',
			search: async (criteria) => {
				captured.push(criteria);
				return [];
			}
		});

		const baseCriteria = createTvCriteria({
			searchSource: 'automatic',
			query: 'Stranger Things',
			searchTitles: ['Stranger Things', '怪奇物语', 'Очень странные дела'],
			season: 1
		});

		await privateApi(orchestrator).executeMultiTitleTextSearch(fakeIndexer, {
			...baseCriteria,
			episode: 1
		});
		await privateApi(orchestrator).executeMultiTitleTextSearch(fakeIndexer, {
			...baseCriteria,
			episode: 2
		});

		expect(captured).toHaveLength(1);
		const tvCaptured = captured.filter(isTvSearch);
		expect(tvCaptured.every((c) => c.preferredEpisodeFormat === 'standard')).toBe(true);
		expect(tvCaptured.every((c) => c.episode === undefined)).toBe(true);
		expect(tvCaptured.every((c) => c.season === 1)).toBe(true);
	});

	it('dedupes concurrent RuTracker automatic season searches into a single in-flight request', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			name: 'RuTracker.org',
			baseUrl: 'https://rutracker.org/forum',
			search: async (criteria) => {
				captured.push(criteria);
				await new Promise((resolve) => setTimeout(resolve, 15));
				return [];
			}
		});

		const baseCriteria = createTvCriteria({
			searchSource: 'automatic',
			query: 'Stranger Things',
			searchTitles: ['Stranger Things', '怪奇物语', 'Очень странные дела'],
			season: 1
		});

		await Promise.all([
			privateApi(orchestrator).executeMultiTitleTextSearch(fakeIndexer, {
				...baseCriteria,
				episode: 1
			}),
			privateApi(orchestrator).executeMultiTitleTextSearch(fakeIndexer, {
				...baseCriteria,
				episode: 2
			})
		]);

		expect(captured).toHaveLength(1);
		const tvCaptured = captured.filter(isTvSearch);
		expect(tvCaptured.every((c) => c.preferredEpisodeFormat === 'standard')).toBe(true);
		expect(tvCaptured.every((c) => c.episode === undefined)).toBe(true);
	});
});

describe('SearchOrchestrator.executeWithTiering', () => {
	it('falls back to text search when ID search returns no results', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			capabilities: {
				...mockCapabilities,
				tvSearch: {
					available: true,
					supportedParams: ['q', 'imdbId', 'tvdbId', 'season', 'ep']
				},
				searchFormats: {
					episode: ['standard']
				}
			},
			search: async (criteria) => {
				captured.push(criteria);

				if (isTvSearch(criteria) && (criteria.imdbId || criteria.tvdbId)) {
					return [];
				}

				return [
					createRelease({
						guid: 'fallback-result',
						title: 'My Show S01E05 1080p WEB-DL',
						size: 1024,
						categories: [Category.TV]
					})
				];
			}
		});

		const criteria = createTvCriteria({
			query: 'My Show',
			imdbId: 'tt1234567',
			tvdbId: 123456,
			season: 1,
			episode: 5
		});

		const result = await privateApi(orchestrator).executeWithTiering(fakeIndexer, criteria);

		expect(result.searchMethod).toBe('text');
		expect(result.releases).toHaveLength(1);
		expect(captured).toHaveLength(2);
		const cap0 = captured[0] as TvSearchCriteria;
		expect(cap0.imdbId).toBe('tt1234567');
		expect(cap0.tvdbId).toBe(123456);
		const cap1 = captured[1] as TvSearchCriteria;
		expect(cap1.imdbId).toBeUndefined();
		expect(cap1.tvdbId).toBeUndefined();
		expect(captured[1].query).toBe('My Show');
		expect(cap1.preferredEpisodeFormat).toBe('standard');
	});

	it('keeps ID search when ID results are found', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			capabilities: {
				...mockCapabilities,
				tvSearch: {
					available: true,
					supportedParams: ['q', 'imdbId', 'tvdbId', 'season', 'ep']
				},
				searchFormats: {
					episode: ['standard']
				}
			},
			search: async (criteria) => {
				captured.push(criteria);
				return [
					createRelease({
						guid: 'id-result',
						title: 'My Show S01E05 1080p WEB-DL',
						size: 1024,
						categories: [Category.TV]
					})
				];
			}
		});

		const criteria = createTvCriteria({
			query: 'My Show',
			imdbId: 'tt1234567',
			tvdbId: 123456,
			season: 1,
			episode: 5
		});

		const result = await privateApi(orchestrator).executeWithTiering(fakeIndexer, criteria);

		expect(result.searchMethod).toBe('id');
		expect(result.releases).toHaveLength(1);
		expect(captured).toHaveLength(1);
		const cap0 = captured[0] as TvSearchCriteria;
		expect(cap0.imdbId).toBe('tt1234567');
		expect(cap0.tvdbId).toBe(123456);
	});

	it('falls back to text search when ID results do not match the title', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			capabilities: {
				...mockCapabilities,
				tvSearch: {
					available: true,
					supportedParams: ['q', 'imdbId', 'tvdbId', 'season', 'ep']
				},
				searchFormats: {
					episode: ['standard']
				}
			},
			search: async (criteria) => {
				captured.push(criteria);

				if (isTvSearch(criteria) && (criteria.imdbId || criteria.tvdbId)) {
					return [
						createRelease({
							guid: 'unrelated-id-result',
							title: 'Another Show S01E05 1080p WEB-DL',
							categories: [Category.TV]
						})
					];
				}

				return [
					createRelease({
						guid: 'fallback-result',
						title: 'My Show S01E05 1080p WEB-DL',
						categories: [Category.TV]
					})
				];
			}
		});

		const criteria = createTvCriteria({
			query: 'My Show',
			imdbId: 'tt1234567',
			tvdbId: 123456,
			season: 1,
			episode: 5
		});

		const result = await privateApi(orchestrator).executeWithTiering(fakeIndexer, criteria);

		expect(result.searchMethod).toBe('text');
		expect(result.releases.map((release) => release.guid)).toEqual([
			'unrelated-id-result',
			'fallback-result'
		]);
		expect(captured).toHaveLength(2);
	});

	it('retries movie ID search without q/year before falling back to text', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			capabilities: {
				...mockCapabilities,
				movieSearch: {
					available: true,
					supportedParams: ['q', 'imdbId']
				}
			},
			search: async (criteria) => {
				captured.push(criteria);

				if (isMovieSearch(criteria) && criteria.imdbId && criteria.query) {
					return [];
				}

				if (isMovieSearch(criteria) && criteria.imdbId && !criteria.query) {
					return [
						createRelease({
							guid: 'movie-id-only-result',
							title: 'Now.You.See.Me.3.2025.1080p.WEB-DL',
							size: 1024,
							categories: [Category.MOVIE]
						})
					];
				}

				return [];
			}
		});

		const criteria = createMovieCriteria({
			query: "Now You See Me: Now You Don't",
			// The ID result is named after this alternate title; without it the
			// result would not count as a match and text fallback would run.
			searchTitles: ["Now You See Me: Now You Don't", 'Now You See Me 3'],
			year: 2025,
			imdbId: 'tt4712810'
		});

		const result = await privateApi(orchestrator).executeWithTiering(fakeIndexer, criteria);

		expect(result.searchMethod).toBe('id');
		expect(result.releases).toHaveLength(1);
		expect(captured).toHaveLength(2);
		expect(captured[0].query).toBe("Now You See Me: Now You Don't");
		const cap0 = captured[0] as MovieSearchCriteria;
		expect(cap0.year).toBe(2025);
		expect(captured[1].query).toBeUndefined();
		const cap1 = captured[1] as MovieSearchCriteria;
		expect(cap1.year).toBeUndefined();
		expect(cap1.imdbId).toBe('tt4712810');
	});

	it('returns ID results directly for interactive movie search without text supplementation', async () => {
		const orchestrator = new SearchOrchestrator();
		const captured: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			capabilities: {
				...mockCapabilities,
				movieSearch: {
					available: true,
					supportedParams: ['q', 'imdbId']
				},
				searchFormats: {
					episode: ['standard'],
					movie: ['standard', 'noYear']
				}
			},
			search: async (criteria) => {
				captured.push(criteria);

				if (isMovieSearch(criteria) && criteria.imdbId) {
					return [
						createRelease({
							guid: 'id-result',
							title: 'Now.You.See.Me.3.2025.1080p.WEB-DL',
							size: 1024,
							categories: [Category.MOVIE]
						})
					];
				}

				return [
					createRelease({
						guid: 'text-result',
						title: 'Now.You.See.Me.3.2025.2160p.BluRay.x265',
						size: 2048,
						categories: [Category.MOVIE]
					})
				];
			}
		});

		const criteria = createMovieCriteria({
			searchSource: 'interactive',
			query: "Now You See Me: Now You Don't",
			year: 2025,
			imdbId: 'tt4712810',
			searchTitles: ["Now You See Me: Now You Don't", 'Now You See Me 3']
		});

		const result = await privateApi(orchestrator).executeWithTiering(fakeIndexer, criteria);

		expect(result.searchMethod).toBe('id');
		expect(result.releases).toHaveLength(1);
		expect(result.releases[0].guid).toBe('id-result');
		expect(captured).toHaveLength(1);
		const cap0 = captured[0] as MovieSearchCriteria;
		expect(cap0.imdbId).toBe('tt4712810');
	});
});

describe('SearchOrchestrator.filterBySeasonEpisode', () => {
	const orchestrator = new SearchOrchestrator();

	it('prefers exact episode matches for interactive season+episode search', () => {
		const releases = [
			createRelease({ title: 'Smallville.S01E01.1080p.WEBRip' }),
			createRelease({ title: 'Smallville.S01.COMPLETE.1080p.BluRay' }),
			createRelease({ title: 'Smallville.S01-S05.1080p.BluRay' })
		];

		const criteria = createTvCriteria({
			searchSource: 'interactive',
			season: 1,
			episode: 1
		});

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria);
		const titles = filtered.map((r) => r.title);

		expect(titles).toEqual(['Smallville.S01E01.1080p.WEBRip']);
	});

	it('falls back to single-season packs for interactive season+episode search when exact episode is missing', () => {
		const releases = [
			createRelease({ title: 'Smallville.S01.COMPLETE.1080p.BluRay' }),
			createRelease({ title: 'Smallville.S01-S05.1080p.BluRay' })
		];

		const criteria = createTvCriteria({
			searchSource: 'interactive',
			season: 1,
			episode: 1
		});

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria);
		const titles = filtered.map((r) => r.title);
		const guids = filtered.map((r) => r.guid ?? '');

		expect(filtered).toHaveLength(1);
		expect(titles[0]).toContain('Season 1 Episode 1 - ');
		expect(titles[0]).toContain('Smallville.S01.COMPLETE.1080p.BluRay');
		expect(guids[0]).toContain('episode-pointer::s01e01');
		expect(filtered[0].season).toBe(1);
		expect(filtered[0].episode).toBe(1);
	});

	it('keeps season-only interactive searches as season packs', () => {
		const releases = [
			createRelease({ title: 'Smallville.S01.COMPLETE.1080p.BluRay' }),
			createRelease({ title: 'Smallville.S01E01.1080p.WEBRip' })
		];

		const criteria = createTvCriteria({
			searchSource: 'interactive',
			season: 1
		});

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria);

		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toBe('Smallville.S01.COMPLETE.1080p.BluRay');
	});

	it('formats season-pack titles for season-only interactive searches', () => {
		const releases = [
			createRelease({ title: '/ Stranger Things / S1E1-8 8 [2016, WEB-DL 2160p]' })
		];

		const criteria = createTvCriteria({
			searchSource: 'interactive',
			season: 1
		});

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria);

		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toBe('Stranger Things: S1E1-8 of 8 [2016, WEB-DL 2160p]');
	});

	it('keeps single-season packs for automatic season+episode search', () => {
		const releases = [
			createRelease({ title: 'Smallville.S01E01.1080p.WEBRip' }),
			createRelease({ title: 'Smallville.S01.COMPLETE.1080p.BluRay' }),
			createRelease({ title: 'Smallville.S01-S05.1080p.BluRay' })
		];

		const criteria = createTvCriteria({
			searchSource: 'automatic',
			season: 1,
			episode: 1
		});

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria);
		const titles = filtered.map((r) => r.title).sort();

		expect(titles).toEqual(
			['Smallville.S01.COMPLETE.1080p.BluRay', 'Smallville.S01E01.1080p.WEBRip'].sort()
		);
	});

	it('rejects incomplete RuTracker season packs for season-only searches', () => {
		const releases = [
			createRelease({
				title: '/ Stranger Things / S1E1-8 8 [2016, WEB-DL 2160p]',
				indexerName: 'RuTracker.org'
			}),
			createRelease({
				title: '/ Stranger Things / S1E1-6 8 [2016, WEB-DL 2160p]',
				indexerName: 'RuTracker.org'
			})
		];

		const criteria = createTvCriteria({
			searchSource: 'interactive',
			season: 1
		});

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria, {
			seasonEpisodeCount: 8
		});

		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toBe('Stranger Things: S1E1-8 of 8 [2016, WEB-DL 2160p]');
	});

	it('rejects RuTracker packs that exceed target season episode count', () => {
		const releases = [
			createRelease({
				title: 'The Vampire Diaries: S1E1-171 of 171 [2009-2017, BDRip] MVO (LostFilm)',
				indexerName: 'RuTracker.org'
			})
		];

		const criteria = createTvCriteria({
			searchSource: 'interactive',
			season: 1
		});

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria, {
			seasonEpisodeCount: 22
		});

		expect(filtered).toHaveLength(0);
	});

	it('uses episode pointers for RuTracker season packs in automatic episode searches', () => {
		const releases = [
			createRelease({
				title: '/ Stranger Things / S1E1-8 8 [2016, WEB-DL 2160p]',
				indexerName: 'RuTracker.org',
				guid: 'rutracker-pack'
			})
		];

		const criteria = createTvCriteria({
			searchSource: 'automatic',
			season: 1,
			episode: 8
		});

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria);

		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toContain('Season 1 Episode 8 - ');
		expect(filtered[0].guid).toContain('episode-pointer::s01e08');
	});

	it('returns RuTracker episode pointers only in interactive episode workflow', () => {
		const releases = [
			createRelease({
				title: 'Stranger Things.S01E08.1080p.WEBRip',
				indexerName: 'RuTracker.org',
				guid: 'rutracker-exact'
			}),
			createRelease({
				title: '/ Stranger Things / S1E1-8 8 [2016, WEB-DL 2160p]',
				indexerName: 'RuTracker.org',
				guid: 'rutracker-pack'
			})
		];

		const criteria = createTvCriteria({
			searchSource: 'interactive',
			season: 1,
			episode: 8
		});

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria);

		expect(filtered).toHaveLength(1);
		expect(filtered[0].guid).toContain('episode-pointer::s01e08');
		expect(filtered[0].title).toContain('Season 1 Episode 8 - ');
	});

	it('returns RuTracker episode pointers only in automatic episode workflow', () => {
		const releases = [
			createRelease({
				title: 'Stranger Things.S01E08.1080p.WEBRip',
				indexerName: 'RuTracker.org',
				guid: 'rutracker-exact'
			}),
			createRelease({
				title: '/ Stranger Things / S1E1-8 8 [2016, WEB-DL 2160p]',
				indexerName: 'RuTracker.org',
				guid: 'rutracker-pack'
			})
		];

		const criteria = createTvCriteria({
			searchSource: 'automatic',
			season: 1,
			episode: 8
		});

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria);

		expect(filtered).toHaveLength(1);
		expect(filtered[0].guid).toContain('episode-pointer::s01e08');
		expect(filtered[0].title).toContain('Season 1 Episode 8 - ');
	});
});

describe('SearchOrchestrator.filterByIdOrTitleMatch', () => {
	const orchestrator = new SearchOrchestrator();

	// The 2026-09-17 wrong-target incident: substring containment matched
	// "Halloween" (1978) to "Detective Conan: The Bride of Halloween" (2022).
	it('removes Detective Conan: The Bride of Halloween from automatic Halloween searches', () => {
		const releases = [
			createRelease({
				title: 'Detective.Conan.The.Bride.of.Halloween.2022.1080p.BDRip.x264',
				indexerName: 'FakeIndexer'
			}),
			createRelease({ title: 'Halloween.1978.1080p.BluRay.x264', indexerName: 'FakeIndexer' })
		];

		const criteria = createMovieCriteria({
			query: 'Halloween',
			searchTitles: ['Halloween'],
			tmdbId: 1104,
			year: 1978
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toBe('Halloween.1978.1080p.BluRay.x264');
	});

	it('keeps season packs whose title year is the season air year, not the series first-air year', () => {
		const releases = [createRelease({ title: 'Mr.Robot.S03.2017.1080p.WEB-DL.DDP5.1.H.264' })];

		const criteria = createTvCriteria({
			query: 'Mr. Robot',
			searchTitles: ['Mr. Robot'],
			tmdbId: 62560,
			year: 2015,
			season: 3
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
	});

	it('still rejects season packs dated before the series first aired', () => {
		const releases = [createRelease({ title: 'Mr.Robot.S03.2012.1080p.WEB-DL.DDP5.1.H.264' })];

		const criteria = createTvCriteria({
			query: 'Mr. Robot',
			searchTitles: ['Mr. Robot'],
			tmdbId: 62560,
			year: 2015,
			season: 3
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(0);
	});

	it('rejects wrong-year movie releases even without searchTitles', () => {
		const releases = [
			createRelease({ title: 'Now.You.See.Me.2013.1080p.BluRay.x264', indexerName: 'FakeIndexer' }),
			createRelease({
				title: 'Now.You.See.Me.Now.You.Dont.2025.1080p.WEB-DL.DDP5.1.H.265',
				indexerName: 'FakeIndexer'
			})
		];

		const criteria = createMovieCriteria({
			query: "Now You See Me: Now You Don't",
			imdbId: 'tt4712810',
			tmdbId: 425274,
			year: 2025
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		const titles = filtered.map((r) => r.title);

		expect(titles).toEqual(['Now.You.See.Me.Now.You.Dont.2025.1080p.WEB-DL.DDP5.1.H.265']);
	});

	it('removes year-less movie releases from automatic searches when IDs are absent', () => {
		const releases = [
			createRelease({
				title: 'Now.You.See.Me.Now.You.Dont.1080p.WEB-DL.REPACK',
				indexerName: 'FakeIndexer'
			})
		];

		const criteria = createMovieCriteria({
			query: "Now You See Me: Now You Don't",
			imdbId: 'tt4712810',
			tmdbId: 425274,
			year: 2025
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		// A year-less title cannot prove which same-titled movie it is; automatic
		// search treats missing year evidence as uncertainty, not proof.
		expect(filtered).toHaveLength(0);
	});

	it('keeps year-less movie releases visible for interactive searches', () => {
		const releases = [
			createRelease({
				title: 'Now.You.See.Me.Now.You.Dont.1080p.WEB-DL.REPACK',
				indexerName: 'FakeIndexer'
			})
		];

		const criteria = createMovieCriteria({
			searchSource: 'interactive',
			query: "Now You See Me: Now You Don't",
			imdbId: 'tt4712810',
			tmdbId: 425274,
			year: 2025
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
	});

	it('keeps interactive movie results when title is localized and year is missing on localized trackers', () => {
		const releases = [
			createRelease({ title: 'Военная машина WEB-DL', indexerName: 'RuTracker.org' })
		];

		const criteria = createMovieCriteria({
			searchSource: 'interactive',
			query: 'War Machine',
			searchTitles: ['War Machine'],
			year: 2017
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toBe('Военная машина WEB-DL');
	});

	it('keeps interactive movie results when title is transliterated and year matches on localized trackers', () => {
		const releases = [
			createRelease({
				title: 'Osobennosti nacionalnoy ohoty [1995, Russia, comedy, DVDRip]',
				indexerName: 'RuTracker.org'
			})
		];

		const criteria = createMovieCriteria({
			searchSource: 'interactive',
			query: 'Peculiarities of the National Hunt',
			searchTitles: ['Peculiarities of the National Hunt'],
			year: 1995
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toContain('Osobennosti nacionalnoy ohoty');
	});

	it('keeps automatic filtering strict for localized title mismatch', () => {
		const releases = [
			createRelease({ title: 'Военная машина WEB-DL', indexerName: 'FakeIndexer' })
		];

		const criteria = createMovieCriteria({
			searchSource: 'automatic',
			query: 'War Machine',
			searchTitles: ['War Machine'],
			year: 2017
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(0);
	});

	it('keeps interactive movie results from native-Cyrillic trackers when the release year is within ±1', () => {
		const releases = [
			createRelease({
				title: 'Военная машина [2016, США, боевик, BDRip 1080p]',
				indexerName: 'RuTracker.org'
			})
		];

		const criteria = createMovieCriteria({
			searchSource: 'interactive',
			query: 'War Machine',
			searchTitles: ['War Machine'],
			year: 2017
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toContain('Военная машина');
	});

	it('keeps automatic movie results from native-Cyrillic trackers when the year matches', () => {
		const releases = [
			createRelease({
				title: 'Военная машина [2017, США, боевик, BDRip 1080p]',
				indexerName: 'RuTracker.org'
			})
		];

		const criteria = createMovieCriteria({
			searchSource: 'automatic',
			query: 'War Machine',
			searchTitles: ['War Machine'],
			year: 2017
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
	});

	it('keeps automatic movie results from native-Cyrillic trackers when the release year is within ±1', () => {
		const releases = [
			createRelease({
				title: 'Военная машина [2016, США, боевик, BDRip 1080p]',
				indexerName: 'RuTracker.org'
			})
		];

		const criteria = createMovieCriteria({
			searchSource: 'automatic',
			query: 'War Machine',
			searchTitles: ['War Machine'],
			year: 2017
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
	});

	it('rejects native-Cyrillic movie results when the release year is off by more than 1', () => {
		const releases = [
			createRelease({
				title: 'Военная машина [2014, США, боевик, BDRip 1080p]',
				indexerName: 'RuTracker.org'
			})
		];

		const criteria = createMovieCriteria({
			searchSource: 'automatic',
			query: 'War Machine',
			searchTitles: ['War Machine'],
			year: 2017
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(0);
	});

	it('keeps automatic TV results from native-Cyrillic trackers for whole-series lookups within ±1 year', () => {
		const releases = [
			createRelease({
				title: 'Ночной агент [2025, США, боевик, WEB-DL 1080p]',
				indexerName: 'RuTracker.org'
			})
		];

		const criteria = createTvCriteria({
			searchSource: 'automatic',
			query: 'The Night Agent',
			searchTitles: ['The Night Agent'],
			year: 2026
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
	});
});

describe('SearchOrchestrator.executeWithTiering - season-only searches make exactly one request', () => {
	it('does not fire a supplemental search even when the ID search finds no season pack', async () => {
		const orchestrator = new SearchOrchestrator();
		const searchCalls: SearchCriteria[] = [];

		const fakeIndexer = buildIndexer({
			capabilities: {
				...mockCapabilities,
				tvSearch: {
					available: true,
					supportedParams: ['q', 'imdbId', 'tvdbId', 'season']
				},
				searchFormats: { episode: ['standard'] }
			},
			search: async (criteria) => {
				searchCalls.push(criteria as SearchCriteria);
				return [
					createRelease({
						guid: 'episode-1',
						title: 'My Show S01E01 1080p WEB-DL',
						size: 1024,
						categories: [Category.TV]
					})
				];
			}
		});

		const criteria = createTvCriteria({
			query: 'My Show',
			imdbId: 'tt1234567',
			tvdbId: 123456,
			season: 1
		});

		const result = await privateApi(orchestrator).executeWithTiering(fakeIndexer, criteria);

		expect(searchCalls).toHaveLength(1);
		expect(result.releases).toHaveLength(1);
	});
});

describe('SearchOrchestrator.filterOutNonVideoArtifacts', () => {
	const orchestrator = new SearchOrchestrator();

	it('rejects soundtrack/audio collection releases for movie searches', () => {
		const releases = [
			createRelease({
				title: '(Score, Soundtrack) [CD] The Matrix Soundtrack Collection'
			}),
			createRelease({
				title: 'The.Matrix.1999.1080p.BluRay.x264'
			})
		];

		const criteria = createMovieCriteria({
			query: 'The Matrix'
		});

		const filtered = privateApi(orchestrator).filterOutNonVideoArtifacts(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toBe('The.Matrix.1999.1080p.BluRay.x264');
	});

	it('keeps video releases even when title contains ambiguous words', () => {
		const releases = [
			createRelease({
				title: 'The.Score.2001.1080p.BluRay.x264'
			})
		];

		const criteria = createMovieCriteria({
			query: 'The Score'
		});

		const filtered = privateApi(orchestrator).filterOutNonVideoArtifacts(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toBe('The.Score.2001.1080p.BluRay.x264');
	});

	it('does not apply non-video artifact filter to music searches', () => {
		const releases = [
			createRelease({
				title: 'The Matrix Soundtrack OST FLAC'
			})
		];

		const criteria = createMusicCriteria({
			query: 'The Matrix Soundtrack'
		});

		const filtered = privateApi(orchestrator).filterOutNonVideoArtifacts(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toBe('The Matrix Soundtrack OST FLAC');
	});
});

describe('SearchOrchestrator.filterByTitleRelevance', () => {
	const orchestrator = new SearchOrchestrator();

	it('keeps tracker titles that contain the expected movie title plus extra metadata', () => {
		const releases = [
			createRelease({
				title:
					'War Machine (Patrick Hughes) [2026, UK, Australia, New Zealand, USA, sci-fi, action, WEB-DLRip] Dub + Sub (Rus, Eng)',
				indexerName: 'FakeIndexer'
			}),
			createRelease({
				title: 'Completely Different Movie [2026, USA, WEB-DLRip]',
				indexerName: 'FakeIndexer'
			})
		];

		const criteria = createMovieCriteria({
			searchSource: 'interactive',
			query: 'War Machine',
			searchTitles: ['War Machine', 'Máquina de Guerra']
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toContain('War Machine');
	});

	it('matches localized unicode movie titles when expected title is localized', () => {
		const releases = [
			createRelease({
				title: 'Особенности национальной охоты [1995, комедия, DVDRip]',
				indexerName: 'RuTracker.org'
			}),
			createRelease({
				title: 'Другой фильм [1997, драма, DVDRip]',
				indexerName: 'RuTracker.org'
			})
		];

		const criteria = createMovieCriteria({
			query: 'Особенности национальной охоты',
			searchTitles: ['Особенности национальной охоты'],
			year: 1995
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toContain('Особенности национальной охоты');
	});

	it('does not fallback to pre-filtered releases for generic interactive movie localization mismatches', () => {
		const releases = [
			createRelease({ title: 'Osobennosti nacionalnoy ohoty [1995, comedy, DVDRip]' })
		];

		const criteria = createMovieCriteria({
			searchSource: 'interactive',
			query: 'Peculiarities of the National Hunt',
			searchTitles: ['Peculiarities of the National Hunt']
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(0);
	});

	it('keeps TV releases with long tracker metadata when series title matches', () => {
		const releases = [
			createRelease({
				title: 'The Night Agent / Ночной агент S03E10 [2026, WEB-DL 1080p, Dub, Sub Rus, Eng]',
				indexerName: 'RuTracker.org'
			}),
			createRelease({
				title: 'Different Show S03E10 [2026, WEB-DL 1080p]',
				indexerName: 'RuTracker.org'
			})
		];

		const criteria = createTvCriteria({
			query: 'The Night Agent',
			searchTitles: ['The Night Agent'],
			season: 3
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toContain('The Night Agent');
	});

	it('filters trailer-like non-video artifacts from movie searches', () => {
		const releases = [
			createRelease({ title: 'Avatar Fire and Ash Trailer 1 WEB-DL 1080p x264' }),
			createRelease({ title: 'Avatar Fire and Ash Teaser WEB-DL 720p x264' }),
			createRelease({ title: 'Avatar Fire and Ash 2025 1080p WEB-DL x264-GROUP' })
		];

		const criteria = createMovieCriteria({
			query: 'Avatar Fire and Ash'
		});

		const filtered = privateApi(orchestrator).filterOutNonVideoArtifacts(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toContain('2025');
	});

	it('rejects releases with .exe extension in title', () => {
		const releases = [
			createRelease({ title: 'Backrooms.2026.1080p.HD.X264.1080p.exe' }),
			createRelease({ title: 'Backrooms.2026.1080p.HD.X264.1080p' })
		];

		const criteria = createMovieCriteria({
			query: 'Backrooms'
		});

		const filtered = privateApi(orchestrator).filterOutNonVideoArtifacts(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toBe('Backrooms.2026.1080p.HD.X264.1080p');
	});

	it('rejects releases with .bat .sh .cmd .lnk .scr extensions', () => {
		const releases = [
			createRelease({ title: 'Movie.2024.1080p.BluRay.x264.bat' }),
			createRelease({ title: 'Movie.2024.1080p.BluRay.x264.sh' }),
			createRelease({ title: 'Movie.2024.1080p.BluRay.x264.cmd' }),
			createRelease({ title: 'Movie.2024.1080p.WEB-DL.H.264.lnk' }),
			createRelease({ title: 'Movie.2024.1080p.WEBRip.scr' }),
			createRelease({ title: 'Movie.2024.1080p.BluRay.x264-GROUP' })
		];

		const criteria = createMovieCriteria({
			query: 'Movie'
		});

		const filtered = privateApi(orchestrator).filterOutNonVideoArtifacts(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toBe('Movie.2024.1080p.BluRay.x264-GROUP');
	});

	it('rejects .exe releases even when title contains video signals', () => {
		const releases = [
			createRelease({
				title: 'Backrooms 2026 1080p HD X264 1080p exe'
			})
		];

		const criteria = createMovieCriteria({
			query: 'Backrooms'
		});

		const filtered = privateApi(orchestrator).filterOutNonVideoArtifacts(releases, criteria);
		expect(filtered).toHaveLength(0);
	});

	it('falls back to pre-filtered releases for interactive TV when relevance removes all', () => {
		const releases = [
			createRelease({ title: 'Совсем другой сериал S01E01 [2026, WEB-DL 1080p]' }),
			createRelease({ title: 'Не связано S01E02 [2026, WEB-DL 1080p]' })
		];

		const criteria = createTvCriteria({
			searchSource: 'interactive',
			query: 'The Night Agent',
			searchTitles: ['The Night Agent', 'Gecə Agenti']
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(2);
		expect(filtered).toEqual(releases);
	});

	it('keeps episode-targeted TV searches strict and does not fallback to unrelated results', () => {
		const releases = [
			createRelease({ title: 'Совсем другой сериал S01E01 [2026, WEB-DL 1080p]' }),
			createRelease({ title: 'Не связано S01E02 [2026, WEB-DL 1080p]' })
		];

		const criteria = createTvCriteria({
			searchSource: 'interactive',
			query: 'The Night Agent',
			searchTitles: ['The Night Agent', 'Gecə Agenti'],
			season: 1,
			episode: 2
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(0);
	});

	it('keeps automatic TV title relevance strict when no titles match', () => {
		const releases = [
			createRelease({ title: 'Completely Different Show S01E01 [2026, WEB-DL 1080p]' }),
			createRelease({ title: 'Not Related Series S01E02 [2026, WEB-DL 1080p]' })
		];

		const criteria = createTvCriteria({
			searchSource: 'automatic',
			query: 'The Night Agent',
			searchTitles: ['The Night Agent', 'Gecə Agenti']
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(0);
	});

	it('keeps generic interactive movie ID/title checks strict while preserving direct aliases', () => {
		const releases = [
			createRelease({ title: 'Сталкер / Stalker [1979, BDRip 1080p]', indexerName: 'FakeIndexer' }),
			createRelease({ title: 'Пикник на обочине [1979, WEB-DL 1080p]' })
		];

		const criteria = createMovieCriteria({
			searchSource: 'interactive',
			query: 'Stalker',
			searchTitles: ['Stalker'],
			year: 1979
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toContain('Stalker');
	});

	it('rejects wrong-year movie releases during interactive fallback', () => {
		const releases = [
			createRelease({ title: 'Avatar 3 2026 1080p WEB h264-ETHEL' }),
			createRelease({ title: 'Avatar Fire and Ash 2026 720p HDTV x264-SYNCOPY' }),
			createRelease({ title: 'Avatar Fire and Ash 2025 720p WEBRip x264-GROUP' })
		];

		const criteria = createMovieCriteria({
			searchSource: 'interactive',
			query: 'Avatar Fire and Ash',
			searchTitles: ['Avatar Fire and Ash'],
			year: 2025
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toContain('2025');
		expect(filtered[0].title).toContain('Avatar Fire and Ash');
	});

	it('keeps interactive movie title relevance strict when titles do not match', () => {
		const releases = [
			createRelease({ title: 'Avatar 3 2026 1080p WEB h264-ETHEL' }),
			createRelease({ title: 'Completely Different Movie 2025 1080p WEB-DL' })
		];

		const criteria = createMovieCriteria({
			searchSource: 'interactive',
			query: 'Avatar Fire and Ash',
			searchTitles: ['Avatar Fire and Ash'],
			year: 2025
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(0);
	});

	it('keeps explicit ID mismatches strict during localized interactive ID/title fallback', () => {
		const releases = [
			createRelease({
				title: 'Сталкер / Stalker [1979, BDRip 1080p]',
				tmdbId: 999999,
				indexerName: 'RuTracker.org'
			}),
			createRelease({
				title: 'Пикник на обочине [1979, WEB-DL 1080p]',
				indexerName: 'RuTracker.org'
			})
		];

		const criteria = createMovieCriteria({
			searchSource: 'interactive',
			query: 'Stalker',
			searchTitles: ['Stalker'],
			year: 1979,
			tmdbId: 1398
		});

		const filtered = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].title).toContain('Пикник');
	});
});

describe('SearchOrchestrator season-only category filter', () => {
	// Regression: a season-only TV search reduces the candidate pool to only season packs
	// (via filterBySeasonEpisode). If those packs are categorized outside the TV range
	// (Movies/XXX/Other — common on Jackett/Prowlarr and anime trackers), the broad
	// filterByCategoryMatch guard would reject every pack and yield zero results.
	// The category guard is therefore skipped for season-only TV searches.
	const tvCaps = { ...mockCapabilities, categories: new Map([[Category.TV_HD, 'TV/HD']]) };

	it('keeps a Movies-categorized season pack for a season-only TV search', async () => {
		const orchestrator = new SearchOrchestrator();
		const fakeIndexer = buildIndexer({
			capabilities: tvCaps,
			search: async () => [
				createRelease({
					guid: 'season-pack-filed-as-movies',
					title: 'Smallville.S01.COMPLETE.1080p.BluRay',
					// Movies/Foreign: would be rejected by filterByCategoryMatch for a TV search
					categories: [Category.MOVIES_FOREIGN]
				})
			]
		});

		const criteria = createTvCriteria({ query: 'Smallville', season: 1 });

		const result = await orchestrator.search([fakeIndexer], criteria, {
			respectEnabled: false,
			respectBackoff: false,
			useCache: false
		});

		expect(result.releases).toHaveLength(1);
		expect(result.releases[0].guid).toBe('season-pack-filed-as-movies');
	});

	it('still rejects a Movies-categorized episode for a season+episode TV search', async () => {
		// Proves the skip is scoped to season-only: episode searches still apply the guard.
		const orchestrator = new SearchOrchestrator();
		const fakeIndexer = buildIndexer({
			capabilities: tvCaps,
			search: async () => [
				createRelease({
					guid: 'episode-filed-as-movies',
					title: 'Smallville.S01E01.1080p.WEB-DL',
					categories: [Category.MOVIES_FOREIGN]
				})
			]
		});

		const criteria = createTvCriteria({ query: 'Smallville', season: 1, episode: 1 });

		const result = await orchestrator.search([fakeIndexer], criteria, {
			respectEnabled: false,
			respectBackoff: false,
			useCache: false
		});

		expect(result.releases).toHaveLength(0);
	});

	it('isSeasonOnlyTvSearch is true only when a season is targeted without an episode', () => {
		const orchestrator = new SearchOrchestrator();
		const api = privateApi(orchestrator);

		expect(api.isSeasonOnlyTvSearch(createTvCriteria({ season: 1 }))).toBe(true);
		expect(api.isSeasonOnlyTvSearch(createTvCriteria({ season: 1, episode: 1 }))).toBe(false);
		expect(api.isSeasonOnlyTvSearch(createTvCriteria({}))).toBe(false);
		expect(api.isSeasonOnlyTvSearch(createMovieCriteria({}))).toBe(false);
	});
});

describe('SearchOrchestrator.filterByCategoryMatch', () => {
	const orchestrator = new SearchOrchestrator();

	it('rejects a Music-categorized release for a movie search', () => {
		// Guards against soundtracks masquerading as movies — the original purpose of this filter.
		const releases = [
			createRelease({ title: 'Awesome Movie Soundtrack 2024', categories: [Category.AUDIO_MP3] })
		];

		const filtered = privateApi(orchestrator).filterByCategoryMatch(releases, 'movie');

		expect(filtered).toHaveLength(0);
	});

	it('keeps a Movie-categorized release for a movie search', () => {
		const releases = [
			createRelease({ title: 'Awesome Movie 2024 1080p', categories: [Category.MOVIES_HD] })
		];

		const filtered = privateApi(orchestrator).filterByCategoryMatch(releases, 'movie');

		expect(filtered).toHaveLength(1);
	});

	it('keeps a TV-categorized release for a TV search', () => {
		const releases = [
			createRelease({ title: 'Awesome Show S01E01', categories: [Category.TV_HD] })
		];

		const filtered = privateApi(orchestrator).filterByCategoryMatch(
			releases,
			'tv',
			createTvCriteria({})
		);

		expect(filtered).toHaveLength(1);
	});

	it('rejects a Movies-categorized release for a non-adult TV search', () => {
		// Confirms the guard still rejects cross-type categories when it does run
		// (i.e. the season-only skip is the only relaxation).
		const releases = [
			createRelease({ title: 'Awesome Show S01E01', categories: [Category.MOVIES_FOREIGN] })
		];

		const filtered = privateApi(orchestrator).filterByCategoryMatch(
			releases,
			'tv',
			createTvCriteria({})
		);

		expect(filtered).toHaveLength(0);
	});

	it('accepts a Movies/XXX-categorized release for an adult TV search', () => {
		const releases = [
			createRelease({ title: 'Hentai OVA S01E01', categories: [Category.MOVIES_FOREIGN] }),
			createRelease({ title: 'Hentai OVA Pack', categories: [Category.XXX_PACK] })
		];

		const filtered = privateApi(orchestrator).filterByCategoryMatch(
			releases,
			'tv',
			createTvCriteria({ isAdult: true })
		);

		expect(filtered).toHaveLength(2);
	});
});

describe('SearchOrchestrator.filterIndexers protocol filter', () => {
	const baseOptions = {
		respectEnabled: false,
		respectBackoff: false,
		useTieredSearch: false,
		timeout: 30000,
		useCache: false
	} as const;

	const movieCapabilities: IndexerCapabilities = {
		...mockCapabilities,
		categories: new Map([[Category.MOVIES_HD, 'Movies/HD']])
	};

	function buildStreamingIndexer(): IIndexer {
		return _createMockIndexer({
			id: 'streaming-indexer',
			name: 'StreamingIndexer',
			protocol: 'streaming',
			capabilities: movieCapabilities as unknown as Record<string, unknown>,
			enableAutomaticSearch: true,
			enableInteractiveSearch: true
		}) as unknown as IIndexer;
	}

	function buildTorrentIndexer(): IIndexer {
		return _createMockIndexer({
			id: 'torrent-indexer',
			name: 'TorrentIndexer',
			protocol: 'torrent',
			capabilities: movieCapabilities as unknown as Record<string, unknown>,
			enableAutomaticSearch: true,
			enableInteractiveSearch: true
		}) as unknown as IIndexer;
	}

	it('streaming indexer passes protocol filter in interactive search even when not in allowedProtocols', () => {
		const orchestrator = new SearchOrchestrator();
		const streamingIndexer = buildStreamingIndexer();
		const criteria = createMovieCriteria({ query: 'Test' });

		const result = privateApi(orchestrator).filterIndexers([streamingIndexer], criteria, {
			...baseOptions,
			searchSource: 'interactive',
			protocolFilter: ['torrent', 'usenet']
		});

		expect(result.eligible).toHaveLength(1);
		expect(result.eligible[0].protocol).toBe('streaming');
		expect(result.rejected).toHaveLength(0);
	});

	it('streaming indexer is still rejected by protocol filter in automatic search', () => {
		const orchestrator = new SearchOrchestrator();
		const streamingIndexer = buildStreamingIndexer();
		const criteria = createMovieCriteria({ query: 'Test' });

		const result = privateApi(orchestrator).filterIndexers([streamingIndexer], criteria, {
			...baseOptions,
			searchSource: 'automatic',
			protocolFilter: ['torrent', 'usenet']
		});

		expect(result.eligible).toHaveLength(0);
		expect(result.rejected).toHaveLength(1);
		expect(result.rejected[0].reason).toBe('protocol');
	});

	it('torrent indexer is still rejected when not in protocolFilter', () => {
		const orchestrator = new SearchOrchestrator();
		const torrentIndexer = buildTorrentIndexer();
		const criteria = createMovieCriteria({ query: 'Test' });

		const result = privateApi(orchestrator).filterIndexers([torrentIndexer], criteria, {
			...baseOptions,
			searchSource: 'interactive',
			protocolFilter: ['usenet']
		});

		expect(result.eligible).toHaveLength(0);
		expect(result.rejected).toHaveLength(1);
		expect(result.rejected[0].reason).toBe('protocol');
	});

	it('streaming indexer passes when streaming is in allowedProtocols', () => {
		const orchestrator = new SearchOrchestrator();
		const streamingIndexer = buildStreamingIndexer();
		const criteria = createMovieCriteria({ query: 'Test' });

		const result = privateApi(orchestrator).filterIndexers([streamingIndexer], criteria, {
			...baseOptions,
			searchSource: 'automatic',
			protocolFilter: ['streaming']
		});

		expect(result.eligible).toHaveLength(1);
		expect(result.eligible[0].protocol).toBe('streaming');
		expect(result.rejected).toHaveLength(0);
	});
});

describe('SearchOrchestrator.filterIndexers respects per-indexer category restriction', () => {
	const baseOptions = {
		respectEnabled: false,
		respectBackoff: false,
		useTieredSearch: false,
		timeout: 30000,
		useCache: false
	} as const;

	// Natively supports both Movies and TV - the restriction below is what
	// should narrow it, not a lack of underlying capability.
	const bothCapabilities: IndexerCapabilities = {
		...mockCapabilities,
		categories: new Map([
			[Category.MOVIES_HD, 'Movies/HD'],
			[Category.TV_HD, 'TV/HD']
		])
	};

	function buildRestrictedIndexer(additionalCategories: number[]): IIndexer {
		return _createMockIndexer({
			id: 'restricted-indexer',
			name: 'RestrictedIndexer',
			protocol: 'torrent',
			capabilities: bothCapabilities as unknown as Record<string, unknown>,
			additionalCategories,
			enableAutomaticSearch: true,
			enableInteractiveSearch: true
		}) as unknown as IIndexer;
	}

	it('excludes a Movies-restricted indexer from a TV search', () => {
		const orchestrator = new SearchOrchestrator();
		const indexer = buildRestrictedIndexer([Category.MOVIES_HD]);
		const criteria = createTvCriteria({ query: 'Some Show', season: 1 });

		const result = privateApi(orchestrator).filterIndexers([indexer], criteria, {
			...baseOptions,
			searchSource: 'interactive'
		});

		expect(result.eligible).toHaveLength(0);
	});

	it('keeps the same Movies-restricted indexer eligible for a movie search', () => {
		const orchestrator = new SearchOrchestrator();
		const indexer = buildRestrictedIndexer([Category.MOVIES_HD]);
		const criteria = createMovieCriteria({ query: 'Some Movie' });

		const result = privateApi(orchestrator).filterIndexers([indexer], criteria, {
			...baseOptions,
			searchSource: 'interactive'
		});

		expect(result.eligible).toHaveLength(1);
	});

	it('does not restrict anything when no category restriction is configured', () => {
		const orchestrator = new SearchOrchestrator();
		const indexer = buildRestrictedIndexer([]);
		const criteria = createTvCriteria({ query: 'Some Show', season: 1 });

		const result = privateApi(orchestrator).filterIndexers([indexer], criteria, {
			...baseOptions,
			searchSource: 'interactive'
		});

		expect(result.eligible).toHaveLength(1);
	});
});

describe('SearchOrchestrator.filterBySeasonEpisode movie titles with season markers', () => {
	const orchestrator = new SearchOrchestrator();

	it('keeps releases whose season marker comes from the searched movie title', () => {
		const criteria = createMovieCriteria({
			query: 'Open Season 3',
			year: 2010,
			tmdbId: 51170
		});
		const releases = [
			createRelease({ title: 'Open Season 3 (2010) 1080p bluray x264' }),
			createRelease({ title: 'Open.Season.3.2010.1080p.AMZN.WEB-DL.H264-GPRS' })
		];

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria);

		expect(filtered).toHaveLength(2);
	});

	it('still rejects SxxExx releases for movie searches', () => {
		const criteria = createMovieCriteria({ query: 'Open Season 3', year: 2010 });
		const releases = [createRelease({ title: 'Open Season 3 S01E03.1080p.WEBRip' })];

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria);

		expect(filtered).toHaveLength(0);
	});

	it('leaves season-marker releases to the ID/title filter when the movie title has no marker', () => {
		const criteria = createMovieCriteria({ query: 'Jaws', year: 1975 });
		const releases = [createRelease({ title: 'Jaws Season 1 Complete 1080p BluRay' })];

		// Movie-mode parsing keeps "Season 1" unflagged (ambiguous with the title),
		// so the season filter passes it through...
		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria);
		expect(filtered).toHaveLength(1);

		// ...and the metadata-aware ID/title filter rejects it instead.
		const survivors = privateApi(orchestrator).filterByIdOrTitleMatch(filtered, criteria);
		expect(survivors).toHaveLength(0);
	});
});

describe('ordering flaw verification: ID/title match vs season filter', () => {
	const orchestrator = new SearchOrchestrator();

	it('the metadata-aware filter ACCEPTS the releases the season-pack filter killed', () => {
		const criteria = createMovieCriteria({
			query: 'Open Season 3',
			year: 2010,
			tmdbId: 51170,
			imdbId: 'tt1646926'
		});
		const releases = [
			createRelease({ title: 'Open Season 3 (2010) 1080p bluray x264' }),
			createRelease({ title: 'Open.Season.3.2010.1080p.AMZN.WEB-DL.H264-GPRS' })
		];

		const survivors = privateApi(orchestrator).filterByIdOrTitleMatch(releases, criteria);

		console.log('ORDERING-TEST: survivors =', survivors.length, 'of', releases.length);
		expect(survivors).toHaveLength(2);
	});
});

describe('filterBySeasonEpisode ID-first classification (movie search)', () => {
	const orchestrator = new SearchOrchestrator();

	it('accepts a release whose TMDB ID matches even if the title parses as TV', () => {
		const criteria = createMovieCriteria({ query: 'Open Season 3', year: 2010, tmdbId: 51170 });
		const releases = [
			createRelease({
				title: 'Open Season 3 (2010) [Streaming]',
				tmdbId: 51170,
				protocol: 'streaming'
			}),
			createRelease({ title: 'Open Season 3 S01E03 1080p WEBRip', tmdbId: 51170 })
		];

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria);

		expect(filtered).toHaveLength(2);
	});

	it('rejects a definitive ID mismatch from native-Cyrillic trackers', () => {
		const criteria = createMovieCriteria({ query: 'Open Season 3', year: 2010, tmdbId: 51170 });
		const releases = [
			createRelease({
				title: 'Открытый Сезон 3 S01E03 1080p',
				tmdbId: 999999,
				indexerName: 'RuTracker.org'
			})
		];

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria);

		expect(filtered).toHaveLength(0);
	});

	it('falls back to title parsing when an aggregator ID mismatches', () => {
		const criteria = createMovieCriteria({ query: 'Open Season 3', year: 2010, tmdbId: 51170 });
		const releases = [
			createRelease({
				title: 'Open Season 3 (2010) 1080p bluray x264',
				tmdbId: 999999,
				indexerName: 'LimeTorrents'
			})
		];

		const filtered = privateApi(orchestrator).filterBySeasonEpisode(releases, criteria);

		// aggregator mismatch is not definitive: parse says "the movie" → kept
		expect(filtered).toHaveLength(1);
	});
});

describe('filterByCategoryMatch ID-first (audit follow-up)', () => {
	const orchestrator = new SearchOrchestrator();

	it('keeps a release with matching TMDB ID despite a noisy category', () => {
		const criteria = createMovieCriteria({ query: 'Open Season 3', tmdbId: 51170 });
		const releases = [
			createRelease({
				title: 'Open.Season.3.2010.1080p.BluRay.x265',
				tmdbId: 51170,
				categories: [3000]
			})
		];

		const filtered = privateApi(orchestrator).filterByCategoryMatch(releases, 'movie', criteria);

		expect(filtered).toHaveLength(1);
	});

	it('keeps a TV release with matching TMDB ID filed under a movie category', () => {
		const criteria = createTvCriteria({ query: 'One Piece', tmdbId: 37854 });
		const releases = [
			createRelease({ title: 'One.Piece.S01E01.1080p.WEB-DL', tmdbId: 37854, categories: [2000] })
		];

		const filtered = privateApi(orchestrator).filterByCategoryMatch(releases, 'tv', criteria);

		expect(filtered).toHaveLength(1);
	});
});

describe('filterOutNonVideoArtifacts — title-embedded artifact tokens (audit)', () => {
	const orchestrator = new SearchOrchestrator();

	it('keeps "Trailer Park Boys" — the token is part of the title, before quality', () => {
		const criteria = createTvCriteria({ query: 'Trailer Park Boys', season: 1, episode: 1 });
		const releases = [
			createRelease({ title: 'Trailer.Park.Boys.S01E01.1080p.WEB-DL.DD5.1.H.264' })
		];

		const filtered = privateApi(orchestrator).filterOutNonVideoArtifacts(releases, criteria);

		expect(filtered).toHaveLength(1);
	});

	it('rejects an appended trailer after the quality block', () => {
		const criteria = createMovieCriteria({ query: 'Some Movie', year: 2020 });
		const releases = [createRelease({ title: 'Some.Movie.2020.1080p.BluRay.Trailer' })];

		const filtered = privateApi(orchestrator).filterOutNonVideoArtifacts(releases, criteria);

		expect(filtered).toHaveLength(0);
	});
});

describe('SearchOrchestrator.searchIndexer — quota-exceeded detection', () => {
	it('disables the indexer via recordQuotaExceeded instead of the generic failure path', async () => {
		const orchestrator = new SearchOrchestrator();
		const api = privateApi(orchestrator);

		const recordQuotaExceeded = vi.fn().mockResolvedValue(undefined);
		const recordFailure = vi.fn().mockResolvedValue(undefined);
		api.statusTracker = {
			recordSuccess: vi.fn().mockResolvedValue(undefined),
			recordFailure,
			recordQuotaExceeded,
			getStatusSync: vi.fn().mockReturnValue({ priority: 25 })
		};

		const indexer = buildIndexer({
			search: async () => {
				throw new Error('Indexer API error 500: Daily API request limit of 10000 reached');
			}
		});

		const result = await api.searchIndexer(indexer, createTvCriteria({ query: 'x' }), 5000, false);

		expect(recordQuotaExceeded).toHaveBeenCalledWith(
			'test-indexer',
			expect.stringContaining('Daily API request limit')
		);
		expect(recordFailure).not.toHaveBeenCalled();
		expect(result.error).toContain('Daily API request limit');
	});

	it('still uses the generic failure path for ordinary errors', async () => {
		const orchestrator = new SearchOrchestrator();
		const api = privateApi(orchestrator);

		const recordQuotaExceeded = vi.fn().mockResolvedValue(undefined);
		const recordFailure = vi.fn().mockResolvedValue(undefined);
		api.statusTracker = {
			recordSuccess: vi.fn().mockResolvedValue(undefined),
			recordFailure,
			recordQuotaExceeded,
			getStatusSync: vi.fn().mockReturnValue({ priority: 25 })
		};

		const indexer = buildIndexer({
			search: async () => {
				throw new Error('Connection refused');
			}
		});

		await api.searchIndexer(indexer, createTvCriteria({ query: 'x' }), 5000, false);

		expect(recordFailure).toHaveBeenCalledWith('test-indexer', 'Connection refused');
		expect(recordQuotaExceeded).not.toHaveBeenCalled();
	});
});
