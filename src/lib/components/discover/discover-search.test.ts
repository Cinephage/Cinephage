// @vitest-environment jsdom
/**
 * The Discover search box: one request per typing burst, Enter searches at
 * once, and an older answer that lands late never replaces a newer one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	createDiscoverSearch,
	DISCOVER_SEARCH_DEBOUNCE_MS,
	type DiscoverSearchResult
} from './discover-search.svelte.js';

const searchTmdbMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/api/discover.js', () => ({ searchTmdb: searchTmdbMock }));

interface Deferred {
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	signal: AbortSignal;
	query: string;
}

/** Make every searchTmdb call hang until the test settles it by hand. */
function holdRequests(): Deferred[] {
	const calls: Deferred[] = [];
	searchTmdbMock.mockImplementation(
		(params: Record<string, string>, options: { signal: AbortSignal }) =>
			new Promise((resolve, reject) => {
				calls.push({ resolve, reject, signal: options.signal, query: params.query });
			})
	);
	return calls;
}

function answer(title: string, page = 1, total_pages = 1) {
	const results: DiscoverSearchResult[] = [{ id: title.length, media_type: 'movie', title }];
	return { results, pagination: { page, total_pages, total_results: results.length } };
}

function makeSearch(initial = '', onQuery = vi.fn(), onError = vi.fn()) {
	return createDiscoverSearch(initial, {
		type: () => 'all',
		excludeInLibrary: () => false,
		onQuery,
		onError
	});
}

beforeEach(() => {
	searchTmdbMock.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('createDiscoverSearch', () => {
	it('sends one request with the final text for rapid typing', async () => {
		vi.useFakeTimers();
		searchTmdbMock.mockResolvedValue(answer('The Lord of the Rings'));
		const onQuery = vi.fn();
		const search = makeSearch('', onQuery);

		const text = 'the lord of the rings';
		for (let i = 1; i <= text.length; i++) {
			search.input(text.slice(0, i));
			await vi.advanceTimersByTimeAsync(120);
		}
		expect(searchTmdbMock).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(DISCOVER_SEARCH_DEBOUNCE_MS);
		expect(searchTmdbMock).toHaveBeenCalledTimes(1);
		expect(searchTmdbMock.mock.calls[0][0]).toEqual({ query: text, type: 'all' });
		// The URL is written once, for the settled query, not per keystroke.
		expect(onQuery).toHaveBeenCalledTimes(1);
		expect(onQuery).toHaveBeenCalledWith(text);
		expect(search.results[0].title).toBe('The Lord of the Rings');
	});

	it('never lets an older answer that lands late overwrite a newer one', async () => {
		const calls = holdRequests();
		const search = makeSearch();

		search.query = 'the l';
		void search.run();
		search.query = 'the lo';
		const newer = search.run();

		expect(calls.map((c) => c.query)).toEqual(['the l', 'the lo']);
		expect(calls[0].signal.aborted).toBe(true);
		expect(calls[1].signal.aborted).toBe(false);

		calls[1].resolve(answer('newer'));
		await newer;
		expect(search.results[0].title).toBe('newer');
		expect(search.searching).toBe(false);

		// The stale "the l" answer arrives afterwards (e.g. the server ignored the abort).
		calls[0].resolve(answer('older'));
		await Promise.resolve();
		await Promise.resolve();
		expect(search.results[0].title).toBe('newer');
		expect(search.pagination?.total_results).toBe(1);
	});

	it('does not report an error for an aborted request', async () => {
		const calls = holdRequests();
		const onError = vi.fn();
		const search = makeSearch('', vi.fn(), onError);

		search.query = 'alien';
		const first = search.run();
		search.query = 'aliens';
		const second = search.run();
		calls[0].reject(new DOMException('aborted', 'AbortError'));
		calls[1].resolve(answer('Aliens'));
		await Promise.all([first, second]);

		expect(onError).not.toHaveBeenCalled();
		expect(search.results[0].title).toBe('Aliens');
	});

	it('searches at once on run (Enter), dropping the pending debounce', async () => {
		vi.useFakeTimers();
		searchTmdbMock.mockResolvedValue(answer('Dune'));
		const search = makeSearch();

		search.input('dune');
		await search.run();
		expect(searchTmdbMock).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(DISCOVER_SEARCH_DEBOUNCE_MS * 2);
		expect(searchTmdbMock).toHaveBeenCalledTimes(1);
	});

	it('clear resets results and keeps an in-flight answer from coming back', async () => {
		const calls = holdRequests();
		const onQuery = vi.fn();
		const search = makeSearch('', onQuery);

		search.query = 'alien';
		const pending = search.run();
		search.clear();

		expect(calls[0].signal.aborted).toBe(true);
		expect(onQuery).toHaveBeenLastCalledWith('');
		calls[0].resolve(answer('Alien'));
		await pending;

		expect(search.query).toBe('');
		expect(search.results).toEqual([]);
		expect(search.pagination).toBeNull();
		expect(search.searching).toBe(false);
	});

	it('drops a load-more page that belongs to an older query', async () => {
		const calls = holdRequests();
		const search = makeSearch();

		search.query = 'star';
		const first = search.run();
		calls[0].resolve(answer('Star', 1, 3));
		await first;

		const more = search.loadMore();
		expect(calls[1].query).toBe('star');
		search.query = 'star trek';
		const next = search.run();
		calls[2].resolve(answer('Star Trek'));
		await next;
		calls[1].resolve(answer('Star page two', 2, 3));
		await more;

		expect(search.results.map((r) => r.title)).toEqual(['Star Trek']);
	});
});
