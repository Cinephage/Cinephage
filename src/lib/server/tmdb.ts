import { db } from './db';
import { languageSettings, settings } from './db/schema';
import { eq } from 'drizzle-orm';
import { normalizeMetadataLocale, normalizeRegionCode } from '#lib/server/languages/normalize.js';
import { decryptSettingValue } from '#lib/server/settings/secretSettings.js';
import type {
	GlobalTmdbFilters,
	MovieDetails,
	TVShowDetails,
	Season,
	EpisodeGroup,
	EpisodeGroupsResponse,
	Collection,
	PersonDetails,
	PersonCombinedCredits,
	ReleaseDatesResponse,
	TmdbNetwork
} from '#lib/types/tmdb.js';
import { DISCOVER_NETWORKS, TMDB } from '#lib/config/constants.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
import { tmdbCache, getCacheKey } from './tmdb-cache';
import { getBlockedTmdbIdSet } from './library/status.js';

async function filterBlockedResults(data: unknown): Promise<unknown> {
	if (data && typeof data === 'object' && 'results' in data && Array.isArray(data.results)) {
		const blockedIds = await getBlockedTmdbIdSet('all');
		if (blockedIds.size > 0) {
			return {
				...data,
				results: data.results.filter((item: { id: number }) => !blockedIds.has(item.id))
			};
		}
	}
	return data;
}

// In-flight request deduplication - prevents concurrent requests for the same endpoint
const inFlightRequests = new Map<string, Promise<unknown>>();

// Cached TMDB settings to avoid DB reads on every API call.
// These settings change very rarely (admin-only operations).
const SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _cachedApiKey: string | null = null;
let _cachedFilters: Partial<GlobalTmdbFilters> | null = null;
let _settingsCacheTimestamp = 0;
let _settingsCachePromise: Promise<void> | null = null;

// Row id of the language_settings singleton. Kept as a literal (instead of
// importing LanguageSettingsService) to avoid import cycles — tmdb.ts sits
// below most services in the dependency graph.
const LANGUAGE_SETTINGS_SINGLETON_ID = 'singleton';

async function loadTmdbSettings(): Promise<{
	apiKey: string;
	filters: Partial<GlobalTmdbFilters> | null;
}> {
	const now = Date.now();
	if (_cachedApiKey !== null && now - _settingsCacheTimestamp < SETTINGS_CACHE_TTL_MS) {
		return { apiKey: _cachedApiKey, filters: _cachedFilters };
	}

	// Deduplicate concurrent settings loads
	if (!_settingsCachePromise) {
		_settingsCachePromise = (async () => {
			try {
				const [apiKeySetting, filtersSetting] = await Promise.all([
					db.query.settings.findFirst({ where: eq(settings.key, 'tmdb_api_key') }),
					db.query.settings.findFirst({ where: eq(settings.key, 'global_filters') })
				]);

				_cachedApiKey = decryptSettingValue('tmdb_api_key', apiKeySetting?.value) ?? null;

				// language_settings is the TMDB locale/region authority. It is read
				// independently of global_filters: a fresh install without the
				// legacy row must still honor the Languages hub, and the legacy row
				// being absent/unparseable must not silently force en-US.
				let filters: Partial<GlobalTmdbFilters> = {};
				if (filtersSetting) {
					try {
						filters = JSON.parse(filtersSetting.value) as Partial<GlobalTmdbFilters>;
					} catch (e) {
						logger.error({ err: e }, 'Failed to parse global filters');
					}
				}

				let localeRow: typeof languageSettings.$inferSelect | undefined;
				try {
					localeRow = await db.query.languageSettings.findFirst({
						where: eq(languageSettings.id, LANGUAGE_SETTINGS_SINGLETON_ID)
					});
				} catch (e) {
					logger.warn({ err: e }, 'Failed to read language_settings for TMDB locale');
				}
				const locale = normalizeMetadataLocale(localeRow?.metadataLocale);
				if (locale) {
					filters.language = locale;
				}
				const region = normalizeRegionCode(localeRow?.region);
				if (region) {
					filters.region = region;
				}

				_cachedFilters = Object.keys(filters).length > 0 ? filters : null;
				_settingsCacheTimestamp = Date.now();
			} finally {
				_settingsCachePromise = null;
			}
		})();
	}
	await _settingsCachePromise;

	if (!_cachedApiKey) {
		throw new Error('TMDB API Key not configured');
	}

	return { apiKey: _cachedApiKey, filters: _cachedFilters };
}

