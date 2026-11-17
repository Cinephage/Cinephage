/**
 * Magnet fallback: a grab that asked for a .torrent and only ended up with a
 * magnet.
 *
 * The default is to proceed and warn, because the client can still complete the
 * download. An indexer that declares `magnetFallback: false` refuses instead:
 * the magnet carries no file list and no personal announce, and a magnet add
 * consumes the grab, while a refusal leaves the retry loop alive (#663).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrabRequest, ResolvedContext } from '../grab-types.js';

const addDownload = vi.fn();
const addToQueue = vi.fn();
const resolveDownload = vi.fn();
const getIndexerConfig = vi.fn();
const logWarn = vi.fn();

vi.mock('#lib/logging/index.js', () => {
	const logger = { info: vi.fn(), debug: vi.fn(), warn: logWarn, error: vi.fn() };
	return { logger, createChildLogger: () => logger };
});

vi.mock('#lib/server/downloadClients/DownloadClientManager.js', () => ({
	getDownloadClientManager: () => ({
		getClientForProtocol: async () => ({
			client: {
				id: 'client-1',
				name: 'qBittorrent',
				movieCategory: 'Movies',
				tvCategory: 'TV',
				initialState: 'start',
				recentPriority: 'normal'
			},
			instance: { implementation: 'qbittorrent', addDownload }
		})
	})
}));

vi.mock('#lib/server/downloadClients/monitoring/index.js', () => ({
	downloadMonitor: {
		canExtendQueueItem: async () => false,
		addToQueue,
		extendQueueItemEpisodes: vi.fn()
	}
}));

vi.mock('../DownloadResolutionService.js', () => ({
	getDownloadResolutionService: () => ({ resolve: resolveDownload })
}));

vi.mock('../seed-limits.js', () => ({
	resolveSeedLimits: async () => ({ ratio: undefined, timeMinutes: undefined })
}));

vi.mock('../episode-pack-selection.js', () => ({ resolveEpisodePackSelection: vi.fn() }));
vi.mock('../imported-scope.js', () => ({ resolveImportedScope: vi.fn() }));
vi.mock('#lib/server/monitoring/specifications/BlocklistSpecification.js', () => ({
	blocklistService: { addToBlocklist: vi.fn() }
}));
vi.mock('#lib/server/acquisition/AcquisitionService.js', () => ({
	acquisitionService: { cancelIntent: vi.fn() }
}));

vi.mock('#lib/server/indexers/IndexerManager.js', () => ({
	getIndexerManager: async () => ({ getIndexer: getIndexerConfig })
}));

const { TorrentHandler } = await import('./TorrentHandler.js');

const MAGNET = 'magnet:?xt=urn:btih:0c309339023d410fe9d34e65c18955e388535166';
const DOWNLOAD_URL = 'https://rutracker.org/forum/dl.php?t=6926974';

function request(overrides: { magnetUrl?: string } = {}): GrabRequest {
	return {
		release: {
			title: 'Season 1 Episode 5 - VisionQuest.S01.DSNP.WEB-DL.1080p.by.AKTEP',
			downloadUrl: DOWNLOAD_URL,
			magnetUrl: overrides.magnetUrl,
			indexerId: 'indexer-1',
			indexerName: 'RuTracker.org',
			size: 1_000_000,
			protocol: 'torrent',
			commentsUrl: 'https://rutracker.org/forum/viewtopic.php?t=6926974'
		},
		target: {
			type: 'episode',
			episodeId: 'ep-5',
			seriesId: 'series-1'
		},
		options: { isAutomatic: true }
	} as unknown as GrabRequest;
}

const resolved = {
	seriesId: 'series-1',
	seasonNumber: 1,
	episodeIds: ['ep-5'],
	mediaType: 'tv'
} as unknown as ResolvedContext;

function settingsReturning(settings: Record<string, unknown>) {
	getIndexerConfig.mockResolvedValue({ id: 'indexer-1', settings });
}

describe('TorrentHandler magnet fallback', () => {
	beforeEach(() => {
		addDownload.mockReset().mockResolvedValue('0c309339');
		addToQueue.mockReset().mockResolvedValue({ id: 'queue-1' });
		resolveDownload.mockReset().mockResolvedValue({ success: true, magnetUrl: MAGNET });
		getIndexerConfig.mockReset();
		logWarn.mockReset();
	});

	it('proceeds on a magnet when the indexer does not declare the setting', async () => {
		settingsReturning({});

		const result = await new TorrentHandler().handle(request(), resolved);

		expect(result.success).toBe(true);
		expect(addDownload).toHaveBeenCalledTimes(1);
		expect(addDownload.mock.calls[0][0]).toMatchObject({ magnetUri: MAGNET });
		// The degraded grab is still announced.
		expect(
			logWarn.mock.calls.some((call) => String(call[1]).includes('whole pack will download'))
		).toBe(true);
	});

	it.each([
		['boolean false', false],
		['the string a form posts', 'false']
	])('refuses when the indexer sets magnetFallback to %s', async (_label, value) => {
		settingsReturning({ magnetFallback: value });

		const result = await new TorrentHandler().handle(request(), resolved);

		expect(result.success).toBe(false);
		expect(result.error).toContain('Magnet fallback is disabled');
		// Nothing was handed to the client: the retry keeps its chance at the file.
		expect(addDownload).not.toHaveBeenCalled();
		expect(addToQueue).not.toHaveBeenCalled();
	});

	it('still grabs when the indexer publishes magnets by design', async () => {
		settingsReturning({ magnetFallback: false });

		const result = await new TorrentHandler().handle(request({ magnetUrl: MAGNET }), resolved);

		expect(result.success).toBe(true);
		expect(addDownload).toHaveBeenCalledTimes(1);
	});

	it('allows the fallback when the setting cannot be read', async () => {
		getIndexerConfig.mockRejectedValue(new Error('indexers table unavailable'));

		const result = await new TorrentHandler().handle(request(), resolved);

		expect(result.success).toBe(true);
		expect(addDownload).toHaveBeenCalledTimes(1);
	});

	it('does not apply to a grab that never asked for a torrent file', async () => {
		settingsReturning({ magnetFallback: false });
		resolveDownload.mockResolvedValue({ success: true, magnetUrl: MAGNET });

		const withoutDownloadUrl = request() as unknown as { release: { downloadUrl?: string } };
		withoutDownloadUrl.release.downloadUrl = undefined;

		const result = await new TorrentHandler().handle(
			withoutDownloadUrl as unknown as GrabRequest,
			resolved
		);

		expect(result.success).toBe(true);
		expect(addDownload).toHaveBeenCalledTimes(1);
	});
});
