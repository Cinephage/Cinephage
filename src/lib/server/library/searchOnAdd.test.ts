import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	movieFilesFindFirst: vi.fn(),
	movieFilesFindMany: vi.fn(),
	episodesFindFirst: vi.fn(),
	episodesFindMany: vi.fn(),
	seriesFindFirst: vi.fn(),
	episodeFilesFindMany: vi.fn(),
	moviesFindFirst: vi.fn().mockResolvedValue(null),
	scoringProfilesFindFirst: vi.fn().mockResolvedValue(null),
	searchEnhanced: vi.fn(),
	grab: vi.fn(),
	getIndexerManager: vi.fn(),
	searchWithMultiSeasonPriority: vi.fn(),
	getMultiSeasonSearchStrategy: vi.fn(),
	getMovieSearchTitles: vi.fn(),
	getSeriesSearchTitles: vi.fn(),
	fetchAndStoreMovieAlternateTitles: vi.fn(),
	fetchAndStoreSeriesAlternateTitles: vi.fn()
}));

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		query: {
			movieFiles: { findFirst: mocks.movieFilesFindFirst, findMany: mocks.movieFilesFindMany },
			episodes: { findFirst: mocks.episodesFindFirst, findMany: mocks.episodesFindMany },
			series: { findFirst: mocks.seriesFindFirst },
			episodeFiles: { findMany: mocks.episodeFilesFindMany },
			movies: { findFirst: mocks.moviesFindFirst },
			scoringProfiles: { findFirst: mocks.scoringProfilesFindFirst }
		}
	}
}));

vi.mock('#lib/server/indexers/IndexerManager.js', () => ({
	getIndexerManager: mocks.getIndexerManager
}));

vi.mock('#lib/server/downloads/index.js', () => ({
	getCascadingSearchStrategy: vi.fn()
}));

vi.mock('#lib/server/downloads/GrabService.js', () => ({
	grabService: {
		grab: mocks.grab
	}
}));

vi.mock('#lib/server/downloads/MultiSeasonSearchStrategy.js', () => ({
	getMultiSeasonSearchStrategy: mocks.getMultiSeasonSearchStrategy
}));

vi.mock('#lib/server/services/AlternateTitleService.js', () => ({
	getMovieSearchTitles: mocks.getMovieSearchTitles,
	getSeriesSearchTitles: mocks.getSeriesSearchTitles,
	fetchAndStoreMovieAlternateTitles: mocks.fetchAndStoreMovieAlternateTitles,
	fetchAndStoreSeriesAlternateTitles: mocks.fetchAndStoreSeriesAlternateTitles
}));

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

import { searchOnAdd } from './searchOnAdd';
import { createEpisode, createSeries } from '../../../test/fixtures/media.js';
import { createSearchRelease, createGrabResponse } from '../../../test/fixtures/releases.js';

function resetAlternateTitleRefreshCache(): void {
	searchOnAdd.resetAlternateTitleRefreshAttemptCacheForTests();
}

const TEST_INDEXER_CONFIG = {
	id: 'indexer-1',
	name: 'Cinephage Library',
	definitionId: 'cinephage-stream',
	enabled: true,
	baseUrl: 'https://example.test',
	alternateUrls: [],
	priority: 1,
	protocol: 'streaming',
	enableAutomaticSearch: true,
	enableInteractiveSearch: true
};

const TEST_INDEXER_CAPABILITIES = {
	search: { available: true, supportedParams: [] },
	movieSearch: { available: true, supportedParams: [] },
	tvSearch: { available: true, supportedParams: [] },
	categories: new Map([
		[2000, 'Movies'],
		[5000, 'TV']
	]),
	supportsPagination: false,
	supportsInfoHash: true,
	limitMax: 100,
	limitDefault: 100
};

function createIndexerManagerMock() {
	const configs = [TEST_INDEXER_CONFIG];
	return createIndexerManagerMockWith(configs);
}

function createIndexerManagerMockWith(configs: Array<Record<string, any>>) {
	const capabilitiesByDefinition = new Map<string, typeof TEST_INDEXER_CAPABILITIES>();
	for (const config of configs) {
		capabilitiesByDefinition.set(config.definitionId, TEST_INDEXER_CAPABILITIES);
	}

	return {
		searchEnhanced: mocks.searchEnhanced,
		getIndexers: vi.fn().mockResolvedValue(configs),
		getDefinitionCapabilities: vi.fn((definitionId: string) =>
			capabilitiesByDefinition.get(definitionId)
		)
	};
}

