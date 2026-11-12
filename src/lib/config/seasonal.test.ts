import { describe, expect, it } from 'vitest';

import {
	SEASONAL_PRESETS,
	findActiveSeasonalPreset,
	seasonalKeywordParam,
	seasonalUrlChanges
} from './seasonal.js';

const preset = (id: string) => {
	const found = SEASONAL_PRESETS.find((p) => p.id === id);
	if (!found) throw new Error(`no preset ${id}`);
	return found;
};

const defaults = { type: 'all', withKeywords: null, minRating: null };

describe('seasonalKeywordParam', () => {
	it('ORs the keywords, because TMDB reads a comma as AND', () => {
		expect(seasonalKeywordParam(preset('christmas'))).toBe('207317|260365|255088');
	});
});

describe('findActiveSeasonalPreset', () => {
	it('matches regardless of keyword order or separator', () => {
		expect(findActiveSeasonalPreset('260365,207317,255088')?.id).toBe('christmas');
		expect(findActiveSeasonalPreset('255088|207317|260365')?.id).toBe('christmas');
	});

	it('ignores keyword sets that are not a preset', () => {
		expect(findActiveSeasonalPreset(null)).toBeNull();
		expect(findActiveSeasonalPreset('207317')).toBeNull();
		expect(findActiveSeasonalPreset('207317|999999')).toBeNull();
	});
});

describe('seasonalUrlChanges', () => {
	it('applies the keyword OR-list and the preset floor', () => {
		const changes = seasonalUrlChanges(preset('christmas'), defaults);
		expect(changes.set).toEqual({
			with_keywords: '207317|260365|255088',
			'vote_average.gte': '6',
			page: '1'
		});
		expect(changes.remove).toEqual([]);
	});

	it('replaces the floor a previous preset injected', () => {
		const changes = seasonalUrlChanges(preset('easter'), {
			...defaults,
			withKeywords: '207317|260365|255088',
			minRating: '6'
		});
		expect(changes.set['vote_average.gte']).toBe('5');
	});

	it('never sets a floor on the TV tab, and drops a preset-injected one', () => {
		const changes = seasonalUrlChanges(preset('christmas'), {
			...defaults,
			type: 'tv',
			minRating: '5'
		});
		expect(changes.set).not.toHaveProperty('vote_average.gte');
		expect(changes.remove).toContain('vote_average.gte');
	});

	it('keeps a floor the viewer chose by hand on the TV tab', () => {
		const changes = seasonalUrlChanges(preset('christmas'), {
			...defaults,
			type: 'tv',
			minRating: '8'
		});
		expect(changes.remove).not.toContain('vote_average.gte');
	});

	it('unwinds exactly what it injected when toggled off', () => {
		const changes = seasonalUrlChanges(preset('christmas'), {
			...defaults,
			withKeywords: '207317|260365|255088',
			minRating: '6'
		});
		expect(changes.set).toEqual({ page: '1' });
		expect(changes.remove).toEqual(['with_keywords', 'vote_average.gte']);
	});

	it('leaves a viewer-chosen rating alone when toggled off', () => {
		const changes = seasonalUrlChanges(preset('christmas'), {
			...defaults,
			withKeywords: '207317|260365|255088',
			minRating: '8'
		});
		expect(changes.remove).toEqual(['with_keywords']);
	});
});
