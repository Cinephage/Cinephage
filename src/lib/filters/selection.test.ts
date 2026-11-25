import { describe, expect, it } from 'vitest';
import {
	activeFilters,
	hasActiveFilters,
	pruneSelection,
	readClearedFacets,
	readSelection,
	writeSelection
} from './index.js';
import type { FacetGroupView, FacetSelection } from './types.js';

function params(init: Record<string, string> = {}): URLSearchParams {
	return new URLSearchParams(init);
}

describe('facet selection', () => {
	it('reads the TMDB vocabulary a movie tab has always used', () => {
		const selection = readSelection(
			params({
				sort_by: 'vote_average.desc',
				with_genres: '28,12',
				with_watch_providers: '8',
				certification: 'PG-13',
				'primary_release_date.gte': '1990-01-01',
				'primary_release_date.lte': '1999-12-31',
				'vote_average.gte': '7',
				with_original_language: 'en',
				with_keywords: '1|2',
				without_keywords: '3'
			}),
			'movie'
		);

		expect(selection.sort).toEqual({ kind: 'scalar', value: 'vote_average.desc' });
		expect(selection.genres).toEqual({ kind: 'ids', ids: ['28', '12'] });
		expect(selection.providers).toEqual({ kind: 'ids', ids: ['8'] });
		expect(selection.certification).toEqual({ kind: 'scalar', value: 'PG-13' });
		expect(selection.year).toEqual({ kind: 'range', min: '1990', max: '1999' });
		expect(selection.rating).toEqual({ kind: 'number', value: '7' });
		expect(selection.language).toEqual({ kind: 'scalar', value: 'en' });
		expect(selection.keywords).toEqual({ kind: 'keywords', include: ['1', '2'], exclude: ['3'] });
	});

	it('writes back exactly the parameters it read', () => {
		const selection: FacetSelection = {
			sort: { kind: 'scalar', value: 'revenue.desc' },
			genres: { kind: 'ids', ids: ['28'] },
			year: { kind: 'range', min: '1990', max: '1999' },
			rating: { kind: 'number', value: '7.5' },
			keywords: { kind: 'keywords', include: ['1'], exclude: [] }
		};
		const url = params({ page: '3' });
		writeSelection(url, selection);

		expect(url.get('page')).toBe('3');
		expect(url.get('sort_by')).toBe('revenue.desc');
		expect(url.get('with_genres')).toBe('28');
		expect(url.get('primary_release_date.gte')).toBe('1990-01-01');
		expect(url.get('primary_release_date.lte')).toBe('1999-12-31');
		expect(url.get('vote_average.gte')).toBe('7.5');
		expect(url.get('with_keywords')).toBe('1');
		expect(url.get('without_keywords')).toBeNull();
	});

	it('drops a rating of zero instead of writing a floor of nothing', () => {
		const url = params({ 'vote_average.gte': '0' });
		writeSelection(url, { rating: { kind: 'number', value: '0' } });
		expect(url.get('vote_average.gte')).toBeNull();
	});

	it('a cleared language writes nothing', () => {
		const url = params({ with_original_language: 'en' });
		writeSelection(url, {});
		expect(url.get('with_original_language')).toBeNull();
		expect(url.toString()).toBe('');
	});

	it('Reset from a URL carrying only the marker is clean', () => {
		const url = params({ with_original_language: 'none' });
		writeSelection(url, {});
		expect(url.toString()).toBe('');
	});

	it('a deliberate override writes the marker and reads as empty', () => {
		const url = params();
		writeSelection(url, {}, new Set(['language']));
		expect(url.get('with_original_language')).toBe('none');
		// The marker is not a selection: the control reads as empty.
		expect(readSelection(url, 'movie').language).toBeUndefined();
		expect(hasActiveFilters(readSelection(url, 'movie'))).toBe(false);
	});

	it('the marker survives an unrelated facet change when passed through', () => {
		const url = params({ with_original_language: 'none' });
		const cleared = readClearedFacets(url, 'movie');
		expect(cleared.has('language')).toBe(true);
		writeSelection(url, { genres: { kind: 'ids', ids: ['28'] } }, cleared);
		expect(url.get('with_original_language')).toBe('none');
		expect(url.get('with_genres')).toBe('28');
	});

	it('a value replaces the marker', () => {
		const url = params({ with_original_language: 'none' });
		writeSelection(url, { language: { kind: 'scalar', value: 'en' } }, new Set(['language']));
		expect(url.get('with_original_language')).toBe('en');
	});

	it('finds no override on a clean URL or on a chosen language', () => {
		expect(readClearedFacets(params(), 'movie').has('language')).toBe(false);
		expect(
			readClearedFacets(params({ with_original_language: 'en' }), 'movie').has('language')
		).toBe(false);
	});

	it('reads the music genre from the legacy parameter and writes the shared one', () => {
		const legacy = readSelection(params({ genre: '132' }), 'music');
		expect(legacy.music_genre).toEqual({ kind: 'ids', ids: ['132'] });

		const url = params({ genre: '132' });
		writeSelection(url, { music_genre: { kind: 'ids', ids: ['132', '116'] } });
		expect(url.get('with_genres')).toBe('132,116');
		expect(url.get('genre')).toBeNull();
	});

	it('does not carry a music genre into a video tab', () => {
		const selection: FacetSelection = {
			music_genre: { kind: 'ids', ids: ['132'] },
			rating: { kind: 'number', value: '7' }
		};
		const pruned = pruneSelection(selection, 'movie');
		expect(pruned.music_genre).toBeUndefined();
		expect(pruned.rating).toEqual({ kind: 'number', value: '7' });

		const url = params({ with_genres: '132', 'vote_average.gte': '7', type: 'movie' });
		writeSelection(url, pruned);
		expect(url.get('with_genres')).toBeNull();
		expect(url.get('vote_average.gte')).toBe('7');
	});

	it('drops facets the target kind does not offer, and keeps the ones it does', () => {
		const selection: FacetSelection = {
			certification: { kind: 'scalar', value: 'PG-13' },
			networks: { kind: 'ids', ids: ['213'] },
			genres: { kind: 'ids', ids: ['18'] }
		};
		expect(pruneSelection(selection, 'tv')).toEqual({
			networks: { kind: 'ids', ids: ['213'] },
			genres: { kind: 'ids', ids: ['18'] }
		});
		expect(pruneSelection(selection, 'movie')).toEqual({
			certification: { kind: 'scalar', value: 'PG-13' },
			genres: { kind: 'ids', ids: ['18'] }
		});
	});

	it('treats sort as a view preference, not an active filter', () => {
		expect(hasActiveFilters({ sort: { kind: 'scalar', value: 'revenue.desc' } })).toBe(false);
		expect(hasActiveFilters({ genres: { kind: 'ids', ids: ['28'] } })).toBe(true);
	});

	it('applies and unwinds a seasonal preset through the same two parameters', () => {
		const url = params({ type: 'movie' });
		writeSelection(url, { seasonal: { kind: 'scalar', value: 'christmas' } });
		expect(url.get('with_original_language')).toBeNull();
		expect(url.get('with_keywords')).toBe('207317|260365|255088');
		expect(url.get('vote_average.gte')).toBe('6');
		expect(readSelection(url, 'movie').seasonal).toEqual({
			kind: 'scalar',
			value: 'christmas'
		});

		writeSelection(url, {});
		expect(url.get('with_keywords')).toBeNull();
		expect(url.get('vote_average.gte')).toBeNull();
	});
});