describe('SearchOnAddService.searchForEpisode monitoring behavior', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetAlternateTitleRefreshCache();
		mocks.getIndexerManager.mockResolvedValue(createIndexerManagerMock());
		mocks.getMovieSearchTitles.mockResolvedValue([]);
		mocks.getSeriesSearchTitles.mockResolvedValue([]);
		mocks.fetchAndStoreMovieAlternateTitles.mockResolvedValue(0);
		mocks.fetchAndStoreSeriesAlternateTitles.mockResolvedValue(0);
		mocks.getMultiSeasonSearchStrategy.mockReturnValue({
			searchWithMultiSeasonPriority: mocks.searchWithMultiSeasonPriority
		});
		mocks.searchWithMultiSeasonPriority.mockResolvedValue({
			results: [],
			summary: {
				searched: 0,
				found: 0,
				grabbed: 0,
				completeSeriesPacksGrabbed: 0,
				multiSeasonPacksGrabbed: 0,
				singleSeasonPacksGrabbed: 0,
				individualEpisodesGrabbed: 0
			},
			seasonPacks: [],
			multiSeasonPacks: []
		});
	});

	it('skips when series is unmonitored by default', async () => {
		mocks.episodesFindFirst.mockResolvedValue(
			createEpisode({
				id: 'ep-1',
				seriesId: 'series-1',
				seasonNumber: 2,
				episodeNumber: 1
			})
		);
		mocks.seriesFindFirst.mockResolvedValue(
			createSeries({
				id: 'series-1',
				title: 'The Pitt',
				tmdbId: 250307,
				tvdbId: 448176,
				imdbId: 'tt3193862',
				monitored: false,
				scoringProfileId: null
			})
		);

		const result = await searchOnAdd.searchForEpisode({ episodeId: 'ep-1' });

		expect(result).toEqual({ success: true });
		expect(mocks.searchEnhanced).not.toHaveBeenCalled();
		expect(mocks.grab).not.toHaveBeenCalled();
	});

	it('searches and grabs when bypassMonitoring is true', async () => {
		mocks.episodesFindFirst.mockResolvedValue(
			createEpisode({
				id: 'ep-1',
				seriesId: 'series-1',
				seasonNumber: 2,
				episodeNumber: 1
			})
		);
		mocks.seriesFindFirst.mockResolvedValue(
			createSeries({
				id: 'series-1',
				title: 'The Pitt',
				tmdbId: 250307,
				tvdbId: 448176,
				imdbId: 'tt3193862',
				monitored: false,
				scoringProfileId: null
			})
		);
		mocks.episodeFilesFindMany.mockResolvedValue([]);
		mocks.searchEnhanced.mockResolvedValue({
			releases: [
				createSearchRelease({
					title: 'The.Pitt.S02E01.1080p.WEB.H264-GROUP',
					infoHash: 'abc123',
					downloadUrl: 'https://example.test/download/1'
				})
			],
			rejectedCount: 0
		});
		mocks.grab.mockResolvedValue(createGrabResponse());

		const result = await searchOnAdd.searchForEpisode({
			episodeId: 'ep-1',
			bypassMonitoring: true
		});

		expect(mocks.searchEnhanced).toHaveBeenCalledOnce();
		expect(mocks.searchEnhanced).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ searchSource: 'automatic' })
		);
		expect(mocks.grab).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			success: true,
			releaseName: 'The.Pitt.S02E01.1080p.WEB.H264-GROUP'
		});
	});

	it('uses automatic search source for monitored-series episode auto-search', async () => {
		mocks.getSeriesSearchTitles.mockResolvedValue(['The Pitt', 'Питт']);
		mocks.episodesFindFirst.mockResolvedValue(
			createEpisode({
				id: 'ep-1',
				seriesId: 'series-1',
				seasonNumber: 2,
				episodeNumber: 1
			})
		);
		mocks.seriesFindFirst.mockResolvedValue(
			createSeries({
				id: 'series-1',
				title: 'The Pitt',
				tmdbId: 250307,
				tvdbId: 448176,
				imdbId: 'tt3193862',
				monitored: true,
				scoringProfileId: null
			})
		);
		mocks.episodeFilesFindMany.mockResolvedValue([]);
		mocks.searchEnhanced.mockResolvedValue({
			releases: [
				createSearchRelease({
					title: 'The.Pitt.S02E01.1080p.WEB.H264-GROUP',
					infoHash: 'abc123',
					downloadUrl: 'https://example.test/download/1'
				})
			],
			rejectedCount: 0
		});
		mocks.grab.mockResolvedValue(createGrabResponse());

		const result = await searchOnAdd.searchForEpisode({ episodeId: 'ep-1' });

		expect(mocks.searchEnhanced).toHaveBeenCalledWith(
			expect.objectContaining({
				searchTitles: ['The Pitt', 'Питт']
			}),
			expect.objectContaining({ searchSource: 'automatic' })
		);
		expect(mocks.grab).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			success: true,
			releaseName: 'The.Pitt.S02E01.1080p.WEB.H264-GROUP'
		});
	});

	it('refreshes series alternate titles only once during cooldown across repeated episode searches', async () => {
		mocks.getSeriesSearchTitles.mockResolvedValue(['The Pitt']);
		mocks.fetchAndStoreSeriesAlternateTitles.mockResolvedValue(0);
		mocks.episodesFindFirst
			.mockResolvedValueOnce(
				createEpisode({
					id: 'ep-1',
					seriesId: 'series-1',
					seasonNumber: 2,
					episodeNumber: 1
				})
			)
			.mockResolvedValueOnce(
				createEpisode({
					id: 'ep-2',
					seriesId: 'series-1',
					seasonNumber: 2,
					episodeNumber: 2
				})
			);
		mocks.seriesFindFirst.mockResolvedValue(
			createSeries({
				id: 'series-1',
				title: 'The Pitt',
				tmdbId: 250307,
				tvdbId: 448176,
				imdbId: 'tt3193862',
				monitored: true,
				scoringProfileId: null
			})
		);
		mocks.episodeFilesFindMany.mockResolvedValue([]);
		mocks.searchEnhanced.mockResolvedValue({
			releases: [
				createSearchRelease({
					title: 'The.Pitt.S02E01.1080p.WEB.H264-GROUP',
					infoHash: 'abc123',
					downloadUrl: 'https://example.test/download/1'
				})
			],
			rejectedCount: 0
		});
		mocks.grab.mockResolvedValue(createGrabResponse());

		await searchOnAdd.searchForEpisode({ episodeId: 'ep-1' });
		await searchOnAdd.searchForEpisode({ episodeId: 'ep-2' });

		expect(mocks.fetchAndStoreSeriesAlternateTitles).toHaveBeenCalledTimes(1);
		expect(mocks.fetchAndStoreSeriesAlternateTitles).toHaveBeenCalledWith('series-1', 250307);
	});
});

