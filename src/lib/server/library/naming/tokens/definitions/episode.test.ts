import { describe, expect, it } from 'vitest';
import { episodeTokens } from './episode';

const seasonYearToken = episodeTokens.find((t) => t.name === 'SeasonYear')!;

describe('{SeasonYear}', () => {
	it('renders the season year', () => {
		expect(seasonYearToken.render({ title: 'Show', year: 1997, seasonYear: 2022 }, {} as any)).toBe(
			'2022'
		);
	});

	it('renders nothing when the season year is unknown', () => {
		expect(seasonYearToken.render({ title: 'Show', year: 1997 }, {} as any)).toBe('');
	});

	it('is not the series year', () => {
		expect(seasonYearToken.render({ title: 'Show', year: 1997, seasonYear: 2022 }, {} as any)).toBe(
			'2022'
		);
	});
});
