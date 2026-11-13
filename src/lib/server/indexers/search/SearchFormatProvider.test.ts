import { describe, expect, it } from 'vitest';
import { getEffectiveEpisodeFormats, ALL_EPISODE_FORMATS } from './SearchFormatProvider';

describe('getEffectiveEpisodeFormats', () => {
	it('tries every format when the definition declares none', () => {
		expect(getEffectiveEpisodeFormats(undefined)).toEqual(ALL_EPISODE_FORMATS);
		expect(getEffectiveEpisodeFormats(undefined, false)).toEqual(['standard']);
	});

	it('uses the formats the definition declares', () => {
		expect(getEffectiveEpisodeFormats(['standard', 'european'])).toEqual(['standard', 'european']);
	});

	it('honours an explicit empty list as "no episode tokens"', () => {
		// RuTracker titles carry "Серии: 1-7 из 8", so an Sxx/Eyy query matches
		// nothing - and every variant costs a request against a Cloudflare-gated
		// tracker. An empty list must mean none, not "fall back to all".
		expect(getEffectiveEpisodeFormats([])).toEqual([]);
		expect(getEffectiveEpisodeFormats([], false)).toEqual([]);
	});
});