describe('SearchOnAddService.searchForMovie monitoring behavior', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetAlternateTitleRefreshCache();
		mocks.getIndexerManager.mockResolvedValue(createIndexerManagerMock());
		mocks.getMovieSearchTitles.mockResolvedValue([]);
		mocks.getSeriesSearchTitles.mockResolvedValue([]);
		mocks.fetchAndStoreMovieAlternateTitles.mockResolvedValue(0);
		mocks.fetchAndStoreSeriesAlternateTitles.mockResolvedValue(0);
		mocks.movieFilesFindFirst.mockResolvedValue(undefined);
		mocks.movieFilesFindMany.mockResolvedValue([]);
		mocks.grab.mockResolvedValue(createGrabResponse());
	});

	it('uses interactive search source when bypassMonitoring is true', async () => {
		mocks.searchEnhanced.mockResolvedValue({
			releases: [
				createSearchRelease({
					title: 'The.Interview.2014.1080p.WEB.H264-GROUP',
					infoHash: 'abc123',
					downloadUrl: 'stream://movie/228967'
				})
			],
			rejectedCount: 0
		});

		const result = await searchOnAdd.searchForMovie({
			movieId: 'movie-1',
			tmdbId: 228967,
			imdbId: 'tt2788710',
			title: 'The Interview',
			year: 2014,
			scoringProfileId: 'streamer',
			bypassMonitoring: true
		});

		expect(mocks.searchEnhanced).toHaveBeenCalledOnce();
		expect(mocks.searchEnhanced).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ searchSource: 'automatic' })
		);
		expect(mocks.grab).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			success: true,
			releaseName: 'The.Interview.2014.1080p.WEB.H264-GROUP'
		});
	});

	it('uses automatic search source by default', async () => {
		mocks.getMovieSearchTitles.mockResolvedValue(['The Interview', 'Интервью']);
		mocks.searchEnhanced.mockResolvedValue({
			releases: [
				createSearchRelease({
					title: 'The.Interview.2014.1080p.WEB.H264-GROUP',
					infoHash: 'abc123',
					downloadUrl: 'stream://movie/228967'
				})
			],
			rejectedCount: 0
		});

		const result = await searchOnAdd.searchForMovie({
			movieId: 'movie-1',
			tmdbId: 228967,
			imdbId: 'tt2788710',
			title: 'The Interview',
			year: 2014,
			scoringProfileId: 'streamer'
		});

		expect(mocks.searchEnhanced).toHaveBeenCalledOnce();
		expect(mocks.searchEnhanced).toHaveBeenCalledWith(
			expect.objectContaining({
				searchTitles: ['The Interview', 'Интервью']
			}),
			expect.objectContaining({ searchSource: 'automatic' })
		);
		expect(mocks.grab).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			success: true,
			releaseName: 'The.Interview.2014.1080p.WEB.H264-GROUP'
		});
	});

	it('refreshes movie alternate titles once when only one title variant exists', async () => {
		mocks.getMovieSearchTitles
			.mockResolvedValueOnce(['The Interview'])
			.mockResolvedValueOnce(['The Interview', 'Интервью']);
		mocks.fetchAndStoreMovieAlternateTitles.mockResolvedValue(1);
		mocks.searchEnhanced.mockResolvedValue({
			releases: [
				createSearchRelease({
					title: 'The.Interview.2014.1080p.WEB.H264-GROUP',
					infoHash: 'abc123',
					downloadUrl: 'stream://movie/228967'
				})
			],
			rejectedCount: 0
		});

		await searchOnAdd.searchForMovie({
			movieId: 'movie-1',
			tmdbId: 228967,
			imdbId: 'tt2788710',
			title: 'The Interview',
			year: 2014,
			scoringProfileId: 'streamer'
		});

		expect(mocks.fetchAndStoreMovieAlternateTitles).toHaveBeenCalledWith('movie-1', 228967);
		expect(mocks.searchEnhanced).toHaveBeenCalledWith(
			expect.objectContaining({
				searchTitles: ['The Interview', 'Интервью']
			}),
			expect.objectContaining({ searchSource: 'automatic' })
		);
	});
});

describe('SearchOnAddService.searchForSeries pack targets', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetAlternateTitleRefreshCache();
		mocks.getIndexerManager.mockResolvedValue(createIndexerManagerMock());
		mocks.getSeriesSearchTitles.mockResolvedValue(['The Wire']);
		mocks.fetchAndStoreSeriesAlternateTitles.mockResolvedValue(0);
		mocks.searchEnhanced.mockResolvedValue({
			releases: [
				createSearchRelease({
					title: 'The.Wire.2002.Complete.Series.S01-S05.720p.WEB.x264-GROUP',
					infoHash: 'abc123',
					downloadUrl: 'https://example.test/download/series'
				})
			],
			rejectedCount: 0
		});
		mocks.grab.mockResolvedValue(createGrabResponse());
	});

	it('passes missing series episode IDs to a complete-series pack grab', async () => {
		mocks.episodesFindMany.mockResolvedValue([
			createEpisode({
				id: 'wire-s01e01',
				seriesId: 'series-wire',
				seasonNumber: 1,
				episodeNumber: 1,
				hasFile: false,
				monitored: true
			}),
			createEpisode({
				id: 'wire-s05e10',
				seriesId: 'series-wire',
				seasonNumber: 5,
				episodeNumber: 10,
				hasFile: false,
				monitored: true
			})
		]);

		const result = await searchOnAdd.searchForSeries({
			seriesId: 'series-wire',
			tmdbId: 1438,
			tvdbId: 79126,
			imdbId: 'tt0306414',
			title: 'The Wire',
			year: 2002,
			monitorType: 'all'
		});

		expect(mocks.grab).toHaveBeenCalledWith(
			expect.objectContaining({
				target: {
					type: 'series',
					seriesId: 'series-wire',
					episodeIds: ['wire-s01e01', 'wire-s05e10']
				}
			})
		);
		expect(result.success).toBe(true);
	});
});

