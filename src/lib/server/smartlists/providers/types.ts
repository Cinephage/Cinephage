import type { SmartListMediaType } from '#lib/server/smartlists/types.js';
/**
 * External List Provider Types
 *
 * Type definitions for external list providers that fetch items from
 * third-party sources like JSON URLs, Trakt lists, etc.
 */

/**
 * Represents a single item from an external list
 */
export interface ExternalListItem {
	/** TMDB ID (preferred identifier) */
	tmdbId?: number;

	/** IMDB ID (will be resolved to TMDB ID if tmdbId not provided) */
	imdbId?: string;

	/** Title for display and TMDB search fallback */
	title: string;

	/** Release year (optional, helps with TMDB search) */
	year?: number;

	/** Poster image path/URL */
	posterPath?: string | null;

	/** Overview/description */
	overview?: string;

	/** TMDB vote average */
	voteAverage?: number;

	/** TMDB vote count */
	voteCount?: number;

	/** Genre IDs from TMDB */
	genreIds?: number[];

	/** Original language */
	originalLanguage?: string;
}

/**
 * Configuration for external JSON list sources
 */
export interface ExternalJsonConfig {
	/** URL to fetch the JSON list from */
	url: string;

	/** Optional headers for authentication or other purposes */
	headers?: Record<string, string>;
}

/**
 * Configuration for Trakt list sources
 */
export interface TraktListConfig {
	/** Trakt list ID or slug */
	listId: string;

	/** Username for user lists */
	username?: string;

	/** Trakt API key (optional, for private lists) */
	apiKey?: string;
}

/**
 * Configuration for IMDb list sources
 */
export interface ImdbListConfig {
	/** IMDb list ID (e.g., 'ls060044601') */
	listId: string;
	/** Optional media type filter */
	mediaType?: SmartListMediaType | '';
}

/**
 * Configuration for TMDb Popular list sources
 */
export interface TmdbPopularConfig {
	/** List type: 'popular', 'theaters', 'top', 'upcoming' */
	listType: 'popular' | 'theaters' | 'top' | 'upcoming';
	/** Minimum vote average (0-10) */
	minVoteAverage?: number;
	/** Minimum vote count */
	minVotes?: number;
	/** Certification filter (e.g., 'PG-13', 'R') */
	certification?: string;
	/** Include genre IDs (comma-separated) */
	includeGenreIds?: string;
	/** Exclude genre IDs (comma-separated) */
	excludeGenreIds?: string;
	/** Release date from (YYYY-MM-DD) */
	primaryReleaseDateGte?: string;
	/** Release date to (YYYY-MM-DD) */
	primaryReleaseDateLte?: string;
	/** Original language code (e.g., 'en', 'es') */
	withOriginalLanguage?: string;
	/** Maximum pages to fetch */
	maxPages?: number;
}

/**
 * Configuration for TMDb List sources
 */
export interface TmdbListConfig {
	/** TMDb list ID */
	listId: string;
}

/**
 * Union type for all external source configurations
 */
export type ExternalSourceConfig =
	| ExternalJsonConfig
	| TraktListConfig
	| ImdbListConfig
	| TmdbPopularConfig
	| TmdbListConfig
	| Record<string, unknown>;

/**
 * Result from fetching an external list
 */
export interface ExternalListResult {
	/** Items fetched from the external source */
	items: ExternalListItem[];

	/** Total count (may differ from items.length if some failed to parse) */
	totalCount: number;

	/** Number of items that failed to parse/resolve */
	failedCount: number;

	/** Any error message from the fetch operation */
	error?: string;
}

/**
 * Interface that all external list providers must implement
 */
export interface ExternalListProvider {
	/** Provider type identifier */
	readonly type: string;

	/** Human-readable provider name */
	readonly name: string;

	/**
	 * Validate the configuration for this provider
	 * @returns true if config is valid, false otherwise
	 */
	validateConfig(config: unknown): boolean;

	/**
	 * Fetch items from the external source
	 * @param config Provider-specific configuration
	 * @param mediaType 'movie', 'tv', or '' (empty string for all types) - used for ID resolution context
	 * @returns Promise resolving to the list result
	 */
	fetchItems(config: unknown, mediaType: SmartListMediaType | ''): Promise<ExternalListResult>;
}