async function fetchWithRetry(url: string, options?: RequestInit, retries = 3): Promise<Response> {
	const BASE_DELAY_MS = 1000;

	for (let attempt = 0; attempt <= retries; attempt++) {
		const res = await fetch(url, options);

		if (attempt === retries || res.ok || res.status !== 429) {
			return res;
		}

		const retryAfter = res.headers.get('Retry-After');
		const parsed = parseInt(retryAfter ?? '', 10);
		const delayMs = !isNaN(parsed) ? parsed * 1000 : BASE_DELAY_MS * Math.pow(2, attempt);

		logger.warn(
			{ url: url.split('?')[0], attempt: attempt + 1, delayMs },
			'TMDB rate limited, retrying'
		);
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}

	// Unreachable — satisfies TypeScript return type
	return fetch(url, options);
}

export const tmdb = {
	/**
	 * Invalidate the cached TMDB settings. Call this after updating
	 * tmdb_api_key or global_filters in the settings table.
	 */
	invalidateSettings() {
		_cachedApiKey = null;
		_cachedFilters = null;
		_settingsCacheTimestamp = 0;
		_settingsCachePromise = null;
	},

	async getRegion(): Promise<string> {
		try {
			const { filters } = await loadTmdbSettings();
			return filters?.region || TMDB.DEFAULT_REGION;
		} catch {
			return TMDB.DEFAULT_REGION;
		}
	},

	async fetch(
		endpoint: string,
		options: RequestInit = {},
		skipFilters = false,
		skipKeywordBlocklist = false
	) {
		const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
		const isGetRequest = !options.method || options.method === 'GET';

		const { apiKey, filters } = await loadTmdbSettings();
		const cacheKey = getCacheKey(
			path,
			skipFilters,
			filters?.language,
			skipKeywordBlocklist,
			filters?.region
		);

		if (isGetRequest) {
			const cached = tmdbCache.get(cacheKey);
			if (cached) {
				return filterBlockedResults(cached);
			}

			const inFlight = inFlightRequests.get(cacheKey);
			if (inFlight) {
				logger.debug({ path }, 'Deduplicating in-flight TMDB request');
				return filterBlockedResults(await inFlight);
			}
		}

		const requestPromise = (async () => {
			try {
				const url = new URL(TMDB.BASE_URL + path);

				// Add API key
				url.searchParams.set('api_key', apiKey);

				// Apply Global Filters (Pre-request)
				// Only apply as defaults — caller's explicit params take precedence.
				if (filters && !skipFilters) {
					if (filters.include_adult !== undefined && !url.searchParams.has('include_adult')) {
						url.searchParams.set('include_adult', String(filters.include_adult));
					}
					if (filters.language && !url.searchParams.has('language')) {
						url.searchParams.set('language', filters.language);
					}
					if (filters.region && !url.searchParams.has('region')) {
						url.searchParams.set('region', filters.region);
					}
					if (filters.region) {
						if (
							(path.includes('/discover/') || path.includes('/watch/providers/')) &&
							!url.searchParams.has('watch_region')
						) {
							url.searchParams.set('watch_region', filters.region);
						}

						if (path.includes('/discover/') && !url.searchParams.has('certification_country')) {
							url.searchParams.set('certification_country', filters.region);
						}
					}

					// Apply Discover-specific filters — only when caller hasn't set them
					if (path.includes('/discover/')) {
						const minVoteAverage = filters.min_vote_average ?? 0;
						const minVoteCount = filters.min_vote_count ?? 0;
						if (minVoteAverage > 0 && !url.searchParams.has('vote_average.gte')) {
							url.searchParams.set('vote_average.gte', String(minVoteAverage));
						}
						if (minVoteCount > 0 && !url.searchParams.has('vote_count.gte')) {
							url.searchParams.set('vote_count.gte', String(minVoteCount));
						}
						if (
							filters.excluded_genre_ids &&
							filters.excluded_genre_ids.length > 0 &&
							!url.searchParams.has('without_genres')
						) {
							url.searchParams.set('without_genres', filters.excluded_genre_ids.join(','));
						}
					}

					// Apply globally blocked keywords as without_keywords for discover paths
					if (path.includes('/discover/') && !skipKeywordBlocklist) {
						const { keywordBlocklistService } =
							await import('#lib/server/settings/KeywordBlocklistService.js');
						const blockedIds = await keywordBlocklistService.getBlockedKeywordIds();
						if (blockedIds.length > 0) {
							const existing = url.searchParams.get('without_keywords');
							const existingIds = existing ? existing.split(',').filter(Boolean) : [];
							const merged = [...new Set([...existingIds, ...blockedIds.map(String)])];
							url.searchParams.set('without_keywords', merged.join(','));
						}
					}
				}

				// Image language follows the effective response language: a
				// details request asking for images gets `null,<base>` for the
				// locale that will actually be used (caller param wins, then
				// language_settings metadata_locale via filters).
				const effectiveLanguage = url.searchParams.get('language') ?? filters?.language;
				if (
					effectiveLanguage &&
					!url.searchParams.has('include_image_language') &&
					url.searchParams.has('append_to_response')
				) {
					url.searchParams.set(
						'include_image_language',
						`null,${effectiveLanguage.split('-')[0].toLowerCase()}`
					);
				}

				const res = await fetchWithRetry(url.toString(), options);

				if (!res.ok) {
					let errorMessage = `TMDB Error: ${res.status} ${res.statusText}`;
					try {
						const errorBody = await res.json();
						if (errorBody.status_message) {
							errorMessage = `TMDB Error: ${errorBody.status_message}`;
						}
					} catch {
						// ignore json parse error
					}
					throw new Error(errorMessage);
				}

				const data = await res.json();

				// Apply Global Filters (Post-request / Response Filtering)
				// This is crucial for Search endpoints which ignore some discover params
				// Skip filtering when skipFilters=true (used by media matcher to see all results)
				if (!skipFilters && filters && data.results && Array.isArray(data.results)) {
					interface FilterableItem {
						vote_average?: number;
						vote_count?: number;
						genre_ids?: number[];
						adult?: boolean;
					}

					const resolvedFilters = filters;
					const minVoteAverage = resolvedFilters.min_vote_average ?? 0;
					const minVoteCount = resolvedFilters.min_vote_count ?? 0;
					const excludedGenreIds = resolvedFilters.excluded_genre_ids ?? [];

					data.results = data.results.filter((item: FilterableItem) => {
						// Filter by Score
						if (minVoteAverage > 0 && (item.vote_average ?? 0) < minVoteAverage) {
							return false;
						}
						// Filter by Vote Count
						if (minVoteCount > 0 && (item.vote_count ?? 0) < minVoteCount) {
							return false;
						}
						// Filter by Excluded Genres
						if (excludedGenreIds.length > 0 && item.genre_ids) {
							const hasExcludedGenre = item.genre_ids.some((id) => excludedGenreIds.includes(id));
							if (hasExcludedGenre) {
								return false;
							}
						}
						// Filter by Adult (Double check)
						if (!resolvedFilters.include_adult && item.adult) {
							return false;
						}
						return true;
					});
				}

				// Cache successful response (after filtering)
				if (isGetRequest) {
					tmdbCache.set(cacheKey, data, path);
				}

				return data;
			} finally {
				if (isGetRequest) {
					inFlightRequests.delete(cacheKey);
				}
			}
		})();

		// Store in-flight promise for deduplication (GET requests only)
		if (isGetRequest) {
			inFlightRequests.set(cacheKey, requestPromise);
		}

		return filterBlockedResults(await requestPromise);
	},
	async getMovieReleaseInfo(id: number): Promise<MovieReleaseInfo> {
		return this.fetch(`/movie/${id}?append_to_response=release_dates`) as Promise<MovieReleaseInfo>;
	},
	async getMovie(id: number, language?: string | null): Promise<MovieDetails> {
		const params = new URLSearchParams({
			append_to_response:
				'credits,videos,images,recommendations,similar,watch/providers,release_dates,keywords'
		});
		if (language) params.set('language', language);
		return this.fetch(`/movie/${id}?${params.toString()}`) as Promise<MovieDetails>;
	},
	async getTVShow(id: number, language?: string | null): Promise<TVShowDetails> {
		const params = new URLSearchParams({
			append_to_response:
				'credits,videos,images,recommendations,similar,watch/providers,content_ratings,keywords'
		});
		if (language) params.set('language', language);
		return this.fetch(`/tv/${id}?${params.toString()}`) as Promise<TVShowDetails>;
	},
	async getSeason(tvId: number, seasonNumber: number, language?: string | null): Promise<Season> {
		const base = `/tv/${tvId}/season/${seasonNumber}`;
		if (!language) {
			return this.fetch(base) as Promise<Season>;
		}
		const params = new URLSearchParams({ language });
		return this.fetch(`${base}?${params.toString()}`) as Promise<Season>;
	},
	async getEpisodeGroups(tvId: number): Promise<EpisodeGroupsResponse> {
		return this.fetch(`/tv/${tvId}/episode_groups`) as Promise<EpisodeGroupsResponse>;
	},
	async getEpisodeGroup(groupId: string): Promise<EpisodeGroup> {
		return this.fetch(`/tv/episode_group/${groupId}`) as Promise<EpisodeGroup>;
	},
	async getCollection(id: number): Promise<Collection> {
		return this.fetch(`/collection/${id}`) as Promise<Collection>;
	},

	async searchCollections(query: string): Promise<
		{
			id: number;
			name: string;
			poster_path: string | null;
			backdrop_path: string | null;
			overview: string;
		}[]
	> {
		const result = (await this.fetch(`/search/collection?query=${encodeURIComponent(query)}`)) as {
			results: {
				id: number;
				name: string;
				poster_path: string | null;
				backdrop_path: string | null;
				overview: string;
			}[];
		};
		return result.results ?? [];
	},

	async getPerson(id: number): Promise<PersonDetails> {
		return this.fetch(
			`/person/${id}?append_to_response=combined_credits,external_ids`
		) as Promise<PersonDetails>;
	},

	/**
	 * Get person basic details without combined_credits (fast, small payload ~5KB)
	 * Use this for initial page load, then lazy-load credits separately
	 */
	async getPersonBasic(
		id: number
	): Promise<Omit<PersonDetails, 'combined_credits'> & { combined_credits?: undefined }> {
		return this.fetch(`/person/${id}?append_to_response=external_ids`) as Promise<
			Omit<PersonDetails, 'combined_credits'>
		>;
	},

	/**
	 * Get person's combined credits (filmography) - cached separately from person details
	 */
	async getPersonCredits(id: number): Promise<PersonCombinedCredits> {
		return this.fetch(`/person/${id}/combined_credits`) as Promise<PersonCombinedCredits>;
	},

	/**
	 * Get external IDs (IMDB, TVDB, etc.) for a movie
	 */
	async getMovieExternalIds(tmdbId: number): Promise<ExternalIds> {
		return this.fetch(`/movie/${tmdbId}/external_ids`) as Promise<ExternalIds>;
	},

	/**
	 * Get external IDs (IMDB, TVDB, etc.) for a TV show
	 */
	async getTvExternalIds(tmdbId: number): Promise<ExternalIds> {
		return this.fetch(`/tv/${tmdbId}/external_ids`) as Promise<ExternalIds>;
	},

	/**
	 * Get alternate titles for a movie
	 */
	async getMovieAlternateTitles(tmdbId: number): Promise<MovieAlternateTitlesResponse> {
		return this.fetch(
			`/movie/${tmdbId}/alternative_titles`
		) as Promise<MovieAlternateTitlesResponse>;
	},

	/**
	 * Get alternate titles for a TV show
	 */
	async getTvAlternateTitles(tmdbId: number): Promise<TvAlternateTitlesResponse> {
		return this.fetch(`/tv/${tmdbId}/alternative_titles`) as Promise<TvAlternateTitlesResponse>;
	},

	/**
	 * Get all translations for a movie (language-tagged titles/overviews).
	 * Unlike alternative_titles, this endpoint identifies the language of each
	 * title (ISO 639-1), which alternative_titles does not supply.
	 */
	async getMovieTranslations(tmdbId: number): Promise<TranslationsResponse> {
		return this.fetch(`/movie/${tmdbId}/translations`) as Promise<TranslationsResponse>;
	},

	/**
	 * Get all translations for a TV show (language-tagged names/overviews).
	 * TV translations carry the title in `data.name` (movies use `data.title`).
	 */
	async getTvTranslations(tmdbId: number): Promise<TranslationsResponse> {
		return this.fetch(`/tv/${tmdbId}/translations`) as Promise<TranslationsResponse>;
	},

	/**
	 * Find media by external ID (IMDB or TVDB)
	 */
	async findByExternalId(
		externalId: string,
		source: 'imdb_id' | 'tvdb_id'
	): Promise<FindByExternalIdResult> {
		return this.fetch(
			`/find/${externalId}?external_source=${source}`
		) as Promise<FindByExternalIdResult>;
	},

	/**
	 * Search for movies
	 * @param skipFilters - If true, bypass global filters (used by media matcher)
	 */
	async searchMovies(query: string, year?: number, skipFilters = false): Promise<SearchResult> {
		let endpoint = `/search/movie?query=${encodeURIComponent(query)}`;
		if (year) {
			endpoint += `&year=${year}`;
		}
		return this.fetch(endpoint, {}, skipFilters) as Promise<SearchResult>;
	},

	/**
	 * Search for TV shows
	 * @param skipFilters - If true, bypass global filters (used by media matcher)
	 */
	async searchTv(query: string, year?: number, skipFilters = false): Promise<SearchResult> {
		let endpoint = `/search/tv?query=${encodeURIComponent(query)}`;
		if (year) {
			endpoint += `&first_air_date_year=${year}`;
		}
		return this.fetch(endpoint, {}, skipFilters) as Promise<SearchResult>;
	},

	/**
	 * Get cache statistics for monitoring
	 */
	getCacheStats() {
		return tmdbCache.getStats();
	},

	/**
	 * Clear the TMDB response cache
	 * @param pattern - Optional pattern to match against cache keys
	 */
	clearCache(pattern?: string) {
		return tmdbCache.invalidate(pattern);
	},

	/**
	 * Check if TMDB API key is configured
	 */
	async isConfigured(): Promise<boolean> {
		try {
			const { apiKey } = await loadTmdbSettings();
			return !!apiKey;
		} catch {
			return false;
		}
	},

	// =========================================================================
	// DISCOVER API (for Smart Lists)
	// =========================================================================

	/**
	 * Discover movies with filters
	 * Supports all TMDB discover parameters
	 */
	async discoverMovies(
		params: DiscoverParams = {},
		skipFilters = false
	): Promise<DiscoverResponse> {
		const queryParams = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== null && value !== '') {
				queryParams.set(key, String(value));
			}
		}
		const endpoint = `/discover/movie?${queryParams.toString()}`;
		return this.fetch(endpoint, {}, skipFilters) as Promise<DiscoverResponse>;
	},

	/**
	 * Discover TV shows with filters
	 */
	async discoverTv(params: DiscoverParams = {}, skipFilters = false): Promise<DiscoverResponse> {
		const queryParams = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== null && value !== '') {
				queryParams.set(key, String(value));
			}
		}
		const endpoint = `/discover/tv?${queryParams.toString()}`;
		return this.fetch(endpoint, {}, skipFilters) as Promise<DiscoverResponse>;
	},

	async getNowPlaying(page = 1): Promise<DiscoverResponse> {
		return this.fetch(`/movie/now_playing?page=${page}`) as Promise<DiscoverResponse>;
	},

	async getUpcoming(page = 1): Promise<DiscoverResponse> {
		return this.fetch(`/movie/upcoming?page=${page}`) as Promise<DiscoverResponse>;
	},

	async getOnTheAir(page = 1): Promise<DiscoverResponse> {
		return this.fetch(`/tv/on_the_air?page=${page}`) as Promise<DiscoverResponse>;
	},

	/**
	 * Get movie genres list
	 */
	async getMovieGenres(): Promise<{ genres: TmdbGenre[] }> {
		return this.fetch('/genre/movie/list') as Promise<{ genres: TmdbGenre[] }>;
	},

	/**
	 * Get TV genres list
	 */
	async getTvGenres(): Promise<{ genres: TmdbGenre[] }> {
		return this.fetch('/genre/tv/list') as Promise<{ genres: TmdbGenre[] }>;
	},

	/**
	 * Get watch providers for a region
	 */
	async getWatchProviders(
		mediaType: 'movie' | 'tv',
		region = 'US'
	): Promise<{ results: TmdbWatchProvider[] }> {
		return this.fetch(`/watch/providers/${mediaType}?watch_region=${region}`) as Promise<{
			results: TmdbWatchProvider[];
		}>;
	},

	/**
	 * Get certifications (age ratings)
	 */
	async getCertifications(mediaType: 'movie' | 'tv'): Promise<TmdbCertificationsResponse> {
		return this.fetch(`/certification/${mediaType}/list`) as Promise<TmdbCertificationsResponse>;
	},

	/**
	 * Curated popular networks for the discover network filter. TMDB has no
	 * network list or search endpoint, so ids come from DISCOVER_NETWORKS while
	 * names and logos are fetched live (cached like any other GET); the curated
	 * name is only a fallback when /network/{id} fails.
	 */
	async getNetworks(): Promise<TmdbNetwork[]> {
		return Promise.all(
			DISCOVER_NETWORKS.map(async ({ id, name }) => {
				try {
					const data = (await this.fetch(`/network/${id}`)) as {
						name?: string;
						logo_path?: string | null;
					} | null;
					return { id, name: data?.name || name, logo_path: data?.logo_path ?? null };
				} catch {
					return { id, name, logo_path: null };
				}
			})
		);
	},

	/**
	 * Search keywords
	 */
	async searchKeywords(query: string): Promise<{ results: TmdbKeyword[] }> {
		return this.fetch(`/search/keyword?query=${encodeURIComponent(query)}`) as Promise<{
			results: TmdbKeyword[];
		}>;
	},

	/**
	 * Get keyword details by ID
	 */
	async keywordDetails(keywordId: number): Promise<TmdbKeyword> {
		return this.fetch(`/keyword/${keywordId}`) as Promise<TmdbKeyword>;
	},

	/**
	 * Search people (actors, directors, etc.)
	 */
	async searchPeople(query: string): Promise<{ results: TmdbPersonSearchResult[] }> {
		return this.fetch(`/search/person?query=${encodeURIComponent(query)}`) as Promise<{
			results: TmdbPersonSearchResult[];
		}>;
	},

	/**
	 * Search companies
	 */
	async searchCompanies(query: string): Promise<{ results: TmdbCompanySearchResult[] }> {
		return this.fetch(`/search/company?query=${encodeURIComponent(query)}`) as Promise<{
			results: TmdbCompanySearchResult[];
		}>;
	},

	/**
	 * Get available languages
	 */
	async getLanguages(): Promise<TmdbLanguage[]> {
		return this.fetch('/configuration/languages') as Promise<TmdbLanguage[]>;
	},

	async getCountries(): Promise<
		{ iso_3166_1: string; english_name: string; native_name: string }[]
	> {
		return (await this.fetch('/configuration/countries')) as {
			iso_3166_1: string;
			english_name: string;
			native_name: string;
		}[];
	}
};

