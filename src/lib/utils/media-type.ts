/**
 * Media Type Utilities
 *
 * Canonical media type is 'movie' | 'tv' - used in routes, DB, TMDB, and all server code.
 * This module centralizes the derived mappings so components don't duplicate conversion logic.
 */

/** Canonical media type used throughout the application */
export type MediaType = 'movie' | 'tv';

/**
 * Get the API path segment for a media type.
 * Routes use 'movie'/'tv', but API endpoints use 'movies'/'series'.
 *
 * @example mediaTypeApiSegment('movie')  // 'movies'
 * @example mediaTypeApiSegment('tv')     // 'series'
 */
export function mediaTypeApiSegment(type: MediaType): 'movies' | 'series' {
	return type === 'movie' ? 'movies' : 'series';
}

/**
 * Get the singular display label for a media type.
 *
 * @example mediaTypeLabel('movie')  // 'movie'
 * @example mediaTypeLabel('tv')     // 'series'
 */
export function mediaTypeLabel(type: MediaType): string {
	return type === 'movie' ? 'movie' : 'series';
}

/**
 * Get a count-aware display label (singular or plural).
 *
 * @example mediaTypeCountLabel('movie', 1)  // 'movie'
 * @example mediaTypeCountLabel('movie', 3)  // 'movies'
 * @example mediaTypeCountLabel('tv', 1)     // 'series'
 * @example mediaTypeCountLabel('tv', 5)     // 'series'
 */
export function mediaTypeCountLabel(type: MediaType, count: number): string {
	if (type === 'movie') {
		return count === 1 ? 'movie' : 'movies';
	}
	return 'series';
}
