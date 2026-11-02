import { describe, expect, it } from 'vitest';

import { chunkItems, discoverSelectionKey, toDiscoverSelectionEntry } from './discoverSelection.js';
import type { TmdbMediaItem } from '#lib/types/tmdb.js';

const movie = {
	id: 603,
	media_type: 'movie',
	title: 'The Matrix',
	release_date: '1999-03-31',
	poster_path: '/matrix.jpg'
} as unknown as TmdbMediaItem;

const show = {
	id: 1396,
	media_type: 'tv',
	name: 'Breaking Bad',
	first_air_date: '2008-01-20',
	poster_path: '/bb.jpg'
} as unknown as TmdbMediaItem;

const person = { id: 6384, media_type: 'person', name: 'Keanu Reeves' } as unknown as TmdbMediaItem;

describe('discoverSelectionKey', () => {
	it('keys movies and tv shows with their media type', () => {
		expect(discoverSelectionKey(movie)).toBe('movie-603');
		expect(discoverSelectionKey(show)).toBe('tv-1396');
	});

	it('returns null for non-addable items', () => {
		expect(discoverSelectionKey(person)).toBeNull();
	});
});

describe('toDiscoverSelectionEntry', () => {
	it('maps a movie to its add payload', () => {
		expect(toDiscoverSelectionEntry(movie)).toEqual({
			mediaType: 'movie',
			tmdbId: 603,
			title: 'The Matrix',
			year: 1999,
			posterPath: '/matrix.jpg'
		});
	});

	it('maps a tv show using its first air date', () => {
		expect(toDiscoverSelectionEntry(show)).toEqual({
			mediaType: 'tv',
			tmdbId: 1396,
			title: 'Breaking Bad',
			year: 2008,
			posterPath: '/bb.jpg'
		});
	});

	it('ignores missing dates', () => {
		const undated = { ...movie, release_date: undefined } as unknown as TmdbMediaItem;
		expect(toDiscoverSelectionEntry(undated)?.year).toBeUndefined();
	});

	it('returns null for people', () => {
		expect(toDiscoverSelectionEntry(person)).toBeNull();
	});
});

describe('chunkItems', () => {
	it('splits into fixed-size batches', () => {
		expect(chunkItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});

	it('returns a single batch when the list fits', () => {
		expect(chunkItems([1, 2], 50)).toEqual([[1, 2]]);
	});

	it('handles empty lists', () => {
		expect(chunkItems([], 10)).toEqual([]);
	});
});
