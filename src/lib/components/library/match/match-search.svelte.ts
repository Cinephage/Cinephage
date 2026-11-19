import { toasts } from '#lib/stores/toast.svelte.js';
import { searchTmdb } from '#lib/api/discover.js';

/**
 * One TMDB title search, shared by the four match dialogs.
 *
 * They each carried the same 400 ms debounce, the same Enter escape hatch and
 * the same toast-on-failure, written four times. The parts that genuinely
 * differ — when to pause, which label to show — stay with the dialog through
 * the options.
 */
export interface TmdbMatchResult {
	id: number;
	name?: string;
	title?: string;
	poster_path?: string | null;
	first_air_date?: string | null;
	release_date?: string | null;
	overview?: string;
}

export interface TmdbMatchSearchOptions {
	/** Current search text. */
	query: () => string;
	/** Which TMDB catalogue to search. */
	type: () => 'movie' | 'tv';
	/** Return false to pause automatic searching (e.g. a result is picked). */
	enabled?: () => boolean;
	/** Toast shown when the request fails. */
	failureMessage: () => string;
	debounceMs?: number;
}

export interface TmdbMatchSearch {
	readonly results: TmdbMatchResult[];
	readonly searching: boolean;
	/** Debounced search; returns the cancel function for `$effect` cleanup. */
	schedule(): () => void;
	/** Immediate search (Enter), cancelling any pending debounce. */
	run(): Promise<void>;
	/** Drop results and invalidate any in-flight response. */
	reset(): void;
}

function noop(): void {}

export function createTmdbMatchSearch(options: TmdbMatchSearchOptions): TmdbMatchSearch {
	let results = $state<TmdbMatchResult[]>([]);
	let searching = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Responses can land out of order; only the newest ticket may write state.
	let ticket = 0;

	function cancel(): void {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	}

	function invalidate(): void {
		ticket++;
		searching = false;
	}

	async function run(): Promise<void> {
		cancel();
		const query = options.query().trim();
		if (!query) return;

		const mine = ++ticket;
		searching = true;
		try {
			const data = (await searchTmdb({ query, type: options.type() })) as {
				results?: TmdbMatchResult[];
			};
			if (mine === ticket) results = data.results ?? [];
		} catch {
			if (mine === ticket) {
				toasts.error(options.failureMessage());
				results = [];
			}
		} finally {
			if (mine === ticket) searching = false;
		}
	}

	function schedule(): () => void {
		cancel();
		if (!(options.enabled?.() ?? true)) return noop;
		if (!options.query().trim()) return noop;

		timer = setTimeout(() => void run(), options.debounceMs ?? 400);
		return cancel;
	}

	return {
		get results() {
			return results;
		},
		get searching() {
			return searching;
		},
		schedule,
		run,
		reset() {
			cancel();
			invalidate();
			results = [];
		}
	};
}
