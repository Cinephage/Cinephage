import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	episodesFindFirst: vi.fn(),
	seriesFindFirst: vi.fn(),
	episodeFilesFindMany: vi.fn(),
	preflight: vi.fn(),
	buildCriteria: vi.fn(),
	searchReleases: vi.fn(),
	grab: vi.fn()
}));

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		query: {
			episodes: { findFirst: mocks.episodesFindFirst },
			series: { findFirst: mocks.seriesFindFirst },
			episodeFiles: { findMany: mocks.episodeFilesFindMany }
		}
	}
}));

vi.mock('#lib/server/indexers/search/profile-indexer-filter.js', () => ({
	resolveAllowedIndexerIds: vi.fn(async () => [])
}));

vi.mock('#lib/server/downloads/GrabService.js', () => ({
	grabService: { grab: mocks.grab }
}));

vi.mock('./search-request.js', () => ({
	preflightIndexerSearch: mocks.preflight,
	buildSearchCriteria: mocks.buildCriteria,
	searchReleases: mocks.searchReleases
}));

const { searchForEpisode } = await import('./search-episode.js');

const altTitles = {
	getSeriesSearchTitlesWithRefresh: vi.fn(async () => [])
};

function release(title: string) {
	return {
		title,
		guid: title,
		infoHash: 'hash-1',
		magnetUrl: 'magnet:?xt=urn:btih:hash-1',
		downloadUrl: 'https://tracker.example/dl/1',
		indexerId: 'idx-1',
		indexerName: 'Prowlarr',
		protocol: 'torrent',
		size: 1_500_000_000,
		categories: [5000],
		publishDate: new Date('2026-01-01T00:00:00Z'),
		parsed: { resolution: '1080p' },
		totalScore: 500,
		rejected: false,
		tmdbId: 1399,
		tvdbId: 121361,
		imdbId: 'tt0944947'
	};
}

describe('searchForEpisode - grab payload', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.episodesFindFirst.mockResolvedValue({
			id: 'episode-1',
			seriesId: 'series-1',
			seasonNumber: 1,
			episodeNumber: 2
		});
		mocks.seriesFindFirst.mockResolvedValue({
			id: 'series-1',
			title: 'A Series',
			monitored: true,
			scoringProfileId: null
		});
		mocks.episodeFilesFindMany.mockResolvedValue([]);
		mocks.preflight.mockResolvedValue({ ok: true, indexerManager: {} });
		mocks.buildCriteria.mockReturnValue({});
		mocks.searchReleases.mockResolvedValue({
			releases: [release('A.Series.S01E02.1080p.WEB-DL')],
			rejectedCount: 0
		});
		mocks.grab.mockResolvedValue({ success: true, download: { queueId: 'queue-1' } });
	});

	it('sends the release identity the shared mapping carries, not only download coordinates', async () => {
		const result = await searchForEpisode({ episodeId: 'episode-1' }, altTitles as never);

		expect(result.success).toBe(true);
		expect(mocks.grab).toHaveBeenCalledTimes(1);
		expect(mocks.grab).toHaveBeenCalledWith(
			expect.objectContaining({
				release: expect.objectContaining({
					title: 'A.Series.S01E02.1080p.WEB-DL',
					infoHash: 'hash-1',
					downloadUrl: 'https://tracker.example/dl/1',
					indexerId: 'idx-1',
					indexerName: 'Prowlarr',
					size: 1_500_000_000,
					protocol: 'torrent',
					tmdbId: 1399,
					tvdbId: 121361,
					imdbId: 'tt0944947'
				})
			})
		);
	});
});