describe('active filter summary', () => {
	const groups: FacetGroupView[] = [
		{
			id: 'sort',
			label: '',
			facets: [
				{
					id: 'sort',
					label: 'Sort By',
					control: 'single',
					options: [{ id: 'popularity.desc', label: 'Most Popular' }],
					value: { kind: 'scalar', value: 'popularity.desc' }
				}
			]
		},
		{
			id: 'content',
			label: 'Content',
			facets: [
				{
					id: 'genres',
					label: 'Genres',
					control: 'multi',
					options: [],
					badgeKey: 'discover_filterBadgeGenres',
					value: { kind: 'ids', ids: ['28', '12'] }
				},
				{
					id: 'language',
					label: 'Original Language',
					control: 'single',
					options: [{ id: 'en', label: 'English' }],
					value: { kind: 'scalar', value: 'en' }
				},
				{
					id: 'keywords',
					label: 'Keywords',
					control: 'keywords',
					options: [],
					value: null
				}
			]
		},
		{
			id: 'release',
			label: 'Release',
			facets: [
				{
					id: 'year',
					label: 'Release Year',
					control: 'range',
					options: [],
					value: { kind: 'range', min: '1990', max: '' }
				},
				{
					id: 'rating',
					label: 'Min Rating',
					control: 'slider',
					options: [],
					value: { kind: 'number', value: '7' }
				}
			]
		}
	];

	it('summarises every set facet and never the sort order', () => {
		const active = activeFilters(groups);
		expect(active.map((entry) => entry.id)).toEqual(['genres', 'language', 'year', 'rating']);
		expect(active[0]).toMatchObject({ count: 2, badgeKey: 'discover_filterBadgeGenres' });
		expect(active[1].text).toBe('English');
		expect(active[2].text).toBe('1990 – …');
		expect(active[3].text).toBe('7+');
	});
});
