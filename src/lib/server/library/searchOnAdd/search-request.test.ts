import { describe, it, expect, vi, beforeEach } from 'vitest';
import { preflightIndexerSearch, buildSearchCriteria, searchReleases } from './search-request.js';
import type { IndexerManager } from '#lib/server/indexers/IndexerManager.js';

const getIndexerManagerMock = vi.hoisted(() => vi.fn());
const evaluateMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/indexers/IndexerManager.js', () => ({
	getIndexerManager: getIndexerManagerMock
}));
vi.mock('#lib/server/indexers/search/availability.js', () => ({
	evaluateIndexerSearchAvailability: evaluateMock
}));

const INDEXERS = [{ id: 'ix-1' }];

function manager() {
	return {
		getIndexers: vi.fn(async () => INDEXERS),
		getDefinitionCapabilities: vi.fn(() => ({ movieSearch: { available: true } })),
		searchEnhanced: vi.fn(async () => ({ releases: [], rejectedCount: 0 }))
	};
}

beforeEach(() => {
	getIndexerManagerMock.mockReset();
	evaluateMock.mockReset();
});

describe('preflightIndexerSearch', () => {
	it('returns the manager and configs when an indexer can answer', async () => {
		const m = manager();
		getIndexerManagerMock.mockResolvedValue(m);
		evaluateMock.mockReturnValue({ ok: true, code: 'OK' });

		const gate = await preflightIndexerSearch({
			searchType: 'movie',
			searchSource: 'automatic',
			scoringProfileId: 'profile-1',
			allowedIndexerIds: ['ix-1']
		});

		expect(gate.ok).toBe(true);
		expect(gate.ok && gate.indexerManager).toBe(m);
		expect(gate.ok && gate.indexers).toBe(INDEXERS);
		expect(evaluateMock).toHaveBeenCalledWith(
			INDEXERS,
			expect.objectContaining({
				searchType: 'movie',
				searchSource: 'automatic',
				scoringProfileId: 'profile-1',
				allowedIndexerIds: ['ix-1']
			})
		);
	});

	it('wires the capability lookup to the same manager', async () => {
		const m = manager();
		getIndexerManagerMock.mockResolvedValue(m);
		evaluateMock.mockImplementation((_configs, options) => {
			options.getDefinitionCapabilities('def-1');
			return { ok: true, code: 'OK' };
		});

		await preflightIndexerSearch({ searchType: 'tv', searchSource: 'interactive' });

		expect(m.getDefinitionCapabilities).toHaveBeenCalledWith('def-1');
	});

	it('maps a refusal to a plain error with the availability message', async () => {
		getIndexerManagerMock.mockResolvedValue(manager());
		evaluateMock.mockReturnValue({
			ok: false,
			code: 'NO_INDEXER_ENABLED',
			message: 'No enabled indexers'
		});

		const gate = await preflightIndexerSearch({ searchType: 'tv', searchSource: 'automatic' });

		expect(gate.ok).toBe(false);
		expect(gate).toMatchObject({
			ok: false,
			error: 'No enabled indexers',
			code: 'NO_INDEXER_ENABLED'
		});
	});

	it('falls back to a readable error when the gate supplies no message', async () => {
		getIndexerManagerMock.mockResolvedValue(manager());
		evaluateMock.mockReturnValue({ ok: false, code: 'NO_INDEXER_CONFIGURED' });

		const gate = await preflightIndexerSearch({ searchType: 'movie', searchSource: 'automatic' });

		expect(gate).toMatchObject({ ok: false, error: 'No indexers are available' });
	});
});

describe('buildSearchCriteria', () => {
	it('searches the primary title when no alternate titles exist', () => {
		const criteria = buildSearchCriteria({ searchType: 'movie', title: 'Alien', tmdbId: 348 });

		expect(criteria.searchTitles).toEqual(['Alien']);
		expect(criteria).toMatchObject({ searchType: 'movie', query: 'Alien', tmdbId: 348 });
		expect(criteria).not.toHaveProperty('year', expect.anything());
	});

	it('keeps alternate titles and the kind-specific ids', () => {
		const criteria = buildSearchCriteria({
			searchType: 'tv',
			title: 'Alien',
			tmdbId: 1,
			tvdbId: 2,
			imdbId: 'tt0078748',
			season: 1,
			episode: 2,
			searchTitles: ['Alien', 'Alien: Director’s Cut']
		});

		expect(criteria).toMatchObject({
			searchType: 'tv',
			tmdbId: 1,
			tvdbId: 2,
			imdbId: 'tt0078748',
			season: 1,
			episode: 2
		});
		expect(criteria.searchTitles).toHaveLength(2);
	});

	it('drops null ids instead of forwarding them', () => {
		const criteria = buildSearchCriteria({
			searchType: 'tv',
			title: 'Alien',
			tmdbId: 1,
			tvdbId: null,
			imdbId: null,
			searchTitles: []
		});

		if (criteria.searchType !== 'tv') throw new Error('expected tv criteria');
		expect(criteria.tvdbId).toBeUndefined();
		expect(criteria.imdbId).toBeUndefined();
		expect(criteria.searchTitles).toEqual(['Alien']);
	});

	it('carries the movie year', () => {
		const criteria = buildSearchCriteria({
			searchType: 'movie',
			title: 'Alien',
			tmdbId: 348,
			year: 1979
		});

		if (criteria.searchType !== 'movie') throw new Error('expected movie criteria');
		expect(criteria.year).toBe(1979);
	});
});

describe('searchReleases', () => {
	it('runs the enriched search with the standard rejection filter and threshold', async () => {
		const m = manager() as unknown as IndexerManager;
		const criteria = buildSearchCriteria({ searchType: 'movie', title: 'Alien', tmdbId: 348 });

		await searchReleases(m, criteria, { searchSource: 'automatic', scoringProfileId: 'profile-1' });

		expect(m.searchEnhanced).toHaveBeenCalledWith(criteria, {
			searchSource: 'automatic',
			enrichment: {
				scoringProfileId: 'profile-1',
				filterRejected: true,
				minScore: 0
			}
		});
	});

	it('omits an absent profile rather than forwarding null', async () => {
		const m = manager() as unknown as IndexerManager;
		const criteria = buildSearchCriteria({ searchType: 'tv', title: 'Alien', tmdbId: 1 });

		await searchReleases(m, criteria, { searchSource: 'interactive', scoringProfileId: null });

		expect(m.searchEnhanced).toHaveBeenCalledWith(
			criteria,
			expect.objectContaining({
				enrichment: expect.objectContaining({ scoringProfileId: undefined })
			})
		);
	});
});
