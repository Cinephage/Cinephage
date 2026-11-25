import { searchTmdb } from '#lib/api/discover.js';

/**
 * The Discover page's title search.
 *
 * Typing is debounced into one request per burst, a newer search aborts the
 * one still in flight, and only the newest search may write results: TMDB
 * answers can land out of order, and an answer for "the l" must never replace
 * the one for "the lord".
 */
export type DiscoverSearchResult = Record<string, unknown> & { id: number; media_type?: string };

export interface DiscoverSearchPagination {
	page: number;
	total_pages: number;
	total_results: number;
}

export interface DiscoverSearchOptions {
	/** TMDB catalogue filter (`all`, `movie`, `tv`, ...). */
	type: () => string;
	/** Hide titles already in the library. */
	excludeInLibrary: () => boolean;
	/** Called once per search that settles with a query; keeps `?q` in the URL. */
	onQuery?: (query: string) => void;
	/** Called when the newest search fails (aborted searches never report). */
	onError?: (error: unknown) => void;
	debounceMs?: number;
}

export interface DiscoverSearch {
	/** Text in the search box. */
	query: string;
	readonly results: DiscoverSearchResult[];
	readonly pagination: DiscoverSearchPagination | null;
	readonly searching: boolean;
	/** The box changed: update the text, search after the debounce. */
	input(text: string): void;
	/** Search the current text now (Enter, filter change), dropping any pending debounce. */
	run(): Promise<void>;
	/** Empty the box and the results, cancelling anything pending or in flight. */
	clear(): void;
	/** Append the next page of the current search. */
	loadMore(): Promise<void>;
	/** Cancel the pending debounce and in-flight request (component teardown). */
	dispose(): void;
}

export const DISCOVER_SEARCH_DEBOUNCE_MS = 300;

function resultKey(r: DiscoverSearchResult): string {
	return r.id + (r.media_type || '');
}

function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

export function createDiscoverSearch(
	initialQuery: string,
	options: DiscoverSearchOptions
): DiscoverSearch {
	let query = $state(initialQuery);
	let results = $state<DiscoverSearchResult[]>([]);
	let pagination = $state<DiscoverSearchPagination | null>(null);
	let searching = $state(false);

	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;
	// Bumped by every search, clear and dispose; a response may only write
	// state while its ticket is still the newest one.
	let ticket = 0;

	function cancelTimer(): void {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	}

	/** Invalidate whatever is in flight and hand out the next ticket. */
	function supersede(): { mine: number; signal: AbortSignal } {
		controller?.abort();
		controller = new AbortController();
		return { mine: ++ticket, signal: controller.signal };
	}

	function params(text: string, page?: number): Record<string, string> {
		return {
			query: text,
			type: options.type(),
			...(page ? { page: String(page) } : {}),
			...(options.excludeInLibrary() ? { exclude_in_library: 'true' } : {})
		};
	}

	async function run(): Promise<void> {
		cancelTimer();
		const text = query.trim();
		options.onQuery?.(text);

		if (!text) {
			supersede();
			results = [];
			pagination = null;
			searching = false;
			return;
		}

		const { mine, signal } = supersede();
		searching = true;
		try {
			const data = await searchTmdb(params(text), { signal });
			if (mine !== ticket) return;
			results = (data.results ?? []) as DiscoverSearchResult[];
			pagination = data.pagination ?? null;
		} catch (error) {
			if (mine !== ticket || isAbort(error)) return;
			results = [];
			options.onError?.(error);
		} finally {
			if (mine === ticket) searching = false;
		}
	}

	async function loadMore(): Promise<void> {
		const current = pagination;
		if (!current || current.page >= current.total_pages || searching) return;
		const text = query.trim();
		if (!text) return;

		const { mine, signal } = supersede();
		searching = true;
		try {
			const data = await searchTmdb(params(text, current.page + 1), { signal });
			if (mine !== ticket) return;
			const seen = results.map(resultKey);
			const fresh = ((data.results ?? []) as DiscoverSearchResult[]).filter(
				(r) => !seen.includes(resultKey(r))
			);
			results = [...results, ...fresh];
			pagination = data.pagination ?? current;
		} catch (error) {
			if (mine !== ticket || isAbort(error)) return;
			options.onError?.(error);
		} finally {
			if (mine === ticket) searching = false;
		}
	}

	function dispose(): void {
		cancelTimer();
		controller?.abort();
		ticket++;
		searching = false;
	}

	return {
		get query() {
			return query;
		},
		set query(text: string) {
			query = text;
		},
		get results() {
			return results;
		},
		get pagination() {
			return pagination;
		},
		get searching() {
			return searching;
		},
		input(text: string) {
			query = text;
			cancelTimer();
			timer = setTimeout(() => void run(), options.debounceMs ?? DISCOVER_SEARCH_DEBOUNCE_MS);
		},
		run,
		clear() {
			query = '';
			void run();
		},
		loadMore,
		dispose
	};
}
