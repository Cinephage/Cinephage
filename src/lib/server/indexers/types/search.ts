/**
 * Search Criteria Types
 *
 * Typed search criteria for different content types.
 * Enables ID-based searching with automatic fallback to text search.
 */

import type { Category } from './category';

// =============================================================================
// SEARCH TYPES
// =============================================================================

/**
 * Search type enum
 */
export type SearchType = 'basic' | 'movie' | 'tv' | 'music' | 'book';

// =============================================================================
// BASE CRITERIA
// =============================================================================

/**
 * Base search criteria shared by all search types
 */
export interface BaseSearchCriteria {
	/** Text query (optional for ID-based searches) */
	query?: string;
	/** Search source: 'interactive' (manual) or 'automatic' (background) */
	searchSource?: 'interactive' | 'automatic';
	/** Categories to filter */
	categories?: Category[];
	/** Limit results */
	limit?: number;
	/** Offset for pagination */
	offset?: number;
	/** Specific indexer IDs to search (empty = all enabled) */
	indexerIds?: string[];
	/**
	 * Multiple titles to search with (for multi-title search).
	 * Includes primary title, original title, and alternate titles.
	 * Used for text-based fallback when ID-based search fails.
	 */
	searchTitles?: string[];
	/** Preferred audio language (ISO 639-1 code, e.g. 'fr', 'de').
	 * Used for post-search language boosting of releases. */
	language?: string;
	/**
	 * Ordered audio preference resolved from the effective language profile
	 * (audio-language acquisition design, 2026-09-15). Drives graded release
	 * ranking on both search paths; supersedes the single-code `language`
	 * field when present. Set by the automatic search paths; the manual route
	 * keeps `language` for its single-language semantics.
	 */
	audioPreference?: {
		preferOriginal: boolean;
		languages: string[];
		originalLanguage: string | null;
		mode: 'prefer' | 'require';
	};
	/** True when the title is classified as anime (TMDB seriesType='anime'). Expands categories to include 5070. */
	isAnime?: boolean;
	/** True when the title is flagged adult AND the global include_adult toggle is on. Expands categories to include 6xxx. */
	isAdult?: boolean;
	/**
	 * Optional abort signal. Propagated to the underlying HTTP client (and any
	 * browser-based Cloudflare bypass) so a timed-out or cancelled search stops
	 * in-flight work - notably closing headless browsers promptly.
	 */
	signal?: AbortSignal;
}

// =============================================================================
// TYPED SEARCH CRITERIA
// =============================================================================

/**
 * Movie-specific search criteria
 */
export interface MovieSearchCriteria extends BaseSearchCriteria {
	searchType: 'movie';
	/** IMDB ID (e.g., "tt1234567") */
	imdbId?: string;
	/** TMDB ID */
	tmdbId?: number;
	/** Trakt ID */
	traktId?: number;
	/** Release year */
	year?: number;
}

/**
 * Episode format type for search.
 * Re-exported from definition.ts for convenience.
 */
export type { EpisodeFormatType } from './definition';

/**
 * TV-specific search criteria
 */
export interface TvSearchCriteria extends BaseSearchCriteria {
	searchType: 'tv';
	/** IMDB ID */
	imdbId?: string;
	/** TMDB ID */
	tmdbId?: number;
	/** TVDB ID */
	tvdbId?: number;
	/** TVMaze ID */
	tvMazeId?: number;
	/** Trakt ID */
	traktId?: number;
	/** Season number */
	season?: number;
	/** Episode number */
	episode?: number;
	/** Release year */
	year?: number;
	/**
	 * Preferred episode format for this search request.
	 * Used by SearchOrchestrator to specify which format to use when iterating
	 * over multiple formats. TemplateEngine uses this to set .Query.Episode.
	 * If not specified, defaults to 'standard' (S01E05).
	 */
	preferredEpisodeFormat?: import('./definition').EpisodeFormatType;
}

/**
 * Music search criteria
 */
