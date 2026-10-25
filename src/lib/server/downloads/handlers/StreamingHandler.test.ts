/**
 * StreamingHandler routing tests.
 *
 * Complete-series indexer results use `stream://tv/{tmdbId}/all`, which parses
 * to `isCompleteSeries` with no season. The handler must expand those into
 * per-season packs instead of falling through to the single-episode path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GrabRequest, ResolvedContext } from '../grab-types.js';

const mocks = vi.hoisted(() => ({
	parseStreamUrl: vi.fn(),
	findSeries: vi.fn(),
	findEpisodes: vi.fn(),
	getStreamingBaseUrl: vi.fn().mockResolvedValue('http://localhost:3000')
}));

vi.mock('#lib/server/streaming/index.js', () => {
	class MockStrmService {
		static parseStreamUrl = mocks.parseStreamUrl;
		createStrmFile = vi.fn();
		createSeasonStrmFiles = vi.fn();
	}
	return {
		StrmService: MockStrmService,
		strmService: new MockStrmService(),
		getStreamingBaseUrl: mocks.getStreamingBaseUrl
	};
});

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		query: {
			series: { findFirst: mocks.findSeries },
			episodes: { findMany: mocks.findEpisodes },
			movies: { findFirst: vi.fn() },
			movieFiles: { findMany: vi.fn() },
			episodeFiles: { findFirst: vi.fn() }
		},
		select: vi.fn(),
		update: vi.fn(),
		insert: vi.fn()
	}
}));

vi.mock('#lib/server/auth/index.js', () => ({
	getOwnerStreamingApiKey: vi.fn().mockResolvedValue({ id: 'streaming-key' })
}));

vi.mock('#lib/server/subtitles/services/SubtitleImportService.js', () => ({
	searchSubtitlesForNewMedia: vi.fn()
}));

vi.mock('#lib/server/downloadClients/import/index.js', () => ({
	fileExists: vi.fn(),
	importService: {}
}));

vi.mock('#lib/server/downloadClients/import/FileTransfer.js', () => ({
	deletePhysicalFile: vi.fn()
}));

vi.mock('#lib/server/settings/file-management.js', () => ({
	getFileManagementSettings: vi.fn().mockResolvedValue({})
}));

vi.mock('#lib/server/monitoring/MonitoringScheduler.js', () => ({
	monitoringScheduler: { getSettings: vi.fn().mockResolvedValue({}) }
}));

vi.mock('#lib/server/sse/EventBuffer.js', () => ({
	eventBuffer: { push: vi.fn() }
}));

vi.mock('#lib/server/library/LibraryMediaEvents.js', () => ({
	libraryMediaEvents: { emitSeriesUpdated: vi.fn() }
}));

vi.mock('#lib/server/library/media-info.js', () => ({
	mediaInfoService: { extractMediaInfo: vi.fn() }
}));

vi.mock('#lib/logging/index.js', () => {
	const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	return { createChildLogger: vi.fn(() => logger), logger };
});

const { StreamingHandler } = await import('./StreamingHandler.js');

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe('StreamingHandler complete-series routing', () => {
	it('expands stream://tv/{id}/all into per-season packs', async () => {
		mocks.parseStreamUrl.mockReturnValue({
			isSeasonPack: true,
			isCompleteSeries: true,
			season: undefined,
			episode: undefined,
			tmdbId: '1234'
		});
		mocks.findSeries.mockResolvedValue({ id: 'series-1' });
		mocks.findEpisodes.mockResolvedValue([
			{ id: 'e1', seasonNumber: 1, episodeNumber: 1 },
			{ id: 'e2', seasonNumber: 2, episodeNumber: 1 },
			{ id: 'e3', seasonNumber: 0, episodeNumber: 1 } // specials excluded
		]);

		const seasonPackSpy = vi
			.spyOn(
				StreamingHandler.prototype as unknown as {
					handleSeasonPack: (...args: unknown[]) => Promise<Record<string, unknown>>;
				},
				'handleSeasonPack'
			)
			.mockResolvedValue({ success: true, queueId: 'streaming' });

		const handler = new StreamingHandler();
		const result = await handler.handle(
			{
				release: { title: 'Complete Series', downloadUrl: 'stream://tv/1234/all' },
				options: {}
			} as unknown as GrabRequest,
			{ seriesId: 'series-1', mediaType: 'tv' } as unknown as ResolvedContext
		);

		expect(result.success).toBe(true);
		expect(seasonPackSpy).toHaveBeenCalledTimes(2);
		// Season numbers passed explicitly (1 and 2), never the specials season.
		expect(seasonPackSpy.mock.calls.map((call) => call[4])).toEqual([1, 2]);

		// The single-episode fallthrough must not have run.
		const strmInstance = (await import('#lib/server/streaming/index.js'))
			.strmService as unknown as {
			createStrmFile: ReturnType<typeof vi.fn>;
		};
		expect(strmInstance.createStrmFile).not.toHaveBeenCalled();
	});
});
