import { describe, expect, it } from 'vitest';
import { joinCategoryPath, sanitizeCategorySegment } from './client-utils.js';

describe('joinCategoryPath', () => {
	it('joins base and category', () => {
		expect(joinCategoryPath('/downloads', 'movies')).toBe('/downloads/movies');
	});

	it('trims whitespace and trailing slashes', () => {
		expect(joinCategoryPath('/downloads///', '  tv  ')).toBe('/downloads/tv');
	});

	it('returns empty for blank base or category', () => {
		expect(joinCategoryPath('', 'movies')).toBe('');
		expect(joinCategoryPath('/downloads', '')).toBe('');
		expect(joinCategoryPath('/downloads', '   ')).toBe('');
	});

	it('strips a path-traversal category down to a single safe segment', () => {
		expect(joinCategoryPath('/downloads', '../../etc')).toBe('/downloads/....etc');
		expect(joinCategoryPath('/downloads', 'movies/../../etc')).toBe('/downloads/movies....etc');
		expect(joinCategoryPath('/downloads', 'a/b')).toBe('/downloads/ab');
	});

	it('returns empty when the category sanitizes to a traversal segment or nothing', () => {
		expect(joinCategoryPath('/downloads', '..')).toBe('');
		expect(joinCategoryPath('/downloads', '.')).toBe('');
		expect(joinCategoryPath('/downloads', '/')).toBe('');
		expect(joinCategoryPath('/downloads', '\\')).toBe('');
	});
});

describe('sanitizeCategorySegment', () => {
	it('passes through a plain category unchanged', () => {
		expect(sanitizeCategorySegment('movies')).toBe('movies');
		expect(sanitizeCategorySegment('tv-sonarr')).toBe('tv-sonarr');
	});

	it('strips slashes and backslashes, collapsing to one path segment', () => {
		expect(sanitizeCategorySegment('movies/anime')).toBe('moviesanime');
		expect(sanitizeCategorySegment('movies\\anime')).toBe('moviesanime');
	});

	it('rejects "." and ".." outright, even after stripping unsafe chars', () => {
		expect(sanitizeCategorySegment('.')).toBe('');
		expect(sanitizeCategorySegment('..')).toBe('');
		expect(sanitizeCategorySegment('../')).toBe('');
		expect(sanitizeCategorySegment('..\\')).toBe('');
	});

	it('strips shell/command metacharacters', () => {
		expect(sanitizeCategorySegment('movies;rm -rf /')).toBe('moviesrm -rf ');
		expect(sanitizeCategorySegment('movies,tv')).toBe('moviestv');
		expect(sanitizeCategorySegment('movies"quoted"')).toBe('moviesquoted');
	});
});
