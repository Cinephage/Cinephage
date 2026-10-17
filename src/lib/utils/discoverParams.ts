/**
 * Shared URL parameter parsing for discover page.
 * Used by both server and client to ensure consistency.
 */

export interface DiscoverParams {
	type: string;
	page: string;
	sortBy: string;
	trending: string | null;
	topRated: string | null;
	withWatchProviders: string;
	watchRegion: string;
	withNetworks: string;
	withGenres: string;
	withKeywords: string;
	withoutKeywords: string;
	withOriginalLanguage: string | null;
	minDate: string | null;
	maxDate: string | null;
	minRating: string | null;
	certification: string | null;
	excludeInLibrary: boolean;
	nowPlaying: string | null;
}

/**
 * Parse discover URL search params into a typed object.
 */
export function parseDiscoverParams(searchParams: URLSearchParams): DiscoverParams {
	return {
		type: searchParams.get('type') || 'all',
		page: searchParams.get('page') || '1',
		sortBy: searchParams.get('sort_by') || 'popularity.desc',
		trending: searchParams.get('trending'),
		topRated: searchParams.get('top_rated'),
		withWatchProviders: searchParams.get('with_watch_providers') || '',
		watchRegion: searchParams.get('watch_region') || '',
		withNetworks: searchParams.get('with_networks') || '',
		withGenres: searchParams.get('with_genres') || '',
		withKeywords: searchParams.get('with_keywords') || '',
		withoutKeywords: searchParams.get('without_keywords') || '',
		withOriginalLanguage: searchParams.get('with_original_language') || null,
		minDate: searchParams.get('primary_release_date.gte') || null,
		maxDate: searchParams.get('primary_release_date.lte') || null,
		minRating: searchParams.get('vote_average.gte') || null,
		certification: searchParams.get('certification') || null,
		excludeInLibrary: searchParams.get('exclude_in_library') === 'true',
		nowPlaying: searchParams.get('now_playing')
	};
}

/**
 * Check if the current params represent the default view (dashboard).
 */
export function isDefaultView(searchParams: URLSearchParams, params: DiscoverParams): boolean {
	return (
		!searchParams.has('trending') &&
		!searchParams.has('top_rated') &&
		!searchParams.has('now_playing') &&
		(!searchParams.has('type') || searchParams.get('type') === 'all') &&
		!searchParams.has('with_watch_providers') &&
		!searchParams.has('with_networks') &&
		!searchParams.has('with_genres') &&
		!searchParams.has('with_keywords') &&
		!searchParams.has('without_keywords') &&
		!searchParams.has('with_original_language') &&
		!searchParams.has('primary_release_date.gte') &&
		!searchParams.has('primary_release_date.lte') &&
		!searchParams.has('vote_average.gte') &&
		!searchParams.has('certification') &&
		(!searchParams.has('page') || searchParams.get('page') === '1') &&
		params.sortBy === 'popularity.desc'
	);
}

export function hasActiveDiscoverFilters(
	params: Pick<
		DiscoverParams,
		| 'type'
		| 'sortBy'
		| 'withWatchProviders'
		| 'withNetworks'
		| 'withGenres'
		| 'withKeywords'
		| 'withoutKeywords'
		| 'withOriginalLanguage'
		| 'minDate'
		| 'maxDate'
		| 'minRating'
		| 'certification'
	>
): boolean {
	return (
		params.type !== 'all' ||
		params.sortBy !== 'popularity.desc' ||
		!!params.withWatchProviders ||
		!!params.withNetworks ||
		!!params.withGenres ||
		!!params.withKeywords ||
		!!params.withoutKeywords ||
		!!params.withOriginalLanguage ||
		!!params.minDate ||
		!!params.maxDate ||
		Number(params.minRating ?? 0) > 0 ||
		!!params.certification
	);
}

/**
 * Parse provider IDs from comma-separated string.
 */
export function parseProviderIds(value: string | null): number[] {
	if (!value) return [];
	return value
		.split(',')
		.filter(Boolean)
		.map(Number)
		.filter((n) => !isNaN(n));
}

/**
 * Parse genre IDs from comma-separated string.
 */
export function parseGenreIds(value: string | null): number[] {
	return parseProviderIds(value); // Same logic
}

export function parseKeywordIds(value: string | null): number[] {
	return parseProviderIds(value);
}

/**
 * Extract year from date string (YYYY-MM-DD or YYYY).
 */
export function extractYear(dateString: string | null): string {
	if (!dateString) return '';
	return dateString.split('-')[0];
}