/**
 * External IDs returned by TMDB
 */
export interface ExternalIds {
	imdb_id: string | null;
	tvdb_id: number | null;
	wikidata_id: string | null;
	facebook_id: string | null;
	instagram_id: string | null;
	twitter_id: string | null;
}

/**
 * Single alternate title from TMDB
 */
export interface TmdbAlternateTitle {
	iso_3166_1: string; // Country code (e.g., 'US', 'CZ', 'DE')
	title: string; // The alternate title
	type: string; // Type of title (e.g., '', 'DVD title', 'working title')
}

/**
 * Movie alternate titles response from TMDB
 */
export interface MovieAlternateTitlesResponse {
	id: number;
	titles: TmdbAlternateTitle[];
}

/**
 * TV alternate titles response from TMDB (uses 'results' instead of 'titles')
 */
export interface TvAlternateTitlesResponse {
	id: number;
	results: TmdbAlternateTitle[];
}

/**
 * A single translation entry from /movie|tv/{id}/translations.
 * Movies carry the localized title in data.title; TV shows use data.name.
 */
export interface TmdbTranslation {
	iso_639_1: string; // Language code (e.g., 'en', 'ja', 'hu')
	iso_3166_1: string; // Country code (e.g., 'US', 'JP')
	name: string;
	english_name: string;
	data: {
		title?: string; // Movies
		name?: string; // TV shows
		overview?: string;
		homepage?: string;
	};
}

