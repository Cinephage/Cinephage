import { describe, expect, it } from 'vitest';

import { buildDiscoverQuery } from './discover.js';
import type { DiscoverParams } from './discover.js';

const baseParams: DiscoverParams = {
	type: 'all',
	page: '1',
	sortBy: 'popularity.desc',
	withWatchProviders: '',
	watchRegion: '',
	withNetworks: '',
	withGenres: '',
	withKeywords: '',
	withoutKeywords: '',
	withOriginalLanguage: null,
	minDate: null,
	maxDate: null,
	minRating: null,
	certification: null
};

function queryFor(
	endpoint: '/discover/movie' | '/discover/tv',
	overrides: Partial<DiscoverParams>
) {
	return new URLSearchParams(
		buildDiscoverQuery(endpoint, { ...baseParams, ...overrides }, '3').split('?')[1]
	);
}

describe('buildDiscoverQuery', () => {
	it('sends selected networks to the TV endpoint pipe-joined as OR', () => {
		const query = queryFor('/discover/tv', { withNetworks: '56,13' });
		expect(query.get('with_networks')).toBe('56|13');
	});

	it('never sends networks to the movie endpoint', () => {
		const query = queryFor('/discover/movie', { withNetworks: '56,13' });
		expect(query.has('with_networks')).toBe(false);
	});

	it('keeps certification on the movie endpoint only', () => {
		const movie = queryFor('/discover/movie', {
			certification: 'PG-13',
			sortBy: 'popularity.desc'
		});
		expect(movie.get('certification')).toBe('PG-13');

		const tv = queryFor('/discover/tv', { certification: 'PG-13' });
		expect(tv.has('certification')).toBe(false);
	});

	it('remaps sort and date field names for TV', () => {
		const query = queryFor('/discover/tv', {
			sortBy: 'primary_release_date.desc',
			minDate: '2020-01-01',
			maxDate: '2024-12-31'
		});
		expect(query.get('sort_by')).toBe('first_air_date.desc');
		expect(query.get('first_air_date.gte')).toBe('2020-01-01');
		expect(query.get('first_air_date.lte')).toBe('2024-12-31');
	});

	it('uses movie field names on the movie endpoint', () => {
		const query = queryFor('/discover/movie', {
			sortBy: 'primary_release_date.desc',
			minDate: '2020-01-01'
		});
		expect(query.get('sort_by')).toBe('primary_release_date.desc');
		expect(query.get('primary_release_date.gte')).toBe('2020-01-01');
		expect(query.get('first_air_date.gte')).toBeNull();
	});

	it('applies the shared minimum vote count alongside a rating filter', () => {
		const query = queryFor('/discover/tv', { minRating: '7' });
		expect(query.get('vote_average.gte')).toBe('7');
		expect(query.get('vote_count.gte')).toBe('50');
	});
});
