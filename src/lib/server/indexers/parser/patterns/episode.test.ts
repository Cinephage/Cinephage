/**
 * Episode Pattern Tests
 *
 * Unit coverage for extractEpisode / extractTitleBeforeEpisode, including
 * regressions from issue #513:
 *  - Bracketed season/episode notation: "Breaking Bad - [3x13] - Full Measure"
 *  - Same-season ranges with loose separators: "Lost s01e25 - s01e26 - ..."
 */
import { describe, it, expect } from 'vitest';
import { extractEpisode, extractTitleBeforeEpisode } from './episode.js';

describe('episode patterns (#513 regressions)', () => {
	it('parses bracketed NxNN notation: "[3x13]"', () => {
		const match = extractEpisode('Breaking Bad - [3x13] - Full Measure');
		expect(match).not.toBeNull();
		expect(match!.info.season).toBe(3);
		expect(match!.info.episodes).toEqual([13]);
	});

	it('derives clean title before bracketed notation', () => {
		const title = extractTitleBeforeEpisode('Breaking Bad - [3x13] - Full Measure');
		expect(title).toBe('Breaking Bad');
	});

	it('parses bracketed SxxExx notation: "[S03E13]"', () => {
		const match = extractEpisode('Show Name [S03E13]');
		expect(match).not.toBeNull();
		expect(match!.info.season).toBe(3);
		expect(match!.info.episodes).toEqual([13]);
	});

	it('parses same-season range with loose separators: "s01e25 - s01e26"', () => {
		const match = extractEpisode('Lost s01e25 - s01e26 - Exodus Parts 2 and 3');
		expect(match).not.toBeNull();
		expect(match!.info.season).toBe(1);
		expect(match!.info.episodes).toEqual([25, 26]);
		expect(match!.info.isSeasonPack).toBe(false);
	});

	it('does not treat same-season double-notation as a multi-season pack', () => {
		const match = extractEpisode('Show s01e01 - s01e02');
		expect(match?.info.seasons).toBeUndefined();
	});

	it('keeps genuine cross-season ranges intact: "S01E01-S08E99"', () => {
		const match = extractEpisode('Show S01E01-S08E99');
		expect(match?.info.seasons).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
	});

	it('recovers the title when it is preceded by a leading episode marker', () => {
		// Some trackers front-load episode info ("Season 2 Episode 4 - Show
		// Name - S02E04"), leaving nothing before the marker for the normal
		// "slice before earliest match" path to use as a title.
		const title = extractTitleBeforeEpisode('Season 2 Episode 4 - Mob Land - S2E4 - 2026');
		expect(title).toBe('Mob Land');
	});

	it('falls back to the full remainder when no second episode marker follows a leading one', () => {
		const title = extractTitleBeforeEpisode('Season 2 Episode 4 - Mob Land');
		expect(title).toBe('Mob Land');
	});
});
