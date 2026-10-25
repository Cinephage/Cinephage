import { tmdb } from '#lib/server/tmdb.js';
import type { Movie, TVShow, PaginatedResponse } from '#lib/types/tmdb.js';
import { GENRE_MAPPINGS, SEARCH } from '#lib/config/constants.js';
import { hasActiveDiscoverFilters } from '#lib/utils/discoverParams.js';
import { normalizeTmdbLanguage } from '#lib/server/languages/normalize.js';

/**
 * Maps movie genre IDs to TV genre IDs or vice versa.
 * Uses centralized mappings from config/constants.ts.
 */
const MOVIE_TO_TV_GENRES: Record<string, string> = GENRE_MAPPINGS.MOVIE_TO_TV;

/**
 * Maps TV genre IDs to movie genre IDs.
 * Note: Some TV genres map to multiple movie genres (pipe-separated).
 */
const TV_TO_MOVIE_GENRES: Record<string, string> = {
	'10759': '28|12', // Action & Adventure -> Action | Adventure
	'10765': '14|878', // Sci-Fi & Fantasy -> Fantasy | Sci-Fi
	'10768': '10752' // War & Politics -> War
};

function mapGenres(genres: string, targetType: 'movie' | 'tv'): string {
	if (!genres) return '';
	const ids = genres.split(',');
	const mapped = ids.map((id) => {
		if (targetType === 'tv') {
			return MOVIE_TO_TV_GENRES[id] || id;
		} else {
			return TV_TO_MOVIE_GENRES[id] || id;
		}
	});
	return Array.from(new Set(mapped)).join(',');
}

export interface DiscoverParams {
	type: string;
	page: string;
	sortBy: string;
	trending?: string | null;
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
	skipKeywordBlocklist?: boolean;
}

/** Stored values that mean "no origin filter" rather than a language. */
const NO_FILTER_MARKERS = new Set(['any', 'all']);

/**
 * Resolve the effective discover `with_original_language` content-origin filter.
 *
 * Order: explicit URL param (passed through unchanged) →
 * `language_settings.discover_original_filter` validated down to a canonical
 * base tag via `normalizeTmdbLanguage` → null.
 *
 * The response locale (`language_settings.metadata_locale` /
 * `global_filters.language`) is deliberately never consulted: response
 * localization and content-origin filtering are separate concerns
 * (language-system spec §5).
 */
export function resolveWithOriginalLanguage(
	urlParam: string | null | undefined,
	storedFilter: string | null | undefined
): string | null {
	const fromUrl = typeof urlParam === 'string' ? urlParam.trim() : '';
	if (fromUrl && !NO_FILTER_MARKERS.has(fromUrl.toLowerCase())) {
		// Normalize at the boundary too: `en-US` → `en`; junk → null (fall
		// through to the stored filter).
		const normalizedUrl = normalizeTmdbLanguage(fromUrl);
		if (normalizedUrl) return normalizedUrl;
	}

	const stored = typeof storedFilter === 'string' ? storedFilter.trim() : '';
	if (!stored || NO_FILTER_MARKERS.has(stored.toLowerCase())) return null;
	return normalizeTmdbLanguage(stored);
}

/**
 * Build the TMDB discover query string for one endpoint.
 *
 * Media-type-specific params gate here: networks are TV-only, certification
 * is movie-only, and dates/sort use each endpoint's own field names.
 */
export function buildDiscoverQuery(
	endpoint: '/discover/movie' | '/discover/tv',
	params: DiscoverParams,
	page: string
): string {
	const isTv = endpoint.endsWith('/tv');
	const queryParams = new URLSearchParams();
	queryParams.set('page', page);

	// Handle Sort Mapping for TV
	let sort = params.sortBy;
	if (isTv) {
		if (sort === 'primary_release_date.desc') sort = 'first_air_date.desc';
		if (sort === 'primary_release_date.asc') sort = 'first_air_date.asc';
		if (sort === 'revenue.desc') sort = 'popularity.desc'; // TV doesn't have revenue sort
	}
	queryParams.set('sort_by', sort);

	if (params.withWatchProviders) {
		queryParams.set('with_watch_providers', params.withWatchProviders);
		queryParams.set('watch_region', params.watchRegion);
	}

	if (params.withGenres) {
		queryParams.set('with_genres', mapGenres(params.withGenres, isTv ? 'tv' : 'movie'));
	}

	if (params.withKeywords) {
		queryParams.set('with_keywords', params.withKeywords);
	}
	if (params.withoutKeywords) {
		queryParams.set('without_keywords', params.withoutKeywords);
	}

	if (params.withOriginalLanguage) {
		queryParams.set('with_original_language', params.withOriginalLanguage);
	}

	// Networks are a TV concept. Pipe = OR on TMDB (shows airing on ANY
	// selected network); the comma form would demand airing on all at once.
	if (params.withNetworks && isTv) {
		const ids = params.withNetworks.split(',').filter(Boolean);
		if (ids.length > 0) queryParams.set('with_networks', ids.join('|'));
	}

	if (params.minDate) {
		if (isTv) queryParams.set('first_air_date.gte', params.minDate);
		else queryParams.set('primary_release_date.gte', params.minDate);
	}
	if (params.maxDate) {
		if (isTv) queryParams.set('first_air_date.lte', params.maxDate);
		else queryParams.set('primary_release_date.lte', params.maxDate);
	}
	if (params.minRating) {
		queryParams.set('vote_average.gte', params.minRating);
		queryParams.set('vote_count.gte', String(SEARCH.MIN_VOTE_COUNT));
	}

	if (params.certification && !isTv) {
		queryParams.set('certification', params.certification);
	}

	return `${endpoint}?${queryParams.toString()}`;
}