/**
 * Translations response from TMDB
 */
export interface TranslationsResponse {
	id: number;
	translations: TmdbTranslation[];
}

/**
 * Result from find by external ID
 */
export interface FindByExternalIdResult {
	movie_results: Array<{
		id: number;
		title: string;
		original_title: string;
		release_date: string;
		poster_path: string | null;
		overview: string;
		vote_average: number;
	}>;
	tv_results: Array<{
		id: number;
		name: string;
		original_name: string;
		first_air_date: string;
		poster_path: string | null;
		overview: string;
		vote_average: number;
	}>;
	person_results: Array<{
		id: number;
		name: string;
	}>;
}

/**
 * Search result from TMDB
 */
export interface SearchResult {
	page: number;
	total_pages: number;
	total_results: number;
	results: Array<{
		id: number;
		title?: string;
		name?: string;
		original_title?: string;
		original_name?: string;
		release_date?: string;
		first_air_date?: string;
		poster_path: string | null;
		overview: string;
		vote_average: number;
		media_type?: 'movie' | 'tv';
	}>;
}

// =========================================================================
// DISCOVER API TYPES
// =========================================================================

/**
 * Parameters for TMDB Discover API
 * Maps to query string parameters
 */
export interface DiscoverParams {
	// Pagination
	page?: number;

