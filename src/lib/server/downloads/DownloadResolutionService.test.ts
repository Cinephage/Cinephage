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
