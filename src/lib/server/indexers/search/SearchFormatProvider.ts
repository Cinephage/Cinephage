/**
 * SearchFormatProvider - Single source of truth for search format generation.
 *
 * This module handles the generation of various search format strings
 * (episode tokens, movie year formats, etc.) in a centralized, extensible way.
 *
 * Following Prowlarr's pattern: criteria holds structured data,
 * and this provider generates the appropriate format strings based on
 * indexer capabilities or requested format types.
 */

import type { TvSearchCriteria, SearchCriteria } from '../types';
import { isTvSearch, isMovieSearch } from '../types';

// =============================================================================
// FORMAT TYPES
// =============================================================================

/**
 * Supported episode format types.
 * - standard: S01E05 (most common)
 * - european: 1x05 (used by some European trackers)
 * - compact: 105 (season + episode as single number, legacy format)
 * - daily: 2024.01.15 (for daily shows like talk shows)
 * - absolute: 125 (absolute episode number, for anime)
 */
export type EpisodeFormatType = 'standard' | 'european' | 'compact' | 'daily' | 'absolute';

/**
 * Supported movie format types.
 * - standard: Title (Year)
 * - yearOnly: just the year for filtering
 * - noYear: title without year
 */
export type MovieFormatType = 'standard' | 'yearOnly' | 'noYear';

/**
 * Search format configuration for an indexer.
 * Specifies which format types the indexer prefers/supports.
 */
export interface SearchFormats {
	/** Episode format preferences, in order of preference */
	episode?: EpisodeFormatType[];
	/** Movie format preferences */
	movie?: MovieFormatType[];
}

/**
 * Default search formats when indexer doesn't specify.
 */
export const DEFAULT_SEARCH_FORMATS: Required<SearchFormats> = {
	episode: ['standard'],
	movie: ['standard']
};

/**
 * All episode formats for comprehensive search (fallback).
 */
export const ALL_EPISODE_FORMATS: EpisodeFormatType[] = ['standard', 'european', 'compact'];

/**
 * Episode formats for anime searches.
 * Anime releases typically use absolute episode numbers (01, 02...) instead of S01E01.
 */
export const ANIME_EPISODE_FORMATS: EpisodeFormatType[] = ['standard', 'absolute'];

// =============================================================================
// EPISODE FORMAT GENERATION
// =============================================================================

/**
 * Episode format result containing the formatted string and metadata.
 */
export interface EpisodeFormat {
	/** The formatted episode string (e.g., "S01E05") */
	value: string;
	/** The format type used */
	type: EpisodeFormatType;
	/** Season number */
	season: number;
	/** Episode number (undefined for season-only) */
	episode?: number;
}

/**
 * Generate episode format string for a specific format type.
 *
 * @param season - Season number
 * @param episode - Episode number (optional for season-only searches)
 * @param formatType - The format type to generate
 * @param absoluteEpisode - Absolute episode number (for anime)
 * @param airDate - Air date (for daily shows)
 * @returns The formatted episode string, or null if format can't be generated
 */
export function generateEpisodeFormat(
	season: number,
	episode: number | undefined,
	formatType: EpisodeFormatType,
	absoluteEpisode?: number,
	airDate?: Date
): string | null {
	const seasonPadded = String(season).padStart(2, '0');
	const episodePadded = episode !== undefined ? String(episode).padStart(2, '0') : undefined;

	switch (formatType) {
		case 'standard':
			// S01E05 or S01 (season-only)
			if (episodePadded) {
				return `S${seasonPadded}E${episodePadded}`;
			}
			return `S${seasonPadded}`;

		case 'european':
			// 1x05 (only valid with episode)
			if (episodePadded) {
				return `${season}x${episodePadded}`;
			}
			return null;

		case 'compact':
			// 105 (only valid with episode, and can be ambiguous for season >= 10)
			if (episodePadded) {
				return `${season}${episodePadded}`;
			}
			return null;

		case 'daily':
			// 2024.01.15 (requires air date)
			if (airDate) {
				const year = airDate.getFullYear();
				const month = String(airDate.getMonth() + 1).padStart(2, '0');
				const day = String(airDate.getDate()).padStart(2, '0');
				return `${year}.${month}.${day}`;
			}
			return null;

		case 'absolute':
			// Absolute episode number for anime (zero-padded: 01, 02, ..., 99, 100)
			if (absoluteEpisode !== undefined) {
				return String(absoluteEpisode).padStart(2, '0');
			}
			return null;

		default:
			return null;
	}
}

