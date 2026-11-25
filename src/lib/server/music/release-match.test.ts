import { describe, expect, it } from 'vitest';
import { pickReleaseGroup } from './release-match.js';
import type { MusicReleaseGroup } from './types.js';

function group(title: string, artist: string, year: number | null): MusicReleaseGroup {
	return {
		mbid: `${title}-${artist}-${year}`,
		title,
		primaryType: 'Album',
		secondaryTypes: [],
		firstReleaseDate: year ? `${year}-01-01` : null,
		year,
		artist: { mbid: `artist-${artist}`, name: artist, sortName: artist }
	};
}

const DISCOVERY = group('Discovery', 'Daft Punk', 2001);

describe('pickReleaseGroup', () => {
	it('accepts an exact title from the same artist', () => {
		expect(
			pickReleaseGroup({ album: 'Discovery', artist: 'Daft Punk', year: 2001 }, [DISCOVERY])
		).toBe(DISCOVERY);
	});

	it('ignores case, accents and punctuation in both fields', () => {
		const bjork = group('Homogénic', 'Björk', 1997);
		expect(pickReleaseGroup({ album: 'HOMOGENIC', artist: 'Bjork', year: 1997 }, [bjork])).toBe(
			bjork
		);
	});

	it('refuses a same-titled album from a different artist', () => {
		expect(
			pickReleaseGroup({ album: 'Discovery', artist: 'Daft Punk', year: 2001 }, [
				group('Discovery', 'Some Covers Band', 2001)
			])
		).toBeNull();
	});

	it('refuses a deluxe edition title when the folder names the plain album', () => {
		expect(
			pickReleaseGroup({ album: 'Discovery', artist: 'Daft Punk', year: 2001 }, [
				group('Discovery (Deluxe Edition)', 'Daft Punk', 2001)
			])
		).toBeNull();
	});

	it('matches a compilation by title without an artist', () => {
		const compilation = group('Now 50', 'Various Artists', 2010);
		expect(
			pickReleaseGroup({ album: 'Now 50', artist: 'Various Artists', year: 2010 }, [compilation])
		).toBe(compilation);
	});

	it('uses the year to choose between the same title and artist', () => {
		const early = group('Live', 'Band', 1997);
		const later = group('Live', 'Band', 2001);
		expect(pickReleaseGroup({ album: 'Live', artist: 'Band', year: 2001 }, [early, later])).toBe(
			later
		);
	});

	it('refuses to guess when the evidence ties', () => {
		const first = group('Live', 'Band', 2001);
		const second = { ...group('Live', 'Band', 2001), mbid: 'other-edition' };
		expect(
			pickReleaseGroup({ album: 'Live', artist: 'Band', year: 2001 }, [first, second])
		).toBeNull();
	});
});