	// Sorting
	sort_by?: string;

	// Genres
	with_genres?: string; // Comma-separated IDs
	without_genres?: string;

	// Year/Date
	'primary_release_date.gte'?: string;
	'primary_release_date.lte'?: string;
	'first_air_date.gte'?: string;
	'first_air_date.lte'?: string;
	primary_release_year?: number;
	first_air_date_year?: number;
	year?: number;

	// Rating
	'vote_average.gte'?: number;
	'vote_average.lte'?: number;
	'vote_count.gte'?: number;

	// Popularity
	'popularity.gte'?: number;
	'popularity.lte'?: number;

	// People
	with_cast?: string; // Comma-separated person IDs
	with_crew?: string;
	with_people?: string;

	// Keywords
	with_keywords?: string;
	without_keywords?: string;

	// Watch Providers
	with_watch_providers?: string;
	watch_region?: string;
	with_watch_monetization_types?: string;

	// Certification
	certification?: string;
	certification_country?: string;
	'certification.gte'?: string;
	'certification.lte'?: string;

	// Runtime
	'with_runtime.gte'?: number;
	'with_runtime.lte'?: number;

	// Language
	with_original_language?: string;

	// TV-specific
	with_status?: string;
	with_type?: string;
	'air_date.gte'?: string;
	'air_date.lte'?: string;

