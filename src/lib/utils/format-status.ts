import * as m from '#lib/paraglide/messages.js';

export function formatSeriesStatus(status: string | null): string {
	if (!status) return m.common_unknown();
	const s = status.toLowerCase();
	if (s.includes('returning')) return m.library_libraryMediaTable_continuing();
	if (s.includes('production')) return m.library_libraryMediaTable_inProduction();
	if (s.includes('ended')) return m.library_libraryMediaTable_ended();
	if (s.includes('canceled') || s.includes('cancelled')) {
		return m.library_libraryMediaTable_cancelled();
	}
	return status;
}

/**
 * Match a stored series status against a library filter key.
 *
 * TMDB stores cancelled shows as "Cancelled" (double-L) while other providers
 * (e.g. AniList) use "Canceled" (single-L), so cancelled matches must accept
 * both spellings.
 */
export function matchesSeriesStatusFilter(status: string | null, filterKey: string): boolean {
	const s = status?.toLowerCase();
	if (!s) return false;

	switch (filterKey) {
		case 'continuing':
			return s === 'returning series' || s === 'in production';
		case 'ended':
			return s === 'ended' || s === 'canceled';
		case 'cancelled':
			return s === 'cancelled' || s === 'canceled';
		default:
			return true;
	}
}

/**
 * Status filter options for the TV library drawer. Kept in one place with the
 * filter predicate so the option list and matching logic stay in sync.
 */
export function seriesStatusFilterOptions(): { value: string; label: string }[] {
	return [
		{ value: 'all', label: m.library_tv_filterAll() },
		{ value: 'continuing', label: m.library_tv_filterContinuing() },
		{ value: 'ended', label: m.library_tv_filterEnded() },
		{ value: 'cancelled', label: m.library_tv_filterCancelled() }
	];
}
