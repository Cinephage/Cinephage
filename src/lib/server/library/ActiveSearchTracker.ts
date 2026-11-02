/**
 * Active Search Tracker
 *
 * Tracks searches that are currently running so we can check status
 * across page refreshes. Used by the UI to show "Searching..." state.
 */

interface ActiveSearch {
	seriesId?: string;
	movieId?: string;
	startedAt: number;
	type: 'missing' | 'bulk' | 'single';
	progress: SearchProgress;
}

interface SearchProgress {
	/** Current phase of the search */
	currentPhase: string;
	/** Percentage complete (0-100) */
	percentComplete: number;
	/** Current item being processed */
	currentItem?: string;
	/** Detailed results tracking */
	results: {
		grabbed: number;
		remaining: number;
		failed: number;
	};
}

interface ActiveRefresh {
	seriesId?: string;
	movieId?: string;
	startedAt: number;
}

const SEARCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max search time
const REFRESH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max refresh time
const activeSearches = new Map<string, ActiveSearch>();
const activeRefreshes = new Map<string, ActiveRefresh>();

/**
 * Start tracking a search
 */
export function startSearch(
	id: string,
	options: { seriesId?: string; movieId?: string; type: 'missing' | 'bulk' | 'single' }
): void {
	// Clean up expired searches first
	cleanupExpiredSearches();

	activeSearches.set(id, {
		seriesId: options.seriesId,
		movieId: options.movieId,
		type: options.type,
		startedAt: Date.now(),
		progress: {
			currentPhase: 'initializing',
			percentComplete: 0,
			results: {
				grabbed: 0,
				remaining: 0,
				failed: 0
			}
		}
	});
}

/**
 * Stop tracking a search
 */
export function stopSearch(id: string): void {
	activeSearches.delete(id);
}

/**
 * Check if a series has an active search
 */
export function isSeriesSearching(seriesId: string): boolean {
	cleanupExpiredSearches();

	for (const search of activeSearches.values()) {
		if (search.seriesId === seriesId) {
			return true;
		}
	}
	return false;
}

/**
 * Check if a movie has an active search
 */
export function isMovieSearching(movieId: string): boolean {
	cleanupExpiredSearches();

	for (const search of activeSearches.values()) {
		if (search.movieId === movieId) {
			return true;
		}
	}
	return false;
}

/**
 * Clean up expired searches (older than timeout)
 */
function cleanupExpiredSearches(): void {
	const now = Date.now();
	for (const [id, search] of activeSearches.entries()) {
		if (now - search.startedAt > SEARCH_TIMEOUT_MS) {
			activeSearches.delete(id);
		}
	}
}

/**
 * Update the progress of an active search
 */
export function updateSearchProgress(
	id: string,
	progressUpdate: Partial<SearchProgress> | ((current: SearchProgress) => Partial<SearchProgress>)
): void {
	cleanupExpiredSearches();
	const search = activeSearches.get(id);
	if (!search) return;

	const update =
		typeof progressUpdate === 'function' ? progressUpdate(search.progress) : progressUpdate;

	search.progress = {
		...search.progress,
		...update,
		results: {
			...search.progress.results,
			...(update.results ?? {})
		}
	};
}

/**
 * Start tracking a refresh operation
 */
export function startRefresh(id: string, options: { seriesId?: string; movieId?: string }): void {
	// Clean up expired refreshes first
	cleanupExpiredRefreshes();

	activeRefreshes.set(id, {
		seriesId: options.seriesId,
		movieId: options.movieId,
		startedAt: Date.now()
	});
}

/**
 * Stop tracking a refresh operation
 */
export function stopRefresh(id: string): void {
	activeRefreshes.delete(id);
}

/**
 * Check if a series has an active refresh
 */
export function isSeriesRefreshing(seriesId: string): boolean {
	cleanupExpiredRefreshes();

	for (const refresh of activeRefreshes.values()) {
		if (refresh.seriesId === seriesId) {
			return true;
		}
	}
	return false;
}

/**
 * Check if a movie has an active refresh
 */
export function isMovieRefreshing(movieId: string): boolean {
	cleanupExpiredRefreshes();

	for (const refresh of activeRefreshes.values()) {
		if (refresh.movieId === movieId) {
			return true;
		}
	}
	return false;
}

/**
 * Clean up expired refreshes (older than timeout)
 */
function cleanupExpiredRefreshes(): void {
	const now = Date.now();
	for (const [id, refresh] of activeRefreshes.entries()) {
		if (now - refresh.startedAt > REFRESH_TIMEOUT_MS) {
			activeRefreshes.delete(id);
		}
	}
}
