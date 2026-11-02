/**
 * JSON List Provider
 *
 * Fetches and parses external JSON lists (like movies.stevenlu.com)
 * Supports multiple JSON formats:
 * - StevenLu format: [{ tmdb_id, imdb_id, title, poster_url, genres }]
 * - TMDB ID array: [123, 456, 789]
 * - IMDB ID array: ["tt123", "tt456"]
 * - Mixed format with minimal data: [{ imdb_id, title }]
 */

import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'monitoring' as const });
import type {
	ExternalListProvider,
	ExternalListItem,
	ExternalListResult,
	ExternalJsonConfig
} from './types.js';

export class JsonListProvider implements ExternalListProvider {
	readonly type = 'external-json';
	readonly name = 'External JSON URL';

	validateConfig(config: unknown): boolean {
		if (typeof config !== 'object' || config === null) {
			return false;
		}

		const cfg = config as Partial<ExternalJsonConfig>;
		return typeof cfg.url === 'string' && cfg.url.length > 0;
	}

	async fetchItems(config: unknown, mediaType: 'movie' | 'tv' | ''): Promise<ExternalListResult> {
		const cfg = config as ExternalJsonConfig;

		logger.info(
			{
				url: cfg.url,
				mediaType: mediaType || 'all'
			},
			'[JsonListProvider] Fetching external JSON list'
		);

		try {
			// Fetch the JSON data
			const response = await fetch(cfg.url, {
				headers: cfg.headers || {},
				signal: AbortSignal.timeout(30000) // 30 second timeout
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const data = await response.json();

			if (!Array.isArray(data)) {
				throw new Error('Expected JSON array, got ' + typeof data);
			}

			logger.info(
				{
					itemCount: data.length,
					url: cfg.url
				},
				'[JsonListProvider] Parsed JSON data'
			);

			// Parse items from various formats
			const items: ExternalListItem[] = [];
			let failedCount = 0;

			for (let i = 0; i < data.length; i++) {
				const rawItem = data[i];
				try {
					const item = this.parseItem(rawItem, i);
					if (item) {
						items.push(item);
					} else {
						failedCount++;
						logger.warn(
							{
								index: i,
								rawItem,
								url: cfg.url
							},
							'[JsonListProvider] Failed to parse item'
						);
					}
				} catch (error) {
					failedCount++;
					logger.warn(
						{
							index: i,
							rawItem,
							error: error instanceof Error ? error.message : String(error),
							url: cfg.url
						},
						'[JsonListProvider] Error parsing item'
					);
				}
			}

			logger.info(
				{
					successCount: items.length,
					failedCount,
					totalCount: data.length,
					url: cfg.url
				},
				'[JsonListProvider] Successfully parsed items'
			);

			return {
				items,
				totalCount: data.length,
				failedCount
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(
				{
					error: errorMessage,
					url: cfg.url
				},
				'[JsonListProvider] Failed to fetch external list'
			);

			return {
				items: [],
				totalCount: 0,
				failedCount: 0,
				error: errorMessage
			};
		}
	}

	/**
	 * Parse a single item from various possible formats
	 */
	private parseItem(rawItem: unknown, index: number): ExternalListItem | null {
		// Handle simple number (TMDB ID)
		if (typeof rawItem === 'number') {
			return {
				tmdbId: rawItem,
				title: `TMDB ${rawItem}`
			};
		}

		// Handle simple string (IMDB ID or title)
		if (typeof rawItem === 'string') {
			// Check if it's an IMDB ID
			if (rawItem.match(/^tt\d+$/i)) {
				return {
					imdbId: rawItem,
					title: rawItem
				};
			}
			// Treat as title
			return {
				title: rawItem
			};
		}

		// Handle object format
		if (typeof rawItem === 'object' && rawItem !== null) {
			const obj = rawItem as Record<string, unknown>;

			// Extract TMDB ID (handle various field names)
			let tmdbId: number | undefined;
			if (typeof obj.tmdb_id === 'number') {
				tmdbId = obj.tmdb_id;
			} else if (typeof obj.tmdbId === 'number') {
				tmdbId = obj.tmdbId;
			} else if (typeof obj.id === 'number') {
				tmdbId = obj.id;
			}

			// Extract IMDB ID
			let imdbId: string | undefined;
			if (typeof obj.imdb_id === 'string') {
				imdbId = obj.imdb_id;
			} else if (typeof obj.imdbId === 'string') {
				imdbId = obj.imdbId;
			}

			// Extract title (required)
			let title: string | undefined;
			if (typeof obj.title === 'string') {
				title = obj.title;
			} else if (typeof obj.name === 'string') {
				title = obj.name;
			}

			// If we have a TMDB ID or IMDB ID but no title, use the ID as title temporarily
			if (!title) {
				if (tmdbId) {
					title = `TMDB ${tmdbId}`;
				} else if (imdbId) {
					title = imdbId;
				} else {
					// No identifier at all - can't process this item
					logger.warn({ index, rawItem }, '[JsonListProvider] Item missing all identifiers');
					return null;
				}
			}

			// Extract year
			let year: number | undefined;
			if (typeof obj.year === 'number') {
				year = obj.year;
			} else if (typeof obj.release_year === 'number') {
				year = obj.release_year;
			}

			// Extract poster path
			let posterPath: string | null = null;
			if (typeof obj.poster_url === 'string') {
				posterPath = this.extractPosterPath(obj.poster_url);
			} else if (typeof obj.posterPath === 'string') {
				posterPath = obj.posterPath;
			} else if (typeof obj.poster_path === 'string') {
				posterPath = obj.poster_path;
			}

			// Extract overview
			const overview = typeof obj.overview === 'string' ? obj.overview : undefined;

			// Extract rating
			let voteAverage: number | undefined;
			if (typeof obj.vote_average === 'number') {
				voteAverage = obj.vote_average;
			} else if (typeof obj.rating === 'number') {
				voteAverage = obj.rating;
			}

			// Extract vote count
			let voteCount: number | undefined;
			if (typeof obj.vote_count === 'number') {
				voteCount = obj.vote_count;
			}

			// Extract genres
			let genreIds: number[] | undefined;
			if (Array.isArray(obj.genre_ids)) {
				genreIds = obj.genre_ids.filter((g): g is number => typeof g === 'number');
			} else if (Array.isArray(obj.genres)) {
				// If genres are strings, we'll skip them (would need mapping to IDs)
				// If they're numbers, use them
				if (obj.genres.length > 0 && typeof obj.genres[0] === 'number') {
					genreIds = obj.genres.filter((g): g is number => typeof g === 'number');
				}
			}

			return {
				tmdbId,
				imdbId,
				title,
				year,
				posterPath,
				overview,
				voteAverage,
				voteCount,
				genreIds
			};
		}

		return null;
	}

	/**
	 * Extract TMDB poster path from a full URL
	 * e.g., "http://image.tmdb.org/t/p/w500/abc123.jpg" → "/abc123.jpg"
	 */
	private extractPosterPath(url: string): string {
		// Try to extract the path after the size indicator
		const match = url.match(/\/t\/p\/\w+(\/.*)$/);
		if (match) {
			return match[1];
		}

		// If it's already a path, return as-is
		if (url.startsWith('/')) {
			return url;
		}

		// Return full URL as fallback
		return url;
	}
}