	// Movie-specific
	with_release_type?: string;
	include_adult?: boolean;
	include_video?: boolean;

	// Companies
	with_companies?: string;

	// Region/Language
	region?: string;
	language?: string;
}

/**
 * Discover API response
 */
export interface DiscoverResponse {
	page: number;
	results: DiscoverItem[];
	total_pages: number;
	total_results: number;
}

/**
 * Single item from discover results
 */
export interface DiscoverItem {
	id: number;
	title?: string; // Movies
	name?: string; // TV
	original_title?: string;
	original_name?: string;
	overview: string;
	poster_path: string | null;
	backdrop_path: string | null;
	release_date?: string; // Movies
	first_air_date?: string; // TV
	vote_average: number;
	vote_count: number;
	popularity: number;
	genre_ids: number[];
	original_language: string;
	adult?: boolean;
}

export interface MovieReleaseInfo {
	status?: string;
	release_date?: string | null;
	release_dates?: ReleaseDatesResponse;
}

/**
 * TMDB Genre
 */
export interface TmdbGenre {
	id: number;
	name: string;
}

/**
 * TMDB Watch Provider
 */
export interface TmdbWatchProvider {
	provider_id: number;
	provider_name: string;
	logo_path: string;
	display_priority: number;
}

/**
 * TMDB Certifications response
 */
export interface TmdbCertificationsResponse {
	certifications: Record<
		string,
		Array<{
			certification: string;
			meaning: string;
			order: number;
		}>
	>;
}

/**
 * TMDB Keyword
 */
export interface TmdbKeyword {
	id: number;
	name: string;
}

/**
 * TMDB Person search result
 */
export interface TmdbPersonSearchResult {
	id: number;
	name: string;
	profile_path: string | null;
	known_for_department: string;
	popularity: number;
}

/**
 * TMDB Company search result
 */
export interface TmdbCompanySearchResult {
	id: number;
	name: string;
	logo_path: string | null;
	origin_country: string;
}

/**
 * TMDB Language
 */
export interface TmdbLanguage {
	iso_639_1: string;
	english_name: string;
	name: string;
}
