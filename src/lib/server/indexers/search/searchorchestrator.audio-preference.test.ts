import { describe, it, expect, vi } from 'vitest';
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

function buildIndexer(releases: ReleaseResult[]): IIndexer {
	const searchSpy = vi.fn(async () => releases);
	return createMockIndexer({
		id: 'idx-pref',
		name: 'PrefIndexer',
		protocol: 'torrent',
		capabilities: mockCapabilities as unknown as Record<string, unknown>,
		search: searchSpy as unknown as (...args: unknown[]) => unknown
	}) as unknown as IIndexer;
}

let releaseCounter = 0;
function createRelease(title: string): ReleaseResult {
	releaseCounter += 1;
	return {
		guid: `guid-${releaseCounter}`,
		title,
		downloadUrl: `https://example.test/download/${releaseCounter}`,
		publishDate: new Date(),
		size: 1_000_000,
		indexerId: 'idx-pref',
		indexerName: 'PrefIndexer',
		protocol: 'torrent',
		categories: [2000 as never],
		seeders: 10,
		leechers: 1,
		infoHash: `hash-${releaseCounter}`
	};
}

const ADGAMER_PREFERENCE: NonNullable<SearchCriteria['audioPreference']> = {
	// ADGamer's case: prefer Spanish audio, English fallback, original when known
	preferOriginal: true,
	languages: ['es', 'en'],
	originalLanguage: 'en',
	mode: 'prefer'
};

function mockEnrichment() {
	enrichMock.mockImplementation(async (releases: ReleaseResult[]) => ({
		releases: releases.map((r, i) => {
			const score = 100 - i * 10;
			return {
				...r,
				totalScore: score,
				scoreComponents: { qualityScore: score, totalScore: score },
				rejected: false,
				rejections: []
			};
		}),
		rejectedCount: 0,
		scoringProfile: { id: 'profile-a' },
		enrichTimeMs: 1
	}));
}

describe('SearchOrchestrator audio-preference boost', () => {
	it('rank path: preferred-order releases outrank untagged ones (seeders multiplier)', async () => {
		const orchestrator = new SearchOrchestrator();
		const releases = [
			createRelease('Some.Movie.2026.1080p.WEB-DL.x264-GROUP'),
			createRelease('Some.Movie.2026.1080p.WEB-DL.iTA-ENG.x264-GROUP')
		];
		const indexer = buildIndexer(releases);

		const result = await orchestrator.search([indexer], {
			searchType: 'movie',
			query: 'Some Movie',
			imdbId: 'tt0000001',
			audioPreference: ADGAMER_PREFERENCE
		});

		// The iTA-ENG release carries 'en', which matches the original
		// language under preferOriginal → bucket 0 (×30); the untagged
		// release keeps its original seeders.
		const byTitle = new Map(result.releases.map((r) => [r.title, r.seeders]));
		expect(byTitle.get('Some.Movie.2026.1080p.WEB-DL.iTA-ENG.x264-GROUP')).toBe(10 * 30);
		expect(byTitle.get('Some.Movie.2026.1080p.WEB-DL.x264-GROUP')).toBe(10);
	});

	it('enhanced path: graded totalScore bonus with languageBonus component', async () => {
		const orchestrator = new SearchOrchestrator();
		mockEnrichment();
		const releases = [
			createRelease('Some.Movie.2026.MULTi.1080p.WEB-DL.x264-GROUP'),
			createRelease('Some.Movie.2026.DUAL.ESP-ENG.1080p.WEB-DL.x264-GROUP')
		];
		const indexer = buildIndexer(releases);

		const result = await orchestrator.searchEnhanced([indexer], {
			searchType: 'movie',
			query: 'Some Movie',
			imdbId: 'tt0000001',
			audioPreference: ADGAMER_PREFERENCE
		});

		const dual = result.releases.find((r) => r.title.includes('DUAL'));
		const multiOnly = result.releases.find((r) => r.title.includes('MULTi'));

		// DUAL ESP-ENG: original-language match (en + originalLanguage en) → +25
		const dualComponents = dual?.scoreComponents as { languageBonus?: number };
		expect(dualComponents?.languageBonus).toBe(25);

		// MULTi alone: candidate slot after the last explicit preference → +12
		const multiComponents = multiOnly?.scoreComponents as { languageBonus?: number };
		expect(multiComponents?.languageBonus).toBe(12);

		// The stronger evidence outranks the multi-only release despite the
		// enrichment base scores favoring the first release.
		expect(result.releases.indexOf(dual!)).toBeLessThan(result.releases.indexOf(multiOnly!));
	});

	it('leaves releases untouched under a neutral preference', async () => {
		const orchestrator = new SearchOrchestrator();
		const releases = [createRelease('Some.Movie.2026.1080p.WEB-DL.x264-GROUP')];
		const indexer = buildIndexer(releases);

		const result = await orchestrator.search([indexer], {
			searchType: 'movie',
			query: 'Some Movie',
			imdbId: 'tt0000001',
			audioPreference: {
				preferOriginal: true,
				languages: [],
				originalLanguage: null,
				mode: 'prefer'
			}
		});

		expect(result.releases[0].seeders).toBe(10);
	});
});