/**
 * Generate all episode format strings for the given criteria and format types.
 *
 * @param criteria - TV search criteria with season/episode info
 * @param formatTypes - Array of format types to generate (defaults to standard only)
 * @returns Array of episode format objects
 */
export function getEpisodeFormats(
	criteria: TvSearchCriteria,
	formatTypes: EpisodeFormatType[] = ['standard']
): EpisodeFormat[] {
	const formats: EpisodeFormat[] = [];

	if (criteria.season === undefined) {
		return formats;
	}

	for (const type of formatTypes) {
		// For absolute format, use the episode number as the absolute episode number.
		// This is exact for S01 and an approximation for later seasons, but is correct
		// for most anime (single-season series or shows with continuous absolute numbering).
		const absoluteEpisode = type === 'absolute' ? criteria.episode : undefined;
		const value = generateEpisodeFormat(criteria.season, criteria.episode, type, absoluteEpisode);

		if (value !== null) {
			formats.push({
				value,
				type,
				season: criteria.season,
				episode: criteria.episode
			});
		}
	}

	return formats;
}

/**
 * Get the primary (first/preferred) episode format string.
 *
 * @param criteria - TV search criteria
 * @param formatTypes - Format types in order of preference
 * @returns The formatted string, or null if no format could be generated
 */
export function getPrimaryEpisodeFormat(
	criteria: TvSearchCriteria,
	formatTypes: EpisodeFormatType[] = ['standard']
): string | null {
	const formats = getEpisodeFormats(criteria, formatTypes);
	return formats.length > 0 ? formats[0].value : null;
}

// =============================================================================
// MOVIE FORMAT GENERATION
// =============================================================================

/**
 * Movie format result.
 */
export interface MovieFormat {
	/** The formatted movie string */
	value: string;
	/** The format type used */
	type: MovieFormatType;
	/** The year (if applicable) */
	year?: number;
}

/**
 * Generate movie format strings for the given criteria.
 *
 * @param title - Movie title
 * @param year - Release year (optional)
 * @param formatTypes - Format types to generate
 * @returns Array of movie format objects
 */
export function getMovieFormats(
	title: string,
	year: number | undefined,
	formatTypes: MovieFormatType[] = ['standard']
): MovieFormat[] {
	const formats: MovieFormat[] = [];

	for (const type of formatTypes) {
		switch (type) {
			case 'standard':
				if (year) {
					formats.push({
						value: `${title} ${year}`,
						type,
						year
					});
				} else {
					formats.push({
						value: title,
						type
					});
				}
				break;

			case 'yearOnly':
				if (year) {
					formats.push({
						value: String(year),
						type,
						year
					});
				}
				break;

			case 'noYear':
				formats.push({
					value: title,
					type
				});
				break;
		}
	}

	return formats;
}

// =============================================================================
// COMBINED SEARCH STRING GENERATION
// =============================================================================

/**
 * Build a complete search query string from title and episode format.
 * This is the single source of truth for combining title + episode tokens.
 *
 * @param title - The show/movie title (clean, no episode tokens)
 * @param episodeFormat - The episode format string (e.g., "S01E05")
 * @returns Combined search string
 */
export function buildSearchQuery(title: string, episodeFormat?: string | null): string {
	if (episodeFormat) {
		return `${title} ${episodeFormat}`;
	}
	return title;
}

