import { describe, it, expect } from 'vitest';
import {
	isAudioCategory,
	rankCandidates,
	type MusicReleaseCandidate
} from './MusicSearchService.js';

function candidate(overrides: Partial<MusicReleaseCandidate> = {}): MusicReleaseCandidate {
	return {
		title: 'Release',
		guid: null,
		indexerId: 'idx',
		indexerName: 'Indexer',
		protocol: 'torrent',
		size: 400_000_000,
		seeders: 10,
		leechers: 1,
		categories: [3000],
		downloadUrl: null,
		magnetUrl: null,
		infoHash: null,
		isAudioCategory: true,
		...overrides
	};
}

describe('rankCandidates', () => {
	it('puts audio-categorised releases above anything else, even with fewer seeders', () => {
		const ranked = rankCandidates([
			candidate({ title: 'Movies rip', categories: [2000], isAudioCategory: false, seeders: 900 }),
			candidate({ title: 'FLAC album', seeders: 3 })
		]);

		expect(ranked.map((entry) => entry.title)).toEqual(['FLAC album', 'Movies rip']);
	});

	it('orders audio releases by seeders, then size', () => {
		const ranked = rankCandidates([
			candidate({ title: 'few', seeders: 2 }),
			candidate({ title: 'many', seeders: 251 }),
			candidate({ title: 'many-bigger', seeders: 251, size: 500_000_000 })
		]);

		expect(ranked.map((entry) => entry.title)).toEqual(['many-bigger', 'many', 'few']);
	});

	it('treats a missing seeder count as zero', () => {
		const ranked = rankCandidates([
			candidate({ title: 'unknown', seeders: null }),
			candidate({ title: 'known', seeders: 1 })
		]);

		expect(ranked[0].title).toBe('known');
	});
});

describe('rankCandidates relevance', () => {
	it('keeps a well-seeded different album by the same artist below the searched one', () => {
		// Measured: "Human After All" (156 seeders) outranked the requested
		// "Discovery" (251) when only seeders were considered.
		const ranked = rankCandidates([
			candidate({
				title: 'Daft Punk Human After All Deluxe Edition 2005 FLAC 88',
				seeders: 156,
				relevance: 0.2
			}),
			candidate({ title: 'Daft Punk Discovery 2001 FLAC 88', seeders: 40, relevance: 1 })
		]);

		expect(ranked[0].title).toBe('Daft Punk Discovery 2001 FLAC 88');
	});
});

describe('isAudioCategory', () => {
	it('covers the audio range only', () => {
		expect(isAudioCategory(3000)).toBe(true);
		expect(isAudioCategory(3040)).toBe(true);
		expect(isAudioCategory(3999)).toBe(true);
		expect(isAudioCategory(2000)).toBe(false);
		expect(isAudioCategory(4000)).toBe(false);
	});
});