export interface MusicSearchCriteria extends BaseSearchCriteria {
	searchType: 'music';
	/** Artist name */
	artist?: string;
	/** Album name */
	album?: string;
	/** Year */
	year?: number;
}

/**
 * Book search criteria
 */
export interface BookSearchCriteria extends BaseSearchCriteria {
	searchType: 'book';
	/** Author */
	author?: string;
	/** Book title */
	title?: string;
}

/**
 * Basic text search - requires query
 */
export interface BasicSearchCriteria extends Omit<BaseSearchCriteria, 'query'> {
	searchType: 'basic';
	/** Text query (required for basic search) */
	query: string;
}

/**
 * Union of all search criteria types
 */
export type SearchCriteria =
	| MovieSearchCriteria
	| TvSearchCriteria
	| MusicSearchCriteria
	| BookSearchCriteria
	| BasicSearchCriteria;

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Check if criteria is for movie search
 */
export function isMovieSearch(criteria: SearchCriteria): criteria is MovieSearchCriteria {
	return criteria.searchType === 'movie';
}

/**
 * Check if criteria is for TV search
 */
export function isTvSearch(criteria: SearchCriteria): criteria is TvSearchCriteria {
	return criteria.searchType === 'tv';
}

/**
 * Check if criteria is for music search
 */
export function isMusicSearch(criteria: SearchCriteria): criteria is MusicSearchCriteria {
	return criteria.searchType === 'music';
}

/**
 * Check if criteria is for book search
 */
export function isBookSearch(criteria: SearchCriteria): criteria is BookSearchCriteria {
	return criteria.searchType === 'book';
}

/**
 * Check if criteria is basic text search
 */
export function isBasicSearch(criteria: SearchCriteria): criteria is BasicSearchCriteria {
	return criteria.searchType === 'basic';
}

// =============================================================================
// EPISODE TOKEN HELPERS
// =============================================================================

/**
 * Generate all common episode token formats for a given season/episode.
 * Used to check if query already contains an episode token.
 */
export function generateEpisodeTokenFormats(
	season: number,
	episode?: number
): { patterns: RegExp[]; tokens: string[] } {
	const seasonPadded = String(season).padStart(2, '0');
	const tokens: string[] = [];
	const patterns: RegExp[] = [];

	if (episode !== undefined) {
		const episodePadded = String(episode).padStart(2, '0');
		// Standard: S01E05, s01e05
		tokens.push(`S${seasonPadded}E${episodePadded}`);
		// European: 1x05, 01x05
		tokens.push(`${season}x${episodePadded}`);
		tokens.push(`${seasonPadded}x${episodePadded}`);
		// Compact: 105 (only if unambiguous - season < 10)
		if (season < 10) {
			tokens.push(`${season}${episodePadded}`);
		}
		// Regex patterns (case-insensitive, word boundaries)
		patterns.push(new RegExp(`\\bS${seasonPadded}E${episodePadded}\\b`, 'i'));
		patterns.push(new RegExp(`\\b${season}x${episodePadded}\\b`, 'i'));
		patterns.push(new RegExp(`\\b${seasonPadded}x${episodePadded}\\b`, 'i'));
	} else {
		// Season-only: S01, s01
		tokens.push(`S${seasonPadded}`);
		patterns.push(new RegExp(`\\bS${seasonPadded}\\b`, 'i'));
	}

	return { patterns, tokens };
}

/**
 * Check if a query string already contains an episode token for the given season/episode.
 * This prevents duplicate episode tokens from being added to search queries.
 */
export function queryContainsEpisodeToken(
	query: string | undefined,
	season: number,
	episode?: number
): boolean {
	if (!query) return false;

	const { patterns } = generateEpisodeTokenFormats(season, episode);
	return patterns.some((pattern) => pattern.test(query));
}

/**
 * Check if a keywords array already contains an episode token for the given season/episode.
 */
