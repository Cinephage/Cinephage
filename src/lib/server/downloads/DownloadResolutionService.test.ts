import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	getDownloadResolutionService,
	resetDownloadResolutionService
} from './DownloadResolutionService.js';

const getIndexerInstance = vi.fn();

vi.mock('#lib/server/indexers/IndexerManager.js', () => ({
	getIndexerManager: vi.fn(async () => ({ getIndexerInstance }))
}));

const INFO_HASH = 'D21B6FEC98653908CA62002A16B149E8C6FC77C4';

function fakeIndexer(accessType: 'public' | 'semi-private' | 'private', downloadTorrent = vi.fn()) {
	return { accessType, downloadTorrent };
}

describe('DownloadResolutionService', () => {
	beforeEach(() => {
		resetDownloadResolutionService();
		getIndexerInstance.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('resolves the same tracker URL once and reuses it for a second grab in the same pass', async () => {
		// A season pack resolved for five missing episodes used to hit dl.php five
		// times in a row, which is the burst that gets a tracker rate limiting.
		const downloadTorrent = vi.fn().mockResolvedValue({
			success: true,
			data: Buffer.from('d4:infod4:name4:testee'),
			infoHash: INFO_HASH
		});
		getIndexerInstance.mockResolvedValue(fakeIndexer('private', downloadTorrent));
		const service = getDownloadResolutionService();
		const input = {
			downloadUrl: 'https://tracker.test/forum/dl.php?t=123',
			indexerId: 'rutracker',
			title: 'Show S01E07'
		};

		const first = await service.resolve({ ...input });
		const second = await service.resolve({ ...input, title: 'Show S01E08' });

		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		expect(downloadTorrent).toHaveBeenCalledTimes(1);
	});

	it('does not cache a URL carrying a one-time token', async () => {
		const downloadTorrent = vi.fn().mockResolvedValue({
			success: true,
			data: Buffer.from('d4:infod4:name4:testee'),
			infoHash: INFO_HASH
		});
		getIndexerInstance.mockResolvedValue(fakeIndexer('private', downloadTorrent));
		const service = getDownloadResolutionService();
		const input = {
			downloadUrl: 'https://tracker.test/download?key=single-use',
			indexerId: 'ncore',
			title: 'Show S01E07'
		};

		await service.resolve({ ...input });
		await service.resolve({ ...input });

		expect(downloadTorrent).toHaveBeenCalledTimes(2);
	});

	it('public tracker: builds a magnet from the infohash and never fetches the torrent-file URL', async () => {
		const downloadTorrent = vi.fn();
		getIndexerInstance.mockResolvedValue(fakeIndexer('public', downloadTorrent));

		const result = await getDownloadResolutionService().resolve({
			downloadUrl: 'https://yts.gg/torrent/download/' + INFO_HASH,
			infoHash: INFO_HASH,
			indexerId: 'yts',
			title: 'Lone Survivor (2013) 1080p bluray x264'
		});

		expect(result.success).toBe(true);
		expect(result.magnetUrl).toContain('magnet:?xt=urn:btih:');
		expect(result.magnetUrl?.toLowerCase()).toContain(INFO_HASH.toLowerCase());
		expect(result.infoHash).toBe(INFO_HASH);
		expect(downloadTorrent).not.toHaveBeenCalled();
	});

	it('public tracker: prefers an existing magnet URL over the torrent-file URL', async () => {
		const downloadTorrent = vi.fn();
		getIndexerInstance.mockResolvedValue(fakeIndexer('public', downloadTorrent));
		const magnetUrl = `magnet:?xt=urn:btih:${INFO_HASH}&dn=Example`;

		const result = await getDownloadResolutionService().resolve({
			downloadUrl: 'https://yts.gg/torrent/download/' + INFO_HASH,
			magnetUrl,
			indexerId: 'yts',
			title: 'Example'
		});

		expect(result.success).toBe(true);
		expect(result.magnetUrl).toBe(magnetUrl);
		expect(downloadTorrent).not.toHaveBeenCalled();
	});

	it('private tracker: fetches the actual torrent file through the indexer', async () => {
		const torrentBytes = Buffer.from('d4:infod...e');
		const downloadTorrent = vi
			.fn()
			.mockResolvedValue({ success: true, data: torrentBytes, infoHash: INFO_HASH });
		getIndexerInstance.mockResolvedValue(fakeIndexer('private', downloadTorrent));

		const result = await getDownloadResolutionService().resolve({
			downloadUrl: 'https://private.test/dl/123',
			infoHash: INFO_HASH,
			indexerId: 'private-tracker',
			title: 'Some Private Release 1080p'
		});

		expect(downloadTorrent).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(true);
		expect(result.torrentFile).toEqual(torrentBytes);
		expect(result.magnetUrl).toBeUndefined();
	});
});