export async function getDiscoverResults(params: DiscoverParams) {
	const {
		type,
		page,
		sortBy,
		trending = null,
		withWatchProviders,
		withGenres,
		withKeywords,
		withoutKeywords,
		withOriginalLanguage,
		minDate,
		maxDate,
		minRating,
		certification,
		withNetworks,
		skipKeywordBlocklist = false
	} = params;

	const fetchMovies = () =>
		tmdb.fetch(
			buildDiscoverQuery('/discover/movie', params, page),
			{},
			false,
			skipKeywordBlocklist
		);
	const fetchTV = () =>
		tmdb.fetch(buildDiscoverQuery('/discover/tv', params, page), {}, false, skipKeywordBlocklist);

	let results: (Movie | TVShow)[];
	let totalPages: number;
	let totalResults: number;

	if (
		(trending === 'day' || trending === 'week') &&
		!hasActiveDiscoverFilters({
			type,
			sortBy,
			withWatchProviders,
			withNetworks,
			withGenres,
			withKeywords,
			withoutKeywords,
			withOriginalLanguage,
			minDate,
			maxDate,
			minRating,
			certification
		})
	) {
		const trendingEndpoint = `/trending/all/${trending}`;
		const url = `${trendingEndpoint}?page=${encodeURIComponent(page)}`;
		const data = (await tmdb.fetch(url)) as PaginatedResponse<Movie | TVShow>;
		results = data.results;
		totalPages = data.total_pages;
		totalResults = data.total_results;
	} else if (type === 'tv' && certification) {
		results = [];
		totalPages = 0;
		totalResults = 0;
	} else if (type === 'tv' || withNetworks) {
		// Networks are a TV-only filter: an active network filter narrows an
		// 'all' or 'movie' view down to the TV endpoint.
		const data = (await fetchTV()) as PaginatedResponse<TVShow>;
		results = data.results.map((t) => ({ ...t, media_type: 'tv' }));
		totalPages = data.total_pages;
		totalResults = data.total_results;
	} else if (type === 'movie' || certification) {
		const data = (await fetchMovies()) as PaginatedResponse<Movie>;
		results = data.results.map((m) => ({ ...m, media_type: 'movie' }));
		totalPages = data.total_pages;
		totalResults = data.total_results;
	} else {
		const [movies, tv] = await Promise.all([
			fetchMovies() as Promise<PaginatedResponse<Movie>>,
			fetchTV() as Promise<PaginatedResponse<TVShow>>
		]);

		const movieResults = movies.results.map((m) => ({ ...m, media_type: 'movie' }) as Movie);
		const tvResults = tv.results.map((t) => ({ ...t, media_type: 'tv' }) as TVShow);

		results = [...movieResults, ...tvResults];

		// Sort combined results
		if (sortBy.includes('popularity')) {
			results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
		} else if (sortBy.includes('vote_average')) {
			results.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
		} else if (sortBy.includes('primary_release_date')) {
			results.sort((a, b) => {
				const dateA = new Date(
					(a as Movie).release_date || (a as TVShow).first_air_date || 0
				).getTime();
				const dateB = new Date(
					(b as Movie).release_date || (b as TVShow).first_air_date || 0
				).getTime();
				return sortBy.includes('desc') ? dateB - dateA : dateA - dateB;
			});
		} else {
			// Default fallback
			results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
		}

		totalPages = Math.max(movies.total_pages, tv.total_pages);
		totalResults = movies.total_results + tv.total_results;
	}

	return {
		results,
		pagination: {
			page: parseInt(page),
			total_pages: totalPages,
			total_results: totalResults
		}
	};
}