describe('SearchOnAddService.searchForMovie multi-quality buckets', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetAlternateTitleRefreshCache();
		mocks.getIndexerManager.mockResolvedValue(createIndexerManagerMock());
		mocks.getMovieSearchTitles.mockResolvedValue([]);
		mocks.getSeriesSearchTitles.mockResolvedValue([]);
		mocks.fetchAndStoreMovieAlternateTitles.mockResolvedValue(0);
		mocks.fetchAndStoreSeriesAlternateTitles.mockResolvedValue(0);
		mocks.movieFilesFindFirst.mockResolvedValue(undefined);
		mocks.movieFilesFindMany.mockResolvedValue([]);
		mocks.moviesFindFirst.mockResolvedValue(null);
		mocks.scoringProfilesFindFirst.mockResolvedValue(null);
		mocks.grab.mockResolvedValue(createGrabResponse());
	});

	it('grabs only desired resolution buckets for a new multi-quality movie', async () => {
		mocks.moviesFindFirst.mockResolvedValue({
			desiredQualities: ['2160p', '1080p'],
			scoringProfileId: null
		});
		mocks.scoringProfilesFindFirst.mockResolvedValue(null);
		mocks.movieFilesFindFirst.mockResolvedValue(null);
		mocks.movieFilesFindMany.mockResolvedValue([]);
		mocks.searchEnhanced.mockResolvedValue({
			releases: [
				createSearchRelease({
					title: 'Movie.2024.720p.WEB-GROUP',
					infoHash: 'hash-720p',
					downloadUrl: 'stream://movie/1-720p',
					parsed: { resolution: '720p', source: 'webdl', codec: 'h264', hdr: null }
				}),
				createSearchRelease({
					title: 'Movie.2024.2160p.UHD.WEB-GROUP',
					infoHash: 'hash-2160p',
					downloadUrl: 'stream://movie/1-2160p',
					parsed: { resolution: '2160p', source: 'webdl', codec: 'h265', hdr: null }
				}),
				createSearchRelease({
					title: 'Movie.2024.1080p.WEB-GROUP',
					infoHash: 'hash-1080p',
					downloadUrl: 'stream://movie/1-1080p',
					parsed: { resolution: '1080p', source: 'webdl', codec: 'h264', hdr: null }
				})
			],
			rejectedCount: 0
		});
		mocks.grab.mockResolvedValue(createGrabResponse());

		const result = await searchOnAdd.searchForMovie({
			movieId: 'movie-1',
			tmdbId: 228967,
			title: 'Test Movie',
			year: 2024
		});

		expect(result).toMatchObject({ success: true });
		expect(mocks.grab).toHaveBeenCalledTimes(2);
		const grabbedTitles = mocks.grab.mock.calls.map((c) => c[0].release.title);
		expect(grabbedTitles).toContain('Movie.2024.2160p.UHD.WEB-GROUP');
		expect(grabbedTitles).toContain('Movie.2024.1080p.WEB-GROUP');
		expect(grabbedTitles).not.toContain('Movie.2024.720p.WEB-GROUP');
	});

	it('fills empty quality bucket for partially-filled multi-quality movie', async () => {
		mocks.moviesFindFirst.mockResolvedValue({
			desiredQualities: ['2160p', '1080p'],
			scoringProfileId: null
		});
		mocks.scoringProfilesFindFirst.mockResolvedValue(null);
		const existing2160pFile = {
			id: 'file-1',
			movieId: 'movie-1',
			relativePath: 'Movie.2024.2160p.mkv',
			quality: { resolution: '2160p' }
		};
		mocks.movieFilesFindFirst.mockResolvedValue(existing2160pFile);
		mocks.movieFilesFindMany.mockResolvedValue([existing2160pFile]);
		mocks.searchEnhanced.mockResolvedValue({
			releases: [
				createSearchRelease({
					title: 'Movie.2024.1080p.WEB-GROUP',
					infoHash: 'hash-1080p',
					downloadUrl: 'stream://movie/1-1080p',
					parsed: { resolution: '1080p', source: 'webdl', codec: 'h264', hdr: null }
				}),
				createSearchRelease({
					title: 'Movie.2024.720p.WEB-GROUP',
					infoHash: 'hash-720p',
					downloadUrl: 'stream://movie/1-720p',
					parsed: { resolution: '720p', source: 'webdl', codec: 'h264', hdr: null }
				})
			],
			rejectedCount: 0
		});
		mocks.grab.mockResolvedValue(createGrabResponse());

		const result = await searchOnAdd.searchForMovie({
			movieId: 'movie-1',
			tmdbId: 228967,
			title: 'Test Movie',
			year: 2024
		});

		expect(result).toMatchObject({ success: true });
		expect(mocks.grab).toHaveBeenCalledTimes(1);
		expect(mocks.grab).toHaveBeenCalledWith(
			expect.objectContaining({
				options: expect.objectContaining({ isUpgrade: false })
			})
		);
		const grabbedTitles = mocks.grab.mock.calls.map((c) => c[0].release.title);
		expect(grabbedTitles).toContain('Movie.2024.1080p.WEB-GROUP');
		expect(grabbedTitles).not.toContain('Movie.2024.720p.WEB-GROUP');
	});

	it('fills all desired buckets even when an existing file has an undesired resolution', async () => {
		mocks.moviesFindFirst.mockResolvedValue({
			desiredQualities: ['2160p', '1080p'],
			scoringProfileId: null
		});
		mocks.scoringProfilesFindFirst.mockResolvedValue(null);
		const existingUndesiredFile = {
			id: 'file-stale',
			movieId: 'movie-1',
			relativePath: 'Movie.2024.720p.mkv',
			quality: { resolution: '720p' }
		};
		mocks.movieFilesFindFirst.mockResolvedValue(existingUndesiredFile);
		mocks.movieFilesFindMany.mockResolvedValue([existingUndesiredFile]);
		mocks.searchEnhanced.mockResolvedValue({
			releases: [
				createSearchRelease({
					title: 'Movie.2024.2160p.UHD.WEB-GROUP',
					infoHash: 'hash-2160p',
					downloadUrl: 'stream://movie/1-2160p',
					parsed: { resolution: '2160p', source: 'webdl', codec: 'h265', hdr: null }
				}),
				createSearchRelease({
					title: 'Movie.2024.1080p.WEB-GROUP',
					infoHash: 'hash-1080p',
					downloadUrl: 'stream://movie/1-1080p',
					parsed: { resolution: '1080p', source: 'webdl', codec: 'h264', hdr: null }
				})
			],
			rejectedCount: 0
		});
		mocks.grab.mockResolvedValue(createGrabResponse());

		const result = await searchOnAdd.searchForMovie({
			movieId: 'movie-1',
			tmdbId: 228967,
			title: 'Test Movie',
			year: 2024
		});

		expect(result).toMatchObject({ success: true });
		expect(mocks.grab).toHaveBeenCalledTimes(2);
		const grabbedTitles = mocks.grab.mock.calls.map((c) => c[0].release.title);
		expect(grabbedTitles).toContain('Movie.2024.2160p.UHD.WEB-GROUP');
		expect(grabbedTitles).toContain('Movie.2024.1080p.WEB-GROUP');
	});

	it('routes to upgrades when all desired buckets are filled for a multi-quality movie', async () => {
		mocks.moviesFindFirst.mockResolvedValue({
			desiredQualities: ['2160p', '1080p'],
			scoringProfileId: null
		});
		mocks.scoringProfilesFindFirst.mockResolvedValue(null);
		const existing2160pFile = {
			id: 'file-1',
			movieId: 'movie-1',
			relativePath: 'Movie.2024.2160p.mkv',
			quality: { resolution: '2160p' }
		};
		const existing1080pFile = {
			id: 'file-2',
			movieId: 'movie-1',
			relativePath: 'Movie.2024.1080p.mkv',
			quality: { resolution: '1080p' }
		};
		mocks.movieFilesFindFirst.mockResolvedValue(existing2160pFile);
		mocks.movieFilesFindMany.mockResolvedValue([existing2160pFile, existing1080pFile]);
		mocks.searchEnhanced.mockResolvedValue({
			releases: [
				createSearchRelease({
					title: 'Movie.2024.2160p.UHD.WEB-GROUP',
					infoHash: 'hash-2160p-upgrade',
					downloadUrl: 'stream://movie/1-2160p-upgrade',
					totalScore: 500,
					parsed: { resolution: '2160p', source: 'webdl', codec: 'h265', hdr: null }
				})
			],
			rejectedCount: 0
		});
		mocks.grab.mockResolvedValue(createGrabResponse());

		const result = await searchOnAdd.searchForMovie({
			movieId: 'movie-1',
			tmdbId: 228967,
			title: 'Test Movie',
			year: 2024
		});

		expect(result).toMatchObject({ success: true });
		expect(mocks.grab).toHaveBeenCalledTimes(1);
		expect(mocks.grab).toHaveBeenCalledWith(
			expect.objectContaining({
				options: expect.objectContaining({ isUpgrade: true })
			})
		);
		const grabbedTitles = mocks.grab.mock.calls.map((c) => c[0].release.title);
		expect(grabbedTitles).toContain('Movie.2024.2160p.UHD.WEB-GROUP');
	});
});

