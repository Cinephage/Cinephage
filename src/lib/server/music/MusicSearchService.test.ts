import { describe, it, expect } from 'vitest';
import {
	bestAlbumMatch,
	isAudioCategory,
	rankCandidates,
	relevantAlbumCandidates,
	trackRelevance,
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

describe('trackRelevance', () => {
	it('takes a single that names the song', () => {
		expect(trackRelevance('Chris Webby - Madhouse (2026) 320', 'Madhouse', 'Asylum')).toBe(1);
	});

	it('takes the album that contains the song', () => {
		expect(trackRelevance('Chris Webby - Asylum (2026) FLAC', 'Madhouse', 'Asylum')).toBe(0.9);
	});

	it('rejects another album by the same artist', () => {
		expect(
			trackRelevance('Chris Webby - Human After All 2005 FLAC', 'Madhouse', 'Asylum')
		).toBeLessThan(0.5);
	});
});

describe('bestAlbumMatch', () => {
	it('files a release under the album it names', () => {
		const match = bestAlbumMatch('Chris Webby - Asylum (2026) 320', [
			{ id: 'a1', title: 'Asylum' },
			{ id: 'a2', title: 'The White Noise LP' }
		]);

		expect(match).toMatchObject({ albumId: 'a1', albumTitle: 'Asylum', relevance: 1 });
	});

	it('drops a release that names none of the artist albums', () => {
		expect(
			bestAlbumMatch('Chris Isaak - Silvertone [1985] FLAC', [{ id: 'a1', title: 'Asylum' }])
		).toBeNull();
	});
});

describe('relevantAlbumCandidates', () => {
	it('keeps the album and drops a one-word match from another artist', () => {
		// Measured on "Chris Webby Asylum": the two real 320 kbps releases scored
		// 1.0; "Chris Stassy" and "Chris Isaak" scored 0.05-0.11.
		const kept = relevantAlbumCandidates([
			candidate({ title: 'Chris Webby - Asylum (2026) 320', relevance: 1 }),
			candidate({ title: 'Chris Stassy - Dangerous (2026 House) FLAC', relevance: 0.11 }),
			candidate({ title: 'Chris Isaak - Silvertone [1985] FLAC', relevance: 0.06 })
		]);

		expect(kept.map((entry) => entry.title)).toEqual(['Chris Webby - Asylum (2026) 320']);
	});

	it('keeps a reordered or partly spelled album above the floor', () => {
		const kept = relevantAlbumCandidates([
			candidate({ title: 'Discovery 2001 Daft Punk FLAC', relevance: 0.62 })
		]);

		expect(kept).toHaveLength(1);
	});

	it('drops candidates with no relevance at all', () => {
		expect(relevantAlbumCandidates([candidate({ title: 'unknown' })])).toHaveLength(0);
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
