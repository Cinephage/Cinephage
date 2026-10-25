import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchOrchestrator } from './SearchOrchestrator';
import type { IIndexer, ReleaseResult, SearchCriteria } from '../types';
import { createMockIndexer } from '../../../../test/fixtures/indexers.js';

const { enrichMock, getBlockedIdentifiersMock, findMovieMock } = vi.hoisted(() => ({
	enrichMock: vi.fn(),
	getBlockedIdentifiersMock: vi.fn(),
	findMovieMock: vi.fn()
}));

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		query: {
			movies: { findFirst: findMovieMock },
			series: { findFirst: vi.fn(async () => undefined) }
		}
	}
}));

vi.mock('#lib/server/blocklist/BlocklistService.js', () => ({
	blocklistService: { getBlockedIdentifiers: getBlockedIdentifiersMock }
}));

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		getMovieExternalIds: vi.fn(),
		getTvExternalIds: vi.fn(),
		getTVShow: vi.fn(),
		getSeason: vi.fn()
	}
}));

vi.mock('../../quality', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		releaseEnricher: { enrich: enrichMock }
	};
});

const mockCapabilities = {
	search: { available: true, supportedParams: ['q'] },
	tvSearch: { available: true, supportedParams: ['q', 'season', 'ep'] },
	movieSearch: { available: true, supportedParams: ['q', 'year'] },
	categories: new Map([[2000, 'Movies']]),
	supportsPagination: true,
	supportsInfoHash: false,
	limitMax: 100,
	limitDefault: 50,
	searchFormats: { episode: ['standard'] }
};

function buildIndexer(
	protocol: string,
	releases: ReleaseResult[],
	name = 'FakeIndexer'
): { indexer: IIndexer; searchSpy: ReturnType<typeof vi.fn> } {
	const searchSpy = vi.fn(async () => releases);
	const indexer = createMockIndexer({
		id: `idx-${protocol}`,
		name,
		protocol,
		capabilities: mockCapabilities as unknown as Record<string, unknown>,
		search: searchSpy as unknown as (...args: unknown[]) => unknown
	}) as unknown as IIndexer;
	return { indexer, searchSpy };
}

let releaseCounter = 0;
function createRelease(overrides: Partial<ReleaseResult> = {}): ReleaseResult {
	releaseCounter += 1;
	return {
		guid: `guid-${releaseCounter}`,
		title: `Example Release ${releaseCounter}`,
		downloadUrl: `https://example.test/download/${releaseCounter}`,
		publishDate: new Date(),
		size: 1_000_000,
		indexerId: 'idx-torrent',
		indexerName: 'FakeIndexer',
		protocol: 'torrent',
		categories: [],
		seeders: 10,
		leechers: 1,
		infoHash: `hash-${releaseCounter}`,
		...overrides
	};
}

function mockEnrichment(baseScores?: number[]) {
	enrichMock.mockImplementation(async (releases: ReleaseResult[]) => ({
		releases: releases.map((r, i) => {
			const score = baseScores ? baseScores[i] : 100 - i;
			return {
				...r,
				totalScore: score,
				scoreComponents: {
					qualityScore: score,
					enhancementBonus: 0,
					packBonus: 0,
					hardcodedSubsPenalty: 0,
					totalScore: score
				},
				rejected: false,
				rejections: []
			};
		}),
		rejectedCount: 0,
		scoringProfile: { id: 'profile-a' },
		enrichTimeMs: 1
	}));
}

