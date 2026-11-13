import { describe, it, expect } from 'vitest';
import { buildCapabilitiesFromYaml } from './capabilities';

describe('buildCapabilitiesFromYaml', () => {
	it('should default to basic search with q param when no modes provided', () => {
		const caps = buildCapabilitiesFromYaml({ modes: {} });

		expect(caps.search.available).toBe(true);
		expect(caps.search.supportedParams).toEqual(['q']);
		expect(caps.movieSearch).toBeUndefined();
		expect(caps.tvSearch).toBeUndefined();
	});

	it('should build movieSearch mode when movie-search is defined', () => {
		const caps = buildCapabilitiesFromYaml({
			modes: { 'movie-search': ['q', 'imdbid', 'tmdbid'] }
		});

		expect(caps.movieSearch).toBeDefined();
		expect(caps.movieSearch!.available).toBe(true);
		expect(caps.movieSearch!.supportedParams).toEqual(['q', 'imdbId', 'tmdbId']);
	});

	it('should build tvSearch mode when tv-search is defined', () => {
		const caps = buildCapabilitiesFromYaml({
			modes: { 'tv-search': ['q', 'tvdbid', 'season', 'ep'] }
		});

		expect(caps.tvSearch).toBeDefined();
		expect(caps.tvSearch!.available).toBe(true);
		expect(caps.tvSearch!.supportedParams).toEqual(['q', 'tvdbId', 'season', 'ep']);
	});

	it('should build musicSearch mode with music-specific params', () => {
		const caps = buildCapabilitiesFromYaml({
			modes: { 'music-search': ['q', 'artist', 'album'] }
		});

		expect(caps.musicSearch).toBeDefined();
		expect(caps.musicSearch!.available).toBe(true);
		expect(caps.musicSearch!.supportedParams).toEqual(['q', 'artist', 'album']);
	});

	it('should build bookSearch mode with book-specific params', () => {
		const caps = buildCapabilitiesFromYaml({
			modes: { 'book-search': ['q', 'author', 'title'] }
		});

		expect(caps.bookSearch).toBeDefined();
		expect(caps.bookSearch!.available).toBe(true);
		expect(caps.bookSearch!.supportedParams).toEqual(['q', 'author', 'title']);
	});

	it('should handle multiple modes simultaneously', () => {
		const caps = buildCapabilitiesFromYaml({
			modes: {
				search: ['q'],
				'movie-search': ['q', 'imdbid'],
				'tv-search': ['q', 'season', 'ep']
			}
		});

		expect(caps.search.available).toBe(true);
		expect(caps.movieSearch).toBeDefined();
		expect(caps.tvSearch).toBeDefined();
		expect(caps.musicSearch).toBeUndefined();
	});

	it('should map unrecognized param strings to q', () => {
		const caps = buildCapabilitiesFromYaml({
			modes: { search: ['q', 'unknown_param', 'another_unknown'] }
		});

		expect(caps.search.supportedParams).toEqual(['q', 'q', 'q']);
	});

	it('should parse categories from string key/value records', () => {
		const caps = buildCapabilitiesFromYaml({
			modes: {},
			categories: { '2000': 'Movies', '5000': 'TV' }
		});

		expect(caps.categories.size).toBe(2);
		expect(caps.categories.get(2000)).toBe('Movies');
		expect(caps.categories.get(5000)).toBe('TV');
	});

	it('should skip non-numeric category keys', () => {
		const caps = buildCapabilitiesFromYaml({
			modes: {},
			categories: { '2000': 'Movies', abc: 'Invalid', '5000': 'TV' }
		});

		expect(caps.categories.size).toBe(2);
		expect(caps.categories.get(2000)).toBe('Movies');
		expect(caps.categories.get(5000)).toBe('TV');
	});

	it('should parse categorymappings entries', () => {
		const caps = buildCapabilitiesFromYaml({
			modes: {},
			categorymappings: [
				{ cat: 'Movies/HD', desc: 'Movies HD' },
				{ cat: '5000', desc: 'TV All' }
			]
		});

		expect(caps.categories.size).toBe(2);
	});

	it('should merge categories and categorymappings', () => {
		const caps = buildCapabilitiesFromYaml({
			modes: {},
			categories: { '2000': 'Movies' },
			categorymappings: [{ cat: '5000', desc: 'TV' }]
		});

		expect(caps.categories.size).toBe(2);
	});

	it('should default supportsInfoHash to true', () => {
		const caps = buildCapabilitiesFromYaml({ modes: {} });

		expect(caps.supportsInfoHash).toBe(true);
	});

	it('should accept explicit supportsInfoHash false', () => {
		const caps = buildCapabilitiesFromYaml({ modes: {}, supportsInfoHash: false });

		expect(caps.supportsInfoHash).toBe(false);
	});

	it('should set supportsPagination, limitMax, and limitDefault to fixed values', () => {
		const caps = buildCapabilitiesFromYaml({ modes: {} });

		expect(caps.supportsPagination).toBe(false);
		expect(caps.limitMax).toBe(100);
		expect(caps.limitDefault).toBe(100);
	});

	it('should set movieSearch with empty supportedParams when movie-search is empty array', () => {
		const caps = buildCapabilitiesFromYaml({
			modes: { 'movie-search': [] }
		});

		expect(caps.movieSearch).toBeDefined();
		expect(caps.movieSearch!.available).toBe(false);
		expect(caps.movieSearch!.supportedParams).toEqual([]);
	});

	it('should handle case-insensitive param names', () => {
		const caps = buildCapabilitiesFromYaml({
			modes: { search: ['Q', 'IMDBID', 'TvDbId'] }
		});

		expect(caps.search.supportedParams).toEqual(['q', 'imdbId', 'tvdbId']);
	});

	it('should carry searchFormats from the definition', () => {
		// Without this the YAML key is a no-op and the orchestrator keeps trying
		// an Sxx/Eyy variant the tracker can never match.
		const caps = buildCapabilitiesFromYaml({
			modes: { 'tv-search': ['q', 'season', 'ep'] },
			searchFormats: { episode: [] }
		});

		expect(caps.searchFormats).toEqual({ episode: [], movie: undefined });
	});

	it('should leave searchFormats undefined when the definition declares none', () => {
		const caps = buildCapabilitiesFromYaml({ modes: {} });

		expect(caps.searchFormats).toBeUndefined();
	});
});
