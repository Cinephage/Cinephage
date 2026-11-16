import { describe, expect, it } from 'vitest';
import { ReleaseDeduplicator } from './ReleaseDeduplicator';
import type { EnhancedReleaseResult } from '../types';

/**
 * Titles like YTS/LimeTorrents put the resolution inside brackets, which
 * title normalisation strips - so a 1080p and a 2160p release of the same film
 * used to collide on one key and only the better-scoring one survived. A movie
 * with 1080p desired then saw nothing but 4K candidates.
 */
function release(
	overrides: Partial<EnhancedReleaseResult> & { title: string }
): EnhancedReleaseResult {
	return {
		guid: overrides.title,
		downloadUrl: 'https://example.test/download',
		publishDate: new Date('2026-01-01T00:00:00Z'),
		size: 4_000_000_000,
		indexerId: 'indexer-1',
		indexerName: overrides.indexerName ?? 'YTS',
		protocol: 'torrent',
		categories: [],
		totalScore: 200,
		rejected: false,
		...overrides
	} as EnhancedReleaseResult;
}

describe('ReleaseDeduplicator', () => {
	const dedup = new ReleaseDeduplicator();

	it('keeps different resolutions of the same bracketed title apart', () => {
		const result = dedup.deduplicateEnhanced([
			release({
				title: 'Harry Potter and the Goblet of Fire (2005) [1080p] [BluRay] [5.1]',
				parsed: { resolution: '1080p' } as never
			}),
			release({
				title: 'Harry Potter and the Goblet of Fire (2005) [2160p] [BluRay] [5.1]',
				parsed: { resolution: '2160p' } as never,
				totalScore: 250
			})
		]);

		expect(result.releases.map((r) => r.parsed?.resolution)).toEqual(['1080p', '2160p']);
	});

	it('still merges the same release reported by two indexers', () => {
		const result = dedup.deduplicateEnhanced([
			release({
				title: 'Movie.Name.2024.1080p.BluRay.x264-GROUP',
				parsed: { resolution: '1080p' } as never
			}),
			release({
				title: 'Movie.Name.2024.1080p.BluRay.x264-GROUP',
				parsed: { resolution: '1080p' } as never,
				indexerName: 'LimeTorrents'
			})
		]);

		expect(result.releases).toHaveLength(1);
		expect(result.releases[0].sourceIndexers).toEqual(['YTS', 'LimeTorrents']);
	});

	it('keeps the same title from different years apart', () => {
		const result = dedup.deduplicateEnhanced([
			release({
				title: 'Movie 1994 1080p BluRay x264-GRP',
				parsed: { resolution: '1080p' } as never
			}),
			release({
				title: 'Movie 2019 1080p BluRay x264-GRP',
				parsed: { resolution: '1080p' } as never
			})
		]);

		expect(result.releases).toHaveLength(2);
	});
});