describe('SearchOrchestrator language boost semantics', () => {
	let orchestrator: SearchOrchestrator;

	beforeEach(() => {
		vi.clearAllMocks();
		findMovieMock.mockResolvedValue(undefined);
		getBlockedIdentifiersMock.mockResolvedValue({
			blockedHashes: new Set<string>(),
			blockedTitles: new Set<string>()
		});
		orchestrator = new SearchOrchestrator();
	});

	it('does not mutate the source release objects in the rank path', async () => {
		const sourceRelease = createRelease({
			title: 'Example Movie 2023 1080p BluRay RUS x264'
		});
		const { indexer } = buildIndexer('torrent', [sourceRelease]);
		const criteria: SearchCriteria = {
			searchType: 'basic',
			query: 'Example Movie',
			language: 'ru'
		};

		const result = await orchestrator.search([indexer], criteria, { useCache: false });

		expect(result.releases).toHaveLength(1);
		// The boost must be reflected in the returned release…
		expect(result.releases[0].seeders).toBeGreaterThan(10);
		// …but the original object handed to the indexer must be untouched.
		expect(sourceRelease.seeders).toBe(10);
	});

	it('does not compound the boost across cache hits in the rank path', async () => {
		const releases = [
			createRelease({ title: 'Example Movie 2023 1080p BluRay RUS x264' }),
			createRelease({ title: 'Example Movie 2023 1080p BluRay x264' })
		];
		const { indexer } = buildIndexer('torrent', releases);
		const criteria: SearchCriteria = {
			searchType: 'basic',
			query: 'Example Movie',
			language: 'ru'
		};

		const first = await orchestrator.search([indexer], criteria, { useCache: true });
		const second = await orchestrator.search([indexer], criteria, { useCache: true });

		expect(second.fromCache).toBe(true);
		const rusTitle = 'Example Movie 2023 1080p BluRay RUS x264';
		const firstSeeders = first.releases.find((r) => r.title === rusTitle)?.seeders;
		const secondSeeders = second.releases.find((r) => r.title === rusTitle)?.seeders;
		expect(firstSeeders).toBeDefined();
		expect(secondSeeders).toBe(firstSeeders);
	});

	it('still ranks language-matched releases above non-matched ones', async () => {
		const releases = [
			createRelease({ title: 'Example Movie 2023 1080p BluRay x264', seeders: 50 }),
			createRelease({ title: 'Example Movie 2023 1080p BluRay RUS x264', seeders: 50 })
		];
		const { indexer } = buildIndexer('torrent', releases);
		const criteria: SearchCriteria = {
			searchType: 'basic',
			query: 'Example Movie',
			language: 'ru'
		};

		const result = await orchestrator.search([indexer], criteria, { useCache: false });

		expect(result.releases[0].title).toContain('RUS');
	});

	it('matches normalized inputs in the rank path (EN-US criteria vs eng release)', async () => {
		const releases = [
			createRelease({ title: 'Example Movie 2023 1080p BluRay x264', seeders: 50 }),
			createRelease({ title: 'Example Movie 2023 1080p BluRay eng x264', seeders: 50 })
		];
		const { indexer } = buildIndexer('torrent', releases);
		const criteria: SearchCriteria = {
			searchType: 'basic',
			query: 'Example Movie',
			language: 'EN-US'
		};

		const result = await orchestrator.search([indexer], criteria, { useCache: false });

		// 'EN-US' normalizes to base 'en', which matches the 'eng' tag on the
		// release side; the region variant is NOT the bare-'en' skip rule.
		const eng = result.releases.find((r) => r.title.includes('eng'));
		expect(result.releases[0].title).toContain('eng');
		expect(eng?.seeders).toBe(50 * 30);
	});

	it('matches normalized criteria against region-less releases (EN-GB vs RUS is not a match)', async () => {
		// Sanity from the other side: 'en-GB' must not match 'rus'/'ru' releases.
		const releases = [createRelease({ title: 'Example Movie 2023 1080p BluRay RUS x264' })];
		const { indexer } = buildIndexer('torrent', releases);
		const criteria: SearchCriteria = {
			searchType: 'basic',
			query: 'Example Movie',
			language: 'EN-GB'
		};

		const result = await orchestrator.search([indexer], criteria, { useCache: false });

		expect(result.releases[0].seeders).toBe(10);
	});

	it('does not boost a multi release against a specific language preference', async () => {
		const releases = [createRelease({ title: 'Example Movie 2023 MULTi 1080p BluRay x264' })];
		const { indexer } = buildIndexer('torrent', releases);
		const criteria: SearchCriteria = {
			searchType: 'basic',
			query: 'Example Movie',
			language: 'ru'
		};

		const result = await orchestrator.search([indexer], criteria, { useCache: false });

		// 'multi' is a marker, not Russian audio — no boost.
		expect(result.releases[0].seeders).toBe(10);
	});

	it('does not inflate seeders seen by enrichment in the enhanced path', async () => {
		mockEnrichment();
		const releases = [
			createRelease({ title: 'Example Movie 2023 1080p BluRay RUS x264' }),
			createRelease({ title: 'Example Movie 2023 1080p BluRay x264' })
		];
		const { indexer } = buildIndexer('torrent', releases);
		const criteria: SearchCriteria = {
			searchType: 'basic',
			query: 'Example Movie',
			language: 'ru'
		};

		await orchestrator.searchEnhanced([indexer], criteria, {
			searchSource: 'interactive',
			enrichment: { scoringProfileId: 'profile-a' }
		});

		expect(enrichMock).toHaveBeenCalledTimes(1);
		const enrichedInput = enrichMock.mock.calls[0][0] as ReleaseResult[];
		// Protocol seeder checks (minimumSeeders, dead-torrent rejection) run during
		// enrichment and must see the real seeders, not an inflated boost.
		expect(enrichedInput.map((r) => r.seeders)).toEqual([10, 10]);
	});

	it('does not compound seeders across cache hits in the enhanced path', async () => {
		mockEnrichment();
		const releases = [
			createRelease({ title: 'Example Movie 2023 1080p BluRay RUS x264' }),
			createRelease({ title: 'Example Movie 2023 1080p BluRay x264' })
		];
		const { indexer } = buildIndexer('torrent', releases);
		const criteria: SearchCriteria = {
			searchType: 'basic',
			query: 'Example Movie',
			language: 'ru'
		};

		await orchestrator.searchEnhanced([indexer], criteria, {
			searchSource: 'interactive',
			enrichment: { scoringProfileId: 'profile-a' }
		});
		const second = await orchestrator.searchEnhanced([indexer], criteria, {
			searchSource: 'interactive',
			enrichment: { scoringProfileId: 'profile-a' }
		});

		expect(second.fromCache).toBe(true);
		expect(enrichMock).toHaveBeenCalledTimes(2);
		const firstInput = enrichMock.mock.calls[0][0] as ReleaseResult[];
		const secondInput = enrichMock.mock.calls[1][0] as ReleaseResult[];
		expect(secondInput.map((r) => r.seeders)).toEqual(firstInput.map((r) => r.seeders));
	});

	it('applies the language boost in the enhanced path after enrichment', async () => {
		// The non-matching release enriches 15 points higher pre-boost; the +20
		// language bonus must flip the order.
		mockEnrichment([115, 100]);
		const releases = [
			createRelease({ title: 'Example Movie 2023 1080p BluRay x264' }),
			createRelease({ title: 'Example Movie 2023 1080p BluRay RUS x264' })
		];
		const { indexer } = buildIndexer('torrent', releases);
		const criteria: SearchCriteria = {
			searchType: 'basic',
			query: 'Example Movie',
			language: 'ru'
		};

		const result = await orchestrator.searchEnhanced([indexer], criteria, {
			searchSource: 'interactive',
			enrichment: { scoringProfileId: 'profile-a' }
		});

		const rus = result.releases.find((r) => r.title.includes('RUS'))!;
		const plain = result.releases.find((r) => !r.title.includes('RUS'))!;
		// Boosted release now outranks the higher-scoring non-match…
		expect(result.releases[0].title).toContain('RUS');
		expect(rus.totalScore).toBe(120);
		// …via an explicit score contribution, not seeders inflation.
		expect(rus.seeders).toBe(10);
		expect(plain.totalScore).toBe(115);
		expect(plain.seeders).toBe(10);
		// Score transparency: the bonus is visible in the components.
		expect(rus.scoreComponents).toMatchObject({ languageBonus: 20 });
		expect(plain.scoreComponents).not.toHaveProperty('languageBonus');
	});

	it('does not apply the enhanced-path boost when the preferred language is en', async () => {
		mockEnrichment();
		const releases = [
			createRelease({ title: 'Example Movie 2023 1080p BluRay English x264' }),
			createRelease({ title: 'Example Movie 2023 1080p BluRay x264' })
		];
		const { indexer } = buildIndexer('torrent', releases);
		const criteria: SearchCriteria = {
			searchType: 'basic',
			query: 'Example Movie',
			language: 'en'
		};

		const result = await orchestrator.searchEnhanced([indexer], criteria, {
			searchSource: 'interactive',
			enrichment: { scoringProfileId: 'profile-a' }
		});

		// Bare-'en' preference is a no-op on both paths: scores stay as enriched.
		expect(result.releases.map((r) => r.totalScore)).toEqual([100, 99]);
		expect(result.releases.every((r) => r.seeders === 10)).toBe(true);
	});

	it('matches normalized inputs in the enhanced path (PT-BR criteria vs brazilian release)', async () => {
		mockEnrichment();
		const releases = [
			createRelease({ title: 'Example Movie 2023 1080p BluRay x264' }),
			createRelease({ title: 'Example Movie 2023 1080p BluRay BRAZILIAN x264' })
		];
		const { indexer } = buildIndexer('torrent', releases);
		const criteria: SearchCriteria = {
			searchType: 'basic',
			query: 'Example Movie',
			language: 'pt-BR'
		};

		const result = await orchestrator.searchEnhanced([indexer], criteria, {
			searchSource: 'interactive',
			enrichment: { scoringProfileId: 'profile-a' }
		});

		// 'pt-BR' reduces to base 'pt', matching the 'brazilian' → 'pt' tag.
		expect(result.releases[0].title).toContain('BRAZILIAN');
		expect(result.releases[0].totalScore).toBe(99 + 20);
	});

	it('does not compound the enhanced-path boost across cache hits', async () => {
		mockEnrichment();
		const releases = [
			createRelease({ title: 'Example Movie 2023 1080p BluRay RUS x264' }),
			createRelease({ title: 'Example Movie 2023 1080p BluRay x264' })
		];
		const { indexer } = buildIndexer('torrent', releases);
		const criteria: SearchCriteria = {
			searchType: 'basic',
			query: 'Example Movie',
			language: 'ru'
		};

		const first = await orchestrator.searchEnhanced([indexer], criteria, {
			searchSource: 'interactive',
			enrichment: { scoringProfileId: 'profile-a' }
		});
		const second = await orchestrator.searchEnhanced([indexer], criteria, {
			searchSource: 'interactive',
			enrichment: { scoringProfileId: 'profile-a' }
		});

		expect(second.fromCache).toBe(true);
		const rusFirst = first.releases.find((r) => r.title.includes('RUS'))!.totalScore;
		const rusSecond = second.releases.find((r) => r.title.includes('RUS'))!.totalScore;
		// RUS enriches at 100 (input order), +20 bonus exactly once per request.
		expect(rusFirst).toBe(120);
		expect(rusSecond).toBe(rusFirst);
	});
});