describe('SearchOnAddService.searchForMissingEpisodes monitoring behavior', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetAlternateTitleRefreshCache();
		mocks.getIndexerManager.mockResolvedValue(createIndexerManagerMock());
		mocks.getMovieSearchTitles.mockResolvedValue([]);
		mocks.getSeriesSearchTitles.mockResolvedValue([]);
		mocks.fetchAndStoreMovieAlternateTitles.mockResolvedValue(0);
		mocks.fetchAndStoreSeriesAlternateTitles.mockResolvedValue(0);
		mocks.getMultiSeasonSearchStrategy.mockReturnValue({
			searchWithMultiSeasonPriority: mocks.searchWithMultiSeasonPriority
		});
		mocks.searchWithMultiSeasonPriority.mockResolvedValue({
			results: [],
			summary: {
				searched: 0,
				found: 0,
				grabbed: 0,
				completeSeriesPacksGrabbed: 0,
				multiSeasonPacksGrabbed: 0,
				singleSeasonPacksGrabbed: 0,
				individualEpisodesGrabbed: 0
			},
			seasonPacks: [],
			multiSeasonPacks: []
		});
	});

	it('filters to monitored episodes by default', async () => {
		mocks.seriesFindFirst.mockResolvedValue(
			createSeries({
				id: 'series-1',
				title: 'Afro Samurai',
				tmdbId: 19544,
				tvdbId: 79755,
				imdbId: 'tt0465316',
				scoringProfileId: 'streamer'
			})
		);
		mocks.episodesFindMany.mockResolvedValue([
			createEpisode({
				id: 'ep-1',
				seriesId: 'series-1',
				seasonNumber: 1,
				episodeNumber: 1,
				hasFile: false,
				monitored: true,
				airDate: '2007-01-03'
			})
		]);

		await searchOnAdd.searchForMissingEpisodes('series-1');

		expect(mocks.searchWithMultiSeasonPriority).toHaveBeenCalledWith(
			expect.objectContaining({
				searchSource: 'automatic',
				episodes: [
					expect.objectContaining({
						id: 'ep-1',
						monitored: true
					})
				]
			})
		);
	});

	it('includes unmonitored episodes when bypassMonitoring is true', async () => {
		mocks.seriesFindFirst.mockResolvedValue(
			createSeries({
				id: 'series-1',
				title: 'Afro Samurai',
				tmdbId: 19544,
				tvdbId: 79755,
				imdbId: 'tt0465316',
				scoringProfileId: 'streamer'
			})
		);
		mocks.episodesFindMany.mockResolvedValue([
			createEpisode({
				id: 'ep-1',
				seriesId: 'series-1',
				seasonNumber: 1,
				episodeNumber: 1,
				hasFile: false,
				monitored: false,
				airDate: '2007-01-03'
			}),
			createEpisode({
				id: 'ep-2',
				seriesId: 'series-1',
				seasonNumber: 1,
				episodeNumber: 2,
				hasFile: false,
				monitored: true,
				airDate: '2007-01-10'
			})
		]);

		await searchOnAdd.searchForMissingEpisodes('series-1', undefined, {
			bypassMonitoring: true
		});

		expect(mocks.searchWithMultiSeasonPriority).toHaveBeenCalledWith(
			expect.objectContaining({
				searchSource: 'automatic',
				completeSeriesThreshold: 100,
				multiSeasonThreshold: 100,
				singleSeasonThreshold: 100,
				episodes: [
					expect.objectContaining({
						id: 'ep-1',
						monitored: false
					}),
					expect.objectContaining({
						id: 'ep-2',
						monitored: true
					})
				]
			})
		);
	});

	it('keeps default pack thresholds for non-bypassed missing searches', async () => {
		mocks.seriesFindFirst.mockResolvedValue(
			createSeries({
				id: 'series-1',
				title: 'Afro Samurai',
				tmdbId: 19544,
				tvdbId: 79755,
				imdbId: 'tt0465316',
				scoringProfileId: 'streamer'
			})
		);
		mocks.episodesFindMany.mockResolvedValue([
			createEpisode({
				id: 'ep-1',
				seriesId: 'series-1',
				seasonNumber: 1,
				episodeNumber: 1,
				hasFile: false,
				monitored: true,
				airDate: '2007-01-03'
			})
		]);

		await searchOnAdd.searchForMissingEpisodes('series-1');

		expect(mocks.searchWithMultiSeasonPriority).toHaveBeenCalledWith(
			expect.objectContaining({
				searchSource: 'automatic',
				completeSeriesThreshold: undefined,
				multiSeasonThreshold: undefined,
				singleSeasonThreshold: undefined
			})
		);
	});

	it('uses episode-only strategy in auto mode when RuTracker is the only eligible TV indexer', async () => {
		const ruTrackerOnlyIndexerManager = createIndexerManagerMockWith([
			{
				...TEST_INDEXER_CONFIG,
				id: 'indexer-rutracker',
				name: 'RuTracker.org',
				definitionId: 'rutracker',
				protocol: 'torrent',
				baseUrl: 'https://rutracker.org/forum'
			}
		]);
		mocks.getIndexerManager.mockResolvedValue(ruTrackerOnlyIndexerManager);
		mocks.seriesFindFirst.mockResolvedValue(
			createSeries({
				id: 'series-1',
				title: 'Afro Samurai',
				tmdbId: 19544,
				tvdbId: 79755,
				imdbId: 'tt0465316',
				scoringProfileId: 'balanced'
			})
		);
		mocks.episodesFindMany
			.mockResolvedValueOnce([
				createEpisode({
					id: 'ep-1',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 1,
					hasFile: false,
					monitored: true,
					airDate: '2007-01-03'
				})
			])
			.mockResolvedValueOnce([
				createEpisode({
					id: 'ep-1',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 1,
					hasFile: false,
					monitored: true,
					airDate: '2007-01-03'
				}),
				createEpisode({
					id: 'ep-2',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 2,
					hasFile: true,
					monitored: true,
					airDate: '2007-01-10'
				}),
				createEpisode({
					id: 'ep-3',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 3,
					hasFile: true,
					monitored: true,
					airDate: '2007-01-17'
				})
			]);

		const searchForEpisodeSpy = vi
			.spyOn(searchOnAdd, 'searchForEpisode')
			.mockResolvedValue({ success: false, error: 'No suitable releases found' });
		const searchForSeasonSpy = vi.spyOn(searchOnAdd, 'searchForSeason');

		await searchOnAdd.searchForMissingEpisodes('series-1', undefined, {
			bypassMonitoring: true,
			searchStrategy: 'auto'
		});

		expect(mocks.searchWithMultiSeasonPriority).not.toHaveBeenCalled();
		expect(searchForSeasonSpy).not.toHaveBeenCalled();
		expect(searchForEpisodeSpy).toHaveBeenCalledTimes(1);
	});

	it('uses episode-only strategy in auto mode when Kinozal is the only eligible TV indexer', async () => {
		const kinozalOnlyIndexerManager = createIndexerManagerMockWith([
			{
				...TEST_INDEXER_CONFIG,
				id: 'indexer-kinozal',
				name: 'Kinozal',
				definitionId: 'kinozal',
				protocol: 'torrent',
				baseUrl: 'https://kinozal.tv'
			}
		]);
		mocks.getIndexerManager.mockResolvedValue(kinozalOnlyIndexerManager);
		mocks.seriesFindFirst.mockResolvedValue(
			createSeries({
				id: 'series-1',
				title: 'Afro Samurai',
				tmdbId: 19544,
				tvdbId: 79755,
				imdbId: 'tt0465316',
				scoringProfileId: 'balanced'
			})
		);
		mocks.episodesFindMany
			.mockResolvedValueOnce([
				createEpisode({
					id: 'ep-1',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 1,
					hasFile: false,
					monitored: true,
					airDate: '2007-01-03'
				})
			])
			.mockResolvedValueOnce([
				createEpisode({
					id: 'ep-1',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 1,
					hasFile: false,
					monitored: true,
					airDate: '2007-01-03'
				}),
				createEpisode({
					id: 'ep-2',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 2,
					hasFile: true,
					monitored: true,
					airDate: '2007-01-10'
				})
			]);

		const searchForEpisodeSpy = vi
			.spyOn(searchOnAdd, 'searchForEpisode')
			.mockResolvedValue({ success: false, error: 'No suitable releases found' });
		const searchForSeasonSpy = vi.spyOn(searchOnAdd, 'searchForSeason');

		await searchOnAdd.searchForMissingEpisodes('series-1', undefined, {
			bypassMonitoring: true,
			searchStrategy: 'auto'
		});

		expect(mocks.searchWithMultiSeasonPriority).not.toHaveBeenCalled();
		expect(searchForSeasonSpy).not.toHaveBeenCalled();
		expect(searchForEpisodeSpy).toHaveBeenCalledTimes(1);
	});

	it('keeps pack-first strategy in auto mode when non-RuTracker TV indexers are also eligible', async () => {
		const mixedIndexerManager = createIndexerManagerMockWith([
			{
				...TEST_INDEXER_CONFIG,
				id: 'indexer-rutracker',
				name: 'RuTracker.org',
				definitionId: 'rutracker',
				protocol: 'torrent',
				baseUrl: 'https://rutracker.org/forum'
			},
			{
				...TEST_INDEXER_CONFIG,
				id: 'indexer-hydra',
				name: 'NZBHydra2',
				definitionId: 'nzbhydra2',
				protocol: 'usenet',
				baseUrl: 'https://hydra.example.test'
			}
		]);
		mocks.getIndexerManager.mockResolvedValue(mixedIndexerManager);
		mocks.seriesFindFirst.mockResolvedValue(
			createSeries({
				id: 'series-1',
				title: 'Afro Samurai',
				tmdbId: 19544,
				tvdbId: 79755,
				imdbId: 'tt0465316',
				scoringProfileId: 'balanced'
			})
		);
		mocks.episodesFindMany.mockResolvedValue([
			createEpisode({
				id: 'ep-1',
				seriesId: 'series-1',
				seasonNumber: 1,
				episodeNumber: 1,
				hasFile: false,
				monitored: true,
				airDate: '2007-01-03'
			})
		]);

		const searchForEpisodeSpy = vi.spyOn(searchOnAdd, 'searchForEpisode');
		const searchForSeasonSpy = vi.spyOn(searchOnAdd, 'searchForSeason');

		await searchOnAdd.searchForMissingEpisodes('series-1', undefined, {
			bypassMonitoring: true,
			searchStrategy: 'auto'
		});

		expect(mocks.searchWithMultiSeasonPriority).toHaveBeenCalledTimes(1);
		expect(searchForEpisodeSpy).not.toHaveBeenCalled();
		expect(searchForSeasonSpy).not.toHaveBeenCalled();
	});

	it('uses episode-only strategy when requested for manual missing auto-grab', async () => {
		mocks.seriesFindFirst.mockResolvedValue(
			createSeries({
				id: 'series-1',
				title: 'Afro Samurai',
				tmdbId: 19544,
				tvdbId: 79755,
				imdbId: 'tt0465316',
				scoringProfileId: 'streamer'
			})
		);
		mocks.episodesFindMany
			.mockResolvedValueOnce([
				createEpisode({
					id: 'ep-1',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 1,
					hasFile: false,
					monitored: false,
					airDate: '2007-01-03'
				}),
				createEpisode({
					id: 'ep-2',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 2,
					hasFile: false,
					monitored: true,
					airDate: '2007-01-10'
				})
			])
			.mockResolvedValueOnce([
				createEpisode({
					id: 'ep-1',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 1,
					hasFile: false,
					monitored: false,
					airDate: '2007-01-03'
				}),
				createEpisode({
					id: 'ep-2',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 2,
					hasFile: false,
					monitored: true,
					airDate: '2007-01-10'
				}),
				createEpisode({
					id: 'ep-3',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 3,
					hasFile: true,
					monitored: true,
					airDate: '2007-01-17'
				})
			]);

		const searchForEpisodeSpy = vi
			.spyOn(searchOnAdd, 'searchForEpisode')
			.mockResolvedValueOnce({
				success: true,
				releaseName: 'Afro.Samurai.S01E01.1080p.WEB.H264-GROUP'
			})
			.mockResolvedValueOnce({
				success: false,
				error: 'No suitable releases found'
			});
		const searchForSeasonSpy = vi.spyOn(searchOnAdd, 'searchForSeason');

		const result = await searchOnAdd.searchForMissingEpisodes('series-1', undefined, {
			bypassMonitoring: true,
			searchStrategy: 'episode-only'
		});

		expect(mocks.searchWithMultiSeasonPriority).not.toHaveBeenCalled();
		expect(searchForSeasonSpy).not.toHaveBeenCalled();
		expect(searchForEpisodeSpy).toHaveBeenCalledTimes(2);
		expect(searchForEpisodeSpy).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				episodeId: 'ep-1',
				bypassMonitoring: true
			}),
			expect.anything()
		);
		expect(searchForEpisodeSpy).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				episodeId: 'ep-2',
				bypassMonitoring: true
			}),
			expect.anything()
		);
		expect(result.summary).toEqual({
			searched: 2,
			found: 1,
			grabbed: 1,
			seasonPacksGrabbed: 0,
			individualEpisodesGrabbed: 1
		});
		expect(result.results).toEqual([
			{
				itemId: 'ep-1',
				itemLabel: 'S01E01',
				found: true,
				grabbed: true,
				releaseName: 'Afro.Samurai.S01E01.1080p.WEB.H264-GROUP',
				error: undefined
			},
			{
				itemId: 'ep-2',
				itemLabel: 'S01E02',
				found: false,
				grabbed: false,
				releaseName: undefined,
				error: 'No suitable releases found'
			}
		]);
	});

	it('counts successful episode grabs even when releaseName is missing', async () => {
		mocks.seriesFindFirst.mockResolvedValue(
			createSeries({
				id: 'series-1',
				title: 'Afro Samurai',
				tmdbId: 19544,
				tvdbId: 79755,
				imdbId: 'tt0465316',
				scoringProfileId: 'streamer'
			})
		);
		mocks.episodesFindMany
			.mockResolvedValueOnce([
				createEpisode({
					id: 'ep-1',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 1,
					hasFile: false,
					monitored: true,
					airDate: '2007-01-03'
				}),
				createEpisode({
					id: 'ep-2',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 2,
					hasFile: false,
					monitored: true,
					airDate: '2007-01-10'
				})
			])
			.mockResolvedValueOnce([
				createEpisode({
					id: 'ep-1',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 1,
					hasFile: false,
					monitored: true,
					airDate: '2007-01-03'
				}),
				createEpisode({
					id: 'ep-2',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 2,
					hasFile: false,
					monitored: true,
					airDate: '2007-01-10'
				}),
				createEpisode({
					id: 'ep-3',
					seriesId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 3,
					hasFile: true,
					monitored: true,
					airDate: '2007-01-17'
				})
			]);

		vi.spyOn(searchOnAdd, 'searchForSeason');
		const searchForEpisodeSpy = vi
			.spyOn(searchOnAdd, 'searchForEpisode')
			.mockResolvedValueOnce({
				success: true
			})
			.mockResolvedValueOnce({
				success: false,
				error: 'No suitable releases found'
			});

		const result = await searchOnAdd.searchForMissingEpisodes('series-1', undefined, {
			bypassMonitoring: true,
			searchStrategy: 'episode-only'
		});

		expect(searchForEpisodeSpy).toHaveBeenCalledTimes(2);
		expect(result.summary).toEqual({
			searched: 2,
			found: 1,
			grabbed: 1,
			seasonPacksGrabbed: 0,
			individualEpisodesGrabbed: 1
		});
		expect(result.results).toEqual([
			{
				itemId: 'ep-1',
				itemLabel: 'S01E01',
				found: true,
				grabbed: true,
				releaseName: undefined,
				error: undefined
			},
			{
				itemId: 'ep-2',
				itemLabel: 'S01E02',
				found: false,
				grabbed: false,
				releaseName: undefined,
				error: 'No suitable releases found'
			}
		]);
	});

	it('uses season-pack grab in episode-only mode when the full aired season is missing', async () => {
		mocks.seriesFindFirst.mockResolvedValue(
			createSeries({
				id: 'series-1',
				title: 'Afro Samurai',
				tmdbId: 19544,
				tvdbId: 79755,
				imdbId: 'tt0465316',
				scoringProfileId: 'streamer'
			})
		);
		const missingSeasonEpisodes = [
			createEpisode({
				id: 'ep-1',
				seriesId: 'series-1',
				seasonNumber: 1,
				episodeNumber: 1,
				hasFile: false,
				monitored: true,
				airDate: '2007-01-03'
			}),
			createEpisode({
				id: 'ep-2',
				seriesId: 'series-1',
				seasonNumber: 1,
				episodeNumber: 2,
				hasFile: false,
				monitored: true,
				airDate: '2007-01-10'
			})
		];
		mocks.episodesFindMany
			.mockResolvedValueOnce(missingSeasonEpisodes)
			.mockResolvedValueOnce(missingSeasonEpisodes);

		const searchForSeasonSpy = vi.spyOn(searchOnAdd, 'searchForSeason').mockResolvedValue({
			success: true,
			releaseName: 'Afro.Samurai.S01.Complete.1080p.BluRay-GROUP'
		});
		const searchForEpisodeSpy = vi.spyOn(searchOnAdd, 'searchForEpisode');

		const result = await searchOnAdd.searchForMissingEpisodes('series-1', undefined, {
			bypassMonitoring: true,
			searchStrategy: 'episode-only'
		});

		expect(mocks.searchWithMultiSeasonPriority).not.toHaveBeenCalled();
		expect(searchForSeasonSpy).toHaveBeenCalledTimes(1);
		expect(searchForSeasonSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				seriesId: 'series-1',
				seasonNumber: 1,
				bypassMonitoring: true
			}),
			expect.anything()
		);
		expect(searchForEpisodeSpy).not.toHaveBeenCalled();
		expect(result.summary).toEqual({
			searched: 2,
			found: 2,
			grabbed: 2,
			seasonPacksGrabbed: 1,
			individualEpisodesGrabbed: 0
		});
		expect(result.results).toEqual([
			{
				itemId: 'ep-1',
				itemLabel: 'S01E01',
				found: true,
				grabbed: true,
				releaseName: 'Afro.Samurai.S01.Complete.1080p.BluRay-GROUP',
				wasPackGrab: true
			},
			{
				itemId: 'ep-2',
				itemLabel: 'S01E02',
				found: true,
				grabbed: true,
				releaseName: 'Afro.Samurai.S01.Complete.1080p.BluRay-GROUP',
				wasPackGrab: true
			}
		]);
		expect(result.seasonPacks).toEqual([
			{
				seasonNumber: 1,
				releaseName: 'Afro.Samurai.S01.Complete.1080p.BluRay-GROUP',
				episodesCovered: ['ep-1', 'ep-2']
			}
		]);
	});
});
