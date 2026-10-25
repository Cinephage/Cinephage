import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchOrchestrator } from './SearchOrchestrator';
import { ReleaseCache } from './ReleaseCache';
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
		...overrides
	};
}

function mockEnrichment(profileIdByCall?: string[]) {
	let call = 0;
	enrichMock.mockImplementation(async (releases: ReleaseResult[], enrichOpts) => {
		const profileId = profileIdByCall?.[call] ?? enrichOpts.scoringProfileId ?? 'default';
		call += 1;
		return {
			releases: releases.map((r, i) => ({
				...r,
				totalScore: 100 - i,
				rejected: false,
				rejections: []
			})),
			rejectedCount: 0,
			scoringProfile: { id: profileId },
			enrichTimeMs: 1
		};
	});
}

describe('SearchOrchestrator interactive search cache semantics', () => {
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

	it('re-scores cached releases when the scoring profile changes', async () => {
		mockEnrichment(['profile-a', 'profile-b']);
		const releases = [createRelease(), createRelease()];
		const { indexer } = buildIndexer('torrent', releases);
		const criteria: SearchCriteria = { searchType: 'basic', query: 'Example Movie' };

		const first = await orchestrator.searchEnhanced([indexer], criteria, {
			searchSource: 'interactive',
			enrichment: { scoringProfileId: 'profile-a' }
		});
		const second = await orchestrator.searchEnhanced([indexer], criteria, {
			searchSource: 'interactive',
			enrichment: { scoringProfileId: 'profile-b' }
		});

		expect(enrichMock).toHaveBeenCalledTimes(2);
		expect((enrichMock.mock.calls[1][1] as { scoringProfileId?: string }).scoringProfileId).toBe(
			'profile-b'
		);
		expect(second.fromCache).toBe(true);
		expect(second.scoringProfileId).toBe('profile-b');
		expect(first.scoringProfileId).toBe('profile-a');
	});

	it('searches indexers again when the protocol filter changes', async () => {
		mockEnrichment();
		const torrentReleases = [createRelease({ indexerId: 'idx-torrent' })];
		const usenetReleases = [createRelease({ indexerId: 'idx-usenet', protocol: 'usenet' })];
		const { indexer: torrentIndexer, searchSpy } = buildIndexer(
			'torrent',
			torrentReleases,
			'TorrentIdx'
		);
		const { indexer: usenetIndexer, searchSpy: usenetSearchSpy } = buildIndexer(
			'usenet',
			usenetReleases,
			'UsenetIdx'
		);
		const criteria: SearchCriteria = { searchType: 'basic', query: 'Example Movie' };

		await orchestrator.searchEnhanced([torrentIndexer], criteria, {
			searchSource: 'interactive',
			protocolFilter: ['torrent'],
			enrichment: { scoringProfileId: 'profile-a' }
		});
		expect(searchSpy).toHaveBeenCalledTimes(1);
		expect(usenetSearchSpy).not.toHaveBeenCalled();

		await orchestrator.searchEnhanced([torrentIndexer, usenetIndexer], criteria, {
			searchSource: 'interactive',
			protocolFilter: ['torrent', 'usenet'],
			enrichment: { scoringProfileId: 'profile-a' }
		});
		expect(usenetSearchSpy).toHaveBeenCalledTimes(1);
	});

	it('re-applies limit on cache hit', async () => {
		mockEnrichment();
		const releases = [createRelease(), createRelease(), createRelease(), createRelease()];
		const { indexer } = buildIndexer('torrent', releases);
		const criteria: SearchCriteria = { searchType: 'basic', query: 'Example Movie', limit: 2 };

		const limited = await orchestrator.searchEnhanced([indexer], criteria, {
			searchSource: 'interactive',
			enrichment: { scoringProfileId: 'profile-a' }
		});
		expect(limited.releases).toHaveLength(2);

		const expanded = await orchestrator.searchEnhanced(
			[indexer],
			{ ...criteria, limit: 50 },
			{
				searchSource: 'interactive',
				enrichment: { scoringProfileId: 'profile-a' }
			}
		);
		expect(expanded.fromCache).toBe(true);
		expect(expanded.releases).toHaveLength(4);
	});

	it('re-applies blocklist on cache hit', async () => {
		mockEnrichment();
		findMovieMock.mockResolvedValue({ id: 'movie-1' });
		const blocked = createRelease({
			infoHash: 'blocked-hash',
			title: 'Blocked Movie 2023 1080p BluRay x264'
		});
		const kept = createRelease({
			infoHash: 'kept-hash',
			title: 'Blocked Movie 2023 2160p BluRay x264'
		});
		const { indexer } = buildIndexer('torrent', [blocked, kept]);
		const criteria: SearchCriteria = {
			searchType: 'movie',
			query: 'Blocked Movie',
			tmdbId: 42,
			imdbId: 'tt42'
		};

		getBlockedIdentifiersMock.mockResolvedValueOnce({
			blockedHashes: new Set<string>(),
			blockedTitles: new Set<string>()
		});
		await orchestrator.searchEnhanced([indexer], criteria, {
			searchSource: 'interactive',
			enrichment: { scoringProfileId: 'profile-a' }
		});

		getBlockedIdentifiersMock.mockResolvedValueOnce({
			blockedHashes: new Set<string>(['blocked-hash']),
			blockedTitles: new Set<string>()
		});
		const second = await orchestrator.searchEnhanced([indexer], criteria, {
			searchSource: 'interactive',
			enrichment: { scoringProfileId: 'profile-a' }
		});

		expect(second.fromCache).toBe(true);
		// Interactive searches keep blocklisted releases visible, surfaced
		// through the existing rejected-releases machinery (showRejected
		// toggle + badges) instead of silent removal.
		const annotated = second.releases.find((r) => r.infoHash === 'blocked-hash');
		expect(annotated).toBeDefined();
		expect(annotated?.rejected).toBe(true);
		expect(annotated?.rejections).toContain('Blocklisted');
		const keptRelease = second.releases.find((r) => r.infoHash === 'kept-hash');
		expect(keptRelease?.rejected ?? false).toBe(false);
	});
});

describe('ReleaseCache key includes language', () => {
	it('returns different keys for different languages', () => {
		const cache = new ReleaseCache();
		const en: SearchCriteria = { searchType: 'basic', query: 'Foo', language: 'en' };
		const de: SearchCriteria = { searchType: 'basic', query: 'Foo', language: 'de' };

		cache.set(en, [createRelease()]);

		expect(cache.get(de)).toBeNull();
		expect(cache.get(en)).not.toBeNull();
	});
});
