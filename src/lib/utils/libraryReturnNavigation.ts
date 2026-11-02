export type LibrarySection = 'movies' | 'tv';

export interface LibraryNavigationContext {
	section: LibrarySection;
	kind: 'list' | 'detail';
	listPath: '/library/movies' | '/library/tv';
}

const MOVIES_LIST = '/library/movies' as const;
const TV_LIST = '/library/tv' as const;

export function getLibraryNavigationContext(pathname: string): LibraryNavigationContext | null {
	if (pathname === MOVIES_LIST) {
		return { section: 'movies', kind: 'list', listPath: MOVIES_LIST };
	}
	if (/^\/library\/movie\/[^/]+$/.test(pathname)) {
		return { section: 'movies', kind: 'detail', listPath: MOVIES_LIST };
	}
	if (pathname === TV_LIST) {
		return { section: 'tv', kind: 'list', listPath: TV_LIST };
	}
	if (/^\/library\/tv\/[^/]+$/.test(pathname)) {
		return { section: 'tv', kind: 'detail', listPath: TV_LIST };
	}
	return null;
}

function returnToStorageKey(section: LibrarySection): string {
	return `cinephage:library-return-to:${section}`;
}

/**
 * Record the exact filtered list URL as the "back" target for a detail page,
 * for a navigation going from a library list to its matching detail route.
 * Stored in sessionStorage rather than the target URL, so the filtered list
 * state still survives a refresh on the detail page without showing up as a
 * `?returnTo=` query string in the address bar.
 */
export function storeLibraryReturnTo(
	fromPathname: string,
	fromSearch: string,
	target: string
): boolean {
	if (typeof sessionStorage === 'undefined') return false;

	const from = getLibraryNavigationContext(fromPathname);
	if (!from || from.kind !== 'list') return false;

	try {
		const targetUrl = new URL(target, 'http://cinephage.local');
		if (targetUrl.origin !== 'http://cinephage.local') return false;

		const to = getLibraryNavigationContext(targetUrl.pathname);
		if (!to || to.kind !== 'detail' || to.section !== from.section) return false;

		sessionStorage.setItem(returnToStorageKey(from.section), `${fromPathname}${fromSearch}`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Validate a return path before using it for navigation.
 *
 * Only the matching internal library list route is accepted. This keeps the
 * stored return value useful for restoring filters/sort state without it
 * becoming an open-redirect vector.
 */
export function getSafeLibraryReturnTo(
	value: string | null,
	expectedListPath: string
): string | null {
	if (!value || !value.startsWith('/') || value.startsWith('//')) return null;

	try {
		const url = new URL(value, 'http://cinephage.local');
		if (url.origin !== 'http://cinephage.local') return null;
		if (url.pathname !== expectedListPath) return null;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return null;
	}
}

/**
 * The detail-page back-link target, read from sessionStorage instead of the
 * URL. Client-only: sessionStorage doesn't exist during SSR, so this returns
 * null on the server and the header simply renders without a back link
 * until hydration fills in the real value.
 */
export function getLibraryDetailBackHref(
	section: LibrarySection,
	expectedListPath: '/library/movies' | '/library/tv'
): string | null {
	if (typeof sessionStorage === 'undefined') return null;
	return getSafeLibraryReturnTo(
		sessionStorage.getItem(returnToStorageKey(section)),
		expectedListPath
	);
}