/**
 * Build all search query variants for a TV search.
 * Combines each title with each episode format.
 *
 * @param titles - Array of title variants to search
 * @param criteria - TV search criteria
 * @param formatTypes - Episode format types to use
 * @param maxTitles - Maximum number of titles to use (default 3)
 * @returns Array of complete search query strings
 */
export function buildTvSearchQueries(
	titles: string[],
	criteria: TvSearchCriteria,
	formatTypes: EpisodeFormatType[] = ['standard'],
	maxTitles: number = 3
): string[] {
	const queries: string[] = [];
	const episodeFormats = getEpisodeFormats(criteria, formatTypes);
	const limitedTitles = titles.slice(0, maxTitles);

	for (const title of limitedTitles) {
		if (episodeFormats.length > 0) {
			for (const format of episodeFormats) {
				queries.push(buildSearchQuery(title, format.value));
			}
		} else {
			// No episode info, just use title
			queries.push(title);
		}
	}

	return queries;
}

/**
 * Build all search query variants for a movie search.
 *
 * @param titles - Array of title variants to search
 * @param year - Release year (optional)
 * @param formatTypes - Movie format types to use
 * @param maxTitles - Maximum number of titles to use (default 3)
 * @returns Array of complete search query strings
 */
export function buildMovieSearchQueries(
	titles: string[],
	year: number | undefined,
	formatTypes: MovieFormatType[] = ['standard'],
	maxTitles: number = 3
): string[] {
	const queries: string[] = [];
	const limitedTitles = titles.slice(0, maxTitles);

	for (const title of limitedTitles) {
		const movieFormats = getMovieFormats(title, year, formatTypes);
		for (const format of movieFormats) {
			if (!queries.includes(format.value)) {
				queries.push(format.value);
			}
		}
	}

	return queries;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Parse search formats from indexer capabilities or settings.
 * Falls back to defaults if not specified.
 *
 * @param formats - Optional search formats from indexer config
 * @returns Normalized search formats with defaults applied
 */
export function normalizeSearchFormats(formats?: Partial<SearchFormats>): Required<SearchFormats> {
	return {
		episode: formats?.episode ?? DEFAULT_SEARCH_FORMATS.episode,
		movie: formats?.movie ?? DEFAULT_SEARCH_FORMATS.movie
	};
}

/**
 * Get the effective episode formats to use for an indexer.
 *
 * An explicit empty list means "this tracker takes no episode token in its
 * query" and is honoured as such: a definition whose topic titles read
 * "Show / Сезон: 1 / Серии: 1-7 из 8" returns zero rows for a `S01` query, and
 * every one of those variants costs a request (a browser launch on a
 * Cloudflare-protected tracker). Only an undefined list falls back, which is
 * what keeps the old behaviour for definitions that never declared anything.
 *
 * @param indexerFormats - Formats from indexer capabilities (optional)
 * @param useAllFormats - Whether to use all formats as fallback (default: true for backwards compat)
 * @returns Array of episode format types to use
 */
export function getEffectiveEpisodeFormats(
	indexerFormats?: EpisodeFormatType[],
	useAllFormats: boolean = true
): EpisodeFormatType[] {
	if (indexerFormats !== undefined) {
		return indexerFormats;
	}
	// Fallback to all common formats for backwards compatibility
	return useAllFormats ? ALL_EPISODE_FORMATS : ['standard'];
}

/**
 * Extract episode format information from search criteria.
 * Utility for components that need to work with episode data.
 */
export function extractEpisodeInfo(
	criteria: SearchCriteria
): { season?: number; episode?: number } | null {
	if (isTvSearch(criteria)) {
		return {
			season: criteria.season,
			episode: criteria.episode
		};
	}
	return null;
}

/**
 * Extract movie format information from search criteria.
 */
export function extractMovieInfo(criteria: SearchCriteria): { year?: number } | null {
	if (isMovieSearch(criteria)) {
		return {
			year: criteria.year
		};
	}
	return null;
}