export function keywordsContainEpisodeToken(
	keywords: string[],
	season: number,
	episode?: number
): boolean {
	const { tokens } = generateEpisodeTokenFormats(season, episode);
	const keywordsLower = keywords.map((k) => k.toLowerCase());
	return tokens.some((token) => keywordsLower.includes(token.toLowerCase()));
}

// =============================================================================
// CRITERIA UTILITIES
// =============================================================================

/**
 * Check if criteria has any searchable IDs (for tiered search)
 */
export function hasSearchableIds(criteria: SearchCriteria): boolean {
	if (isMovieSearch(criteria)) {
		return !!(criteria.imdbId || criteria.tmdbId);
	}
	if (isTvSearch(criteria)) {
		return !!(criteria.imdbId || criteria.tmdbId || criteria.tvdbId || criteria.tvMazeId);
	}
	return false;
}

/**
 * Create criteria with IDs removed (for fallback text search)
 */
export function createTextOnlyCriteria<T extends SearchCriteria>(criteria: T): T {
	const copy = { ...criteria };

	if (isMovieSearch(copy)) {
		delete copy.imdbId;
		delete copy.tmdbId;
	} else if (isTvSearch(copy)) {
		delete copy.imdbId;
		delete copy.tmdbId;
		delete copy.tvdbId;
		delete copy.tvMazeId;
	}

	return copy;
}

/**
 * Create criteria for ID-based search.
 * Keeps query text alongside IDs for indexers that need both (Newznab).
 * IDs and query work as complementary filters, not alternatives.
 */
export function createIdOnlyCriteria<T extends SearchCriteria>(criteria: T): T {
	return { ...criteria };
}

/**
 * Get a display string for the criteria (for logging)
 */
export function criteriaToString(criteria: SearchCriteria): string {
	const parts: string[] = [`type=${criteria.searchType}`];

	if (criteria.query) {
		parts.push(`q="${criteria.query}"`);
	}

	if (isMovieSearch(criteria)) {
		if (criteria.imdbId) parts.push(`imdb=${criteria.imdbId}`);
		if (criteria.tmdbId) parts.push(`tmdb=${criteria.tmdbId}`);
		if (criteria.year) parts.push(`year=${criteria.year}`);
	} else if (isTvSearch(criteria)) {
		if (criteria.imdbId) parts.push(`imdb=${criteria.imdbId}`);
		if (criteria.tmdbId) parts.push(`tmdb=${criteria.tmdbId}`);
		if (criteria.tvdbId) parts.push(`tvdb=${criteria.tvdbId}`);
		if (criteria.season !== undefined) parts.push(`s=${criteria.season}`);
		if (criteria.episode !== undefined) parts.push(`e=${criteria.episode}`);
	} else if (isMusicSearch(criteria)) {
		if (criteria.artist) parts.push(`artist="${criteria.artist}"`);
		if (criteria.album) parts.push(`album="${criteria.album}"`);
	} else if (isBookSearch(criteria)) {
		if (criteria.author) parts.push(`author="${criteria.author}"`);
		if (criteria.title) parts.push(`title="${criteria.title}"`);
	}

	if (criteria.categories?.length) {
		parts.push(`cats=[${criteria.categories.join(',')}]`);
	}
	if (criteria.isAnime) parts.push('anime=true');
	if (criteria.isAdult) parts.push('adult=true');

	return parts.join(' ');
}

/**
 * Create a movie search criteria
 */
export function createMovieSearchCriteria(
	options: Omit<MovieSearchCriteria, 'searchType'>
): MovieSearchCriteria {
	return { searchType: 'movie', ...options };
}

/**
 * Create a TV search criteria
 */
export function createTvSearchCriteria(
	options: Omit<TvSearchCriteria, 'searchType'>
): TvSearchCriteria {
	return { searchType: 'tv', ...options };
}

/**
 * Create a basic search criteria
 */
export function createBasicSearchCriteria(
	query: string,
	options: Omit<BasicSearchCriteria, 'searchType' | 'query'> = {}
): BasicSearchCriteria {
	return { searchType: 'basic', query, ...options };
}
