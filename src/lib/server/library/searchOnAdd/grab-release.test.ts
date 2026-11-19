import { describe, it, expect } from 'vitest';
import { toGrabRelease } from './grab-release.js';
import type { EnhancedReleaseResult } from '#lib/server/indexers/types/index.js';

function release(overrides: Record<string, unknown> = {}): EnhancedReleaseResult {
	return {
		title: 'Alien.1979.1080p.BluRay.x264-GROUP',
		infoHash: 'abc123',
		magnetUrl: 'magnet:?xt=urn:btih:abc123',
		downloadUrl: 'https://indexer.test/torrent/1',
		indexerId: 'ix-1',
		indexerName: 'Indexer One',
		size: 8_000_000_000,
		protocol: 'torrent',
		tmdbId: 348,
		imdbId: 'tt0078748',
		tvdbId: 1234,
		...overrides
	} as unknown as EnhancedReleaseResult;
}

describe('toGrabRelease', () => {
	it('carries every identity and download field the grab needs', () => {
		expect(toGrabRelease(release())).toEqual({
			title: 'Alien.1979.1080p.BluRay.x264-GROUP',
			infoHash: 'abc123',
			magnetUrl: 'magnet:?xt=urn:btih:abc123',
			downloadUrl: 'https://indexer.test/torrent/1',
			indexerId: 'ix-1',
			indexerName: 'Indexer One',
			size: 8_000_000_000,
			protocol: 'torrent',
			tmdbId: 348,
			imdbId: 'tt0078748',
			tvdbId: 1234
		});
	});

	it('leaves absent fields undefined instead of inventing values', () => {
		const mapped = toGrabRelease(release({ infoHash: undefined, tmdbId: undefined }));

		expect(mapped.infoHash).toBeUndefined();
		expect(mapped.tmdbId).toBeUndefined();
		expect(mapped.title).toBe('Alien.1979.1080p.BluRay.x264-GROUP');
	});

	it('does not leak extra release fields the grab does not take', () => {
		const mapped = toGrabRelease(release({ seeders: 12, parsed: { resolution: '1080p' } }));

		expect(mapped).not.toHaveProperty('seeders');
		expect(mapped).not.toHaveProperty('parsed');
	});
});
