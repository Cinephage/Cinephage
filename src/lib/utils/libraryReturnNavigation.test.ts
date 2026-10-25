// @vitest-environment jsdom
// storeLibraryReturnTo/getLibraryDetailBackHref use sessionStorage, which
// only exists in a browser-like environment; this file's project default
// is plain node.
import { describe, expect, it, beforeEach } from 'vitest';

import {
	getLibraryDetailBackHref,
	getLibraryNavigationContext,
	getSafeLibraryReturnTo,
	storeLibraryReturnTo
} from './libraryReturnNavigation';

beforeEach(() => {
	sessionStorage.clear();
});

describe('library return navigation', () => {
	it('recognizes Movies and TV list/detail routes independently', () => {
		expect(getLibraryNavigationContext('/library/movies')).toEqual({
			section: 'movies',
			kind: 'list',
			listPath: '/library/movies'
		});
		expect(getLibraryNavigationContext('/library/movie/movie-id')).toEqual({
			section: 'movies',
			kind: 'detail',
			listPath: '/library/movies'
		});
		expect(getLibraryNavigationContext('/library/tv')).toEqual({
			section: 'tv',
			kind: 'list',
			listPath: '/library/tv'
		});
		expect(getLibraryNavigationContext('/library/tv/series-id')).toEqual({
			section: 'tv',
			kind: 'detail',
			listPath: '/library/tv'
		});
	});
});

describe('storeLibraryReturnTo + getLibraryDetailBackHref', () => {
	it('records the exact filtered TV list URL and makes it available as a back href', () => {
		const stored = storeLibraryReturnTo(
			'/library/tv',
			'?library=anime&status=continuing&progress=missing&sort=year-desc&q=voyager',
			'/library/tv/series-id'
		);

		expect(stored).toBe(true);
		expect(getLibraryDetailBackHref('tv', '/library/tv')).toBe(
			'/library/tv?library=anime&status=continuing&progress=missing&sort=year-desc&q=voyager'
		);
	});

	it('records the exact filtered Movies list URL and makes it available as a back href', () => {
		storeLibraryReturnTo(
			'/library/movies',
			'?library=anime&fileStatus=missingFile&resolution=2160p&sort=added-desc&q=alien',
			'/library/movie/movie-id'
		);

		expect(getLibraryDetailBackHref('movies', '/library/movies')).toBe(
			'/library/movies?library=anime&fileStatus=missingFile&resolution=2160p&sort=added-desc&q=alien'
		);
	});

	it('never puts returnTo in the URL — nothing to inspect on the target itself', () => {
		// storeLibraryReturnTo returns a boolean, not a rewritten URL; the
		// navigation target passed in is never touched.
		const target = '/library/tv/series-id';
		storeLibraryReturnTo('/library/tv', '?status=ended', target);
		expect(target).toBe('/library/tv/series-id');
	});

	it('does not cross Movies and TV navigation', () => {
		const stored = storeLibraryReturnTo(
			'/library/movies',
			'?fileStatus=missingFile',
			'/library/tv/series-id'
		);
		expect(stored).toBe(false);
		expect(getLibraryDetailBackHref('tv', '/library/tv')).toBeNull();
	});

	it('rejects non-library and external targets', () => {
		expect(storeLibraryReturnTo('/library/tv', '?status=ended', '/settings/system/general')).toBe(
			false
		);
		expect(
			storeLibraryReturnTo(
				'/library/tv',
				'?status=ended',
				'https://example.com/library/tv/series-id'
			)
		).toBe(false);
	});

	it('does not record anything when navigating from a non-list route', () => {
		expect(storeLibraryReturnTo('/library/movie/other-id', '', '/library/movie/movie-id')).toBe(
			false
		);
	});

	it('is scoped per section — recording one does not affect the other', () => {
		storeLibraryReturnTo('/library/movies', '?monitored=true', '/library/movie/movie-id');
		expect(getLibraryDetailBackHref('movies', '/library/movies')).toBe(
			'/library/movies?monitored=true'
		);
		expect(getLibraryDetailBackHref('tv', '/library/tv')).toBeNull();
	});

	it('returns null when nothing has been recorded yet', () => {
		expect(getLibraryDetailBackHref('movies', '/library/movies')).toBeNull();
	});
});

describe('getSafeLibraryReturnTo', () => {
	it('restores the exact filtered movie list URL', () => {
		expect(
			getSafeLibraryReturnTo(
				'/library/movies?monitored=unmonitored&hdrFormat=dolby-vision&sort=year-desc&q=matrix',
				'/library/movies'
			)
		).toBe('/library/movies?monitored=unmonitored&hdrFormat=dolby-vision&sort=year-desc&q=matrix');
	});

	it('restores the exact filtered TV list URL', () => {
		expect(
			getSafeLibraryReturnTo(
				'/library/tv?status=ended&resolution=1080p&sort=size-desc&q=voyager',
				'/library/tv'
			)
		).toBe('/library/tv?status=ended&resolution=1080p&sort=size-desc&q=voyager');
	});

	it('does not use a movie return path for the TV list', () => {
		expect(
			getSafeLibraryReturnTo('/library/movies?fileStatus=missingFile', '/library/tv')
		).toBeNull();
	});

	it('rejects external and protocol-relative return paths', () => {
		expect(
			getSafeLibraryReturnTo('https://example.com/library/movies', '/library/movies')
		).toBeNull();
		expect(getSafeLibraryReturnTo('//example.com/library/movies', '/library/movies')).toBeNull();
	});

	it('rejects missing and malformed values', () => {
		expect(getSafeLibraryReturnTo(null, '/library/movies')).toBeNull();
		expect(getSafeLibraryReturnTo('', '/library/movies')).toBeNull();
		expect(getSafeLibraryReturnTo('not-a-path', '/library/movies')).toBeNull();
	});
});
