/**
 * External ID Resolver
 *
 * Resolves external IDs (IMDB, title+year) to TMDB IDs
 * Uses TMDB's find API and search APIs
 */

import { tmdb } from '#lib/server/tmdb.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'monitoring' as const });

export interface IdResolutionResult {
	/** Resolved TMDB ID */
	tmdbId: number | null;

	/** Title from TMDB (for display) */
	title?: string;

	/** Year from TMDB */
	year?: number;

	/** Poster path from TMDB */
	posterPath?: string | null;

	/** Whether resolution was successful */
	success: boolean;

	/** Error message if resolution failed */
	error?: string;
}

export class ExternalIdResolver {
	/**
	 * Resolve an IMDB ID to a TMDB ID
	 */
	async resolveByImdbId(imdbId: string, mediaType: 'movie' | 'tv'): Promise<IdResolutionResult> {
		logger.info({ imdbId, mediaType }, '[ExternalIdResolver] Resolving IMDB ID');

		try {
			const result = await tmdb.findByExternalId(imdbId, 'imdb_id');

			// Check for movie results
			if (mediaType === 'movie' && result.movie_results.length > 0) {
				const movie = result.movie_results[0];
				logger.info(
					{
						imdbId,
						tmdbId: movie.id,
						title: movie.title
					},
					'[ExternalIdResolver] Resolved IMDB to TMDB (movie)'
				);
				return {
					tmdbId: movie.id,
					title: movie.title,
					year: movie.release_date ? parseInt(movie.release_date.substring(0, 4)) : undefined,
					posterPath: movie.poster_path,
					success: true
				};
			}

			// Check for TV results
			if (mediaType === 'tv' && result.tv_results.length > 0) {
				const show = result.tv_results[0];
				logger.info(
					{
						imdbId,
						tmdbId: show.id,
						title: show.name
					},
					'[ExternalIdResolver] Resolved IMDB to TMDB (TV)'
				);
				return {
					tmdbId: show.id,
					title: show.name,
					year: show.first_air_date ? parseInt(show.first_air_date.substring(0, 4)) : undefined,
					posterPath: show.poster_path,
					success: true
				};
			}

			// Try cross-type lookup (IMDB might be for wrong type)
			if (result.movie_results.length > 0) {
				const movie = result.movie_results[0];
				logger.warn(
					{
						imdbId,
						foundTitle: movie.title
					},
					'[ExternalIdResolver] IMDB resolved to movie but requested TV'
				);
				// Still return it - better than nothing
				return {
					tmdbId: movie.id,
					title: movie.title,
					year: movie.release_date ? parseInt(movie.release_date.substring(0, 4)) : undefined,
					posterPath: movie.poster_path,
					success: true
				};
			}

			if (result.tv_results.length > 0) {
				const show = result.tv_results[0];
				logger.warn(
					{
						imdbId,
						foundTitle: show.name
					},
					'[ExternalIdResolver] IMDB resolved to TV but requested movie'
				);
				return {
					tmdbId: show.id,
					title: show.name,
					year: show.first_air_date ? parseInt(show.first_air_date.substring(0, 4)) : undefined,
					posterPath: show.poster_path,
					success: true
				};
			}

			logger.warn(
				{
					imdbId,
					mediaType,
					movieResultsCount: result.movie_results?.length || 0,
					tvResultsCount: result.tv_results?.length || 0,
					hasMovieResults: result.movie_results && result.movie_results.length > 0,
					hasTvResults: result.tv_results && result.tv_results.length > 0
				},
				'[ExternalIdResolver] IMDB ID not found in TMDB'
			);
			return {
				tmdbId: null,
				success: false,
				error: 'IMDB ID not found in TMDB'
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(
				{
					imdbId,
					error: errorMessage
				},
				'[ExternalIdResolver] Failed to resolve IMDB ID'
			);
			return {
				tmdbId: null,
				success: false,
				error: errorMessage
			};
		}
	}

	/**
	 * Resolve by title and optional year
	 */
	async resolveByTitle(
		title: string,
		year: number | undefined,
		mediaType: 'movie' | 'tv'
	): Promise<IdResolutionResult> {
		logger.info({ title, year, mediaType }, '[ExternalIdResolver] Resolving by title');

		try {
			let searchResult;

			if (mediaType === 'movie') {
				searchResult = await tmdb.searchMovies(title, year, true); // skipFilters=true for accurate search
			} else {
				searchResult = await tmdb.searchTv(title, year, true);
			}

			if (searchResult.results.length === 0) {
				logger.warn({ title, year }, '[ExternalIdResolver] No TMDB results for title');
				return {
					tmdbId: null,
					success: false,
					error: 'No TMDB results found'
				};
			}

			// Take the first result
			const result = searchResult.results[0];
			const resultTitle = mediaType === 'movie' ? result.title : result.name;

			logger.info(
				{
					title,
					foundTitle: resultTitle,
					tmdbId: result.id
				},
				'[ExternalIdResolver] Resolved title to TMDB'
			);

			return {
				tmdbId: result.id,
				title: resultTitle,
				year:
					mediaType === 'movie'
						? result.release_date
							? parseInt(result.release_date.substring(0, 4))
							: undefined
						: result.first_air_date
							? parseInt(result.first_air_date.substring(0, 4))
							: undefined,
				posterPath: result.poster_path,
				success: true
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(
				{
					title,
					year,
					error: errorMessage
				},
				'[ExternalIdResolver] Failed to resolve title'
			);
			return {
				tmdbId: null,
				success: false,
				error: errorMessage
			};
		}
	}

	/**
	 * Resolve an external list item to a full TMDB item
	 * Tries multiple strategies in order:
	 * 1. Use existing TMDB ID if available
	 * 2. Resolve IMDB ID to TMDB ID
	 * 3. Search by title+year
	 */
	async resolveItem(
		item: {
			tmdbId?: number;
			imdbId?: string;
			title: string;
			year?: number;
		},
		mediaType: 'movie' | 'tv'
	): Promise<IdResolutionResult> {
		// Strategy 1: Already have TMDB ID
		if (item.tmdbId) {
			logger.debug(
				{
					tmdbId: item.tmdbId,
					title: item.title
				},
				'[ExternalIdResolver] Item already has TMDB ID'
			);

			// Optionally fetch full details to get poster, etc.
			try {
				if (mediaType === 'movie') {
					const details = await tmdb.getMovie(item.tmdbId);
					return {
						tmdbId: item.tmdbId,
						title: details.title,
						year: details.release_date ? parseInt(details.release_date.substring(0, 4)) : undefined,
						posterPath: details.poster_path,
						success: true
					};
				} else {
					const details = await tmdb.getTVShow(item.tmdbId);
					return {
						tmdbId: item.tmdbId,
						title: details.name,
						year: details.first_air_date
							? parseInt(details.first_air_date.substring(0, 4))
							: undefined,
						posterPath: details.poster_path,
						success: true
					};
				}
			} catch (error) {
				// TMDB ID might be invalid, continue to other strategies
				logger.warn(
					{
						tmdbId: item.tmdbId,
						error: error instanceof Error ? error.message : String(error)
					},
					'[ExternalIdResolver] Failed to fetch details for TMDB ID, trying other methods'
				);
			}
		}

		// Strategy 2: Resolve IMDB ID
		if (item.imdbId) {
			const result = await this.resolveByImdbId(item.imdbId, mediaType);
			if (result.success) {
				return result;
			}
			// IMDB resolution failed, log details and continue to title search
			logger.warn(
				{
					imdbId: item.imdbId,
					title: item.title,
					year: item.year,
					mediaType,
					error: result.error
				},
				'[ExternalIdResolver] IMDB resolution failed, falling back to title search'
			);
		} else {
			logger.warn(
				{
					title: item.title,
					year: item.year,
					mediaType
				},
				'[ExternalIdResolver] No IMDB ID available, using title search'
			);
		}

		// Strategy 3: Search by title+year
		const titleResult = await this.resolveByTitle(item.title, item.year, mediaType);

		if (!titleResult.success) {
			logger.warn(
				{
					title: item.title,
					year: item.year,
					mediaType,
					error: titleResult.error
				},
				'[ExternalIdResolver] Title search also failed'
			);
		}

		return titleResult;
	}

	/**
	 * Resolve multiple external items concurrently with batching
	 * This is much faster than resolving items sequentially
	 *
	 * @param items - Array of items to resolve
	 * @param mediaType - 'movie' or 'tv'
	 * @param concurrency - Number of concurrent requests (default: 10)
	 * @returns Array of resolution results in the same order as input
	 */
	async resolveItemsBatch(
		items: Array<{
			tmdbId?: number;
			imdbId?: string;
			title: string;
			year?: number;
		}>,
		mediaType: 'movie' | 'tv',
		concurrency: number = 10
	): Promise<IdResolutionResult[]> {
		if (items.length === 0) {
			return [];
		}

		logger.info(
			{
				itemCount: items.length,
				mediaType,
				concurrency
			},
			'[ExternalIdResolver] Starting batch resolution'
		);

		const startTime = Date.now();
		const results: IdResolutionResult[] = new Array(items.length);
		let completedCount = 0;
		let successCount = 0;

		// Process items in batches to control concurrency
		for (let i = 0; i < items.length; i += concurrency) {
			const batch = items.slice(i, i + concurrency);
			const batchStartIndex = i;

			// Process batch concurrently
			await Promise.all(
				batch.map(async (item, batchIndex) => {
					const index = batchStartIndex + batchIndex;
					const result = await this.resolveItem(item, mediaType);
					results[index] = result;

					completedCount++;
					if (result.success) {
						successCount++;
					}

					// Log progress every 50 items
					if (completedCount % 50 === 0 || completedCount === items.length) {
						logger.info(
							{
								completed: completedCount,
								total: items.length,
								successful: successCount,
								progress: `${Math.round((completedCount / items.length) * 100)}%`
							},
							'[ExternalIdResolver] Batch progress'
						);
					}
				})
			);
		}

		const duration = Date.now() - startTime;
		logger.info(
			{
				total: items.length,
				successful: successCount,
				failed: items.length - successCount,
				durationMs: duration,
				avgMsPerItem: Math.round(duration / items.length)
			},
			'[ExternalIdResolver] Batch resolution complete'
		);

		return results;
	}
}

// Singleton instance
export const externalIdResolver = new ExternalIdResolver();
