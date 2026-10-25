/**
 * TMDB Matcher
 *
 * Matches parsed releases to TMDB entries using fuzzy title matching
 * and external ID caching
 */

import type { ParsedRelease } from '../indexers/parser/types.js';
import { extractExternalIds } from '../indexers/parser/ReleaseParser.js';
import { tmdb } from '../tmdb.js';
import { db } from '../db/index.js';
import { externalIdCache } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });

/**
 * TMDB match result
 */
export interface TmdbMatch {
	tmdbId: number;
	title: string;
	originalTitle?: string;
	year?: number;
	mediaType: 'movie' | 'tv';
	posterPath?: string;
	overview?: string;
	confidence: number; // 0-1
}

/**
 * Hint for TMDB matching (when caller already knows the target)
 */
export interface TmdbHint {
	tmdbId?: number;
	imdbId?: string;
	tvdbId?: number;
	title?: string;
	year?: number;
	mediaType: 'movie' | 'tv';
}

/**
 * TmdbMatcher - Match releases to TMDB entries
 */
export class TmdbMatcher {
	// Cache expiry in milliseconds (24 hours)
	private readonly CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000;

	/**
	 * Match a parsed release to a TMDB entry
	 *
	 * Matching priority:
	 * 1. TMDB ID from hint
	 * 2. IMDB ID from hint
	 * 3. TVDB ID from hint
	 * 4. TMDB ID extracted from release title
	 * 5. TVDB ID extracted from release title
	 * 6. IMDB ID extracted from release title
	 * 7. Title search with fuzzy matching
	 */
	async match(parsed: ParsedRelease, hint?: TmdbHint): Promise<TmdbMatch | null> {
		const mediaType = parsed.episode ? 'tv' : (hint?.mediaType ?? 'movie');

		// If we have a TMDB ID hint, use it directly (with year validation)
		if (hint?.tmdbId) {
			const result = await this.getMatchById(hint.tmdbId, hint.mediaType);
			if (result && this.isYearValid(parsed.year, result.year)) {
				logger.debug(
					{
						tmdbId: hint.tmdbId,
						title: result.title,
						releaseYear: parsed.year,
						movieYear: result.year
					},
					'[TmdbMatcher] Matched via TMDB ID hint with year validation'
				);
				return result;
			}
			// Year mismatch - fall back to title search to find correct movie
			logger.debug(
				{
					tmdbId: hint.tmdbId,
					hintTitle: result?.title,
					releaseYear: parsed.year,
					hintYear: result?.year,
					release: parsed.originalTitle
				},
				'[TmdbMatcher] TMDB ID hint rejected due to year mismatch, falling back to title search'
			);
		}

		// If we have an IMDB ID hint, find by external ID (with year validation)
		if (hint?.imdbId) {
			const result = await this.findByImdbId(hint.imdbId);
			if (result && this.isYearValid(parsed.year, result.year)) {
				logger.debug(
					{
						imdbId: hint.imdbId,
						tmdbId: result.tmdbId,
						title: result.title,
						releaseYear: parsed.year,
						movieYear: result.year
					},
					'[TmdbMatcher] Matched via IMDB ID hint with year validation'
				);
				return result;
			}
			if (result) {
				logger.debug(
					{
						imdbId: hint.imdbId,
						releaseYear: parsed.year,
						movieYear: result.year
					},
					'[TmdbMatcher] IMDB ID hint rejected due to year mismatch, falling back to title search'
				);
			}
		}

		// If we have a TVDB ID hint, find by external ID (TV shows don't have year validation)
		if (hint?.tvdbId) {
			const result = await this.findByTvdbId(hint.tvdbId);
			if (result) return result;
		}

		// Check for external IDs embedded in the raw release title
		// This handles releases with naming like "Show.Name.{tvdb-12345}.S01E01.mkv"
		const extractedIds = extractExternalIds(parsed.originalTitle);

		if (extractedIds.tmdbId) {
			const result = await this.getMatchById(extractedIds.tmdbId, mediaType);
			if (result) {
				logger.debug(
					{
						tmdbId: extractedIds.tmdbId,
						title: result.title,
						release: parsed.originalTitle
					},
					'[TmdbMatcher] Matched via TMDB ID in release title'
				);
				return result;
			}
		}

		if (extractedIds.tvdbId) {
			const result = await this.findByTvdbId(extractedIds.tvdbId);
			if (result) {
				logger.debug(
					{
						tvdbId: extractedIds.tvdbId,
						tmdbId: result.tmdbId,
						title: result.title,
						release: parsed.originalTitle
					},
					'[TmdbMatcher] Matched via TVDB ID in release title'
				);
				return result;
			}
		}

		if (extractedIds.imdbId) {
			const result = await this.findByImdbId(extractedIds.imdbId);
			if (result) {
				logger.debug(
					{
						imdbId: extractedIds.imdbId,
						tmdbId: result.tmdbId,
						title: result.title,
						release: parsed.originalTitle
					},
					'[TmdbMatcher] Matched via IMDB ID in release title'
				);
				return result;
			}
		}

		// Fall back to title search
		return this.searchByTitle(parsed.cleanTitle, parsed.year, mediaType);
	}

	/**
	 * Validate that the release year matches the movie year.
	 * Following Radarr's approach: if years don't match, it's likely the wrong movie.
	 *
	 * @param releaseYear - Year parsed from the release title (undefined if not found)
	 * @param movieYear - Year from TMDB for the hinted movie
	 * @returns true if years are compatible (match within 1 year or no year parsed)
	 */
	private isYearValid(releaseYear: number | undefined, movieYear: number | undefined): boolean {
		// If no year parsed from release, accept (can't validate)
		if (!releaseYear) {
			return true;
		}

		// If no movie year, accept (can't validate)
		if (!movieYear) {
			return true;
		}

		// Accept if years match exactly or are within 1 year
		// (allows for release year vs production year differences)
		const yearDiff = Math.abs(releaseYear - movieYear);
		return yearDiff <= 1;
	}

	/**
	 * Get TMDB match by ID
	 */
	private async getMatchById(tmdbId: number, mediaType: 'movie' | 'tv'): Promise<TmdbMatch | null> {
		try {
			if (mediaType === 'movie') {
				const movie = await tmdb.getMovie(tmdbId);
				return {
					tmdbId: movie.id,
					title: movie.title,
					originalTitle: movie.original_title,
					year: movie.release_date ? parseInt(movie.release_date.slice(0, 4)) : undefined,
					mediaType: 'movie',
					posterPath: movie.poster_path ?? undefined,
					overview: movie.overview,
					confidence: 1.0
				};
			} else {
				const show = await tmdb.getTVShow(tmdbId);
				return {
					tmdbId: show.id,
					title: show.name,
					originalTitle: show.original_name,
					year: show.first_air_date ? parseInt(show.first_air_date.slice(0, 4)) : undefined,
					mediaType: 'tv',
					posterPath: show.poster_path ?? undefined,
					overview: show.overview,
					confidence: 1.0
				};
			}
		} catch (error) {
			logger.error(
				{ err: error, ...{ mediaType, tmdbId } },
				`Failed to get TMDB ${mediaType} ${tmdbId}`
			);
			return null;
		}
	}

	/**
	 * Find by IMDB ID
	 */
	private async findByImdbId(imdbId: string): Promise<TmdbMatch | null> {
		try {
			const result = await tmdb.findByExternalId(imdbId, 'imdb_id');

			if (result.movie_results.length > 0) {
				const movie = result.movie_results[0];
				return {
					tmdbId: movie.id,
					title: movie.title,
					originalTitle: movie.original_title,
					year: movie.release_date ? parseInt(movie.release_date.slice(0, 4)) : undefined,
					mediaType: 'movie',
					posterPath: movie.poster_path ?? undefined,
					overview: movie.overview,
					confidence: 1.0
				};
			}

			if (result.tv_results.length > 0) {
				const show = result.tv_results[0];
				return {
					tmdbId: show.id,
					title: show.name,
					originalTitle: show.original_name,
					year: show.first_air_date ? parseInt(show.first_air_date.slice(0, 4)) : undefined,
					mediaType: 'tv',
					posterPath: show.poster_path ?? undefined,
					overview: show.overview,
					confidence: 1.0
				};
			}

			return null;
		} catch (error) {
			logger.error({ err: error, ...{ imdbId } }, `Failed to find by IMDB ID ${imdbId}`);
			return null;
		}
	}

	/**
	 * Find by TVDB ID
	 */
	private async findByTvdbId(tvdbId: number): Promise<TmdbMatch | null> {
		try {
			const result = await tmdb.findByExternalId(String(tvdbId), 'tvdb_id');

			if (result.tv_results.length > 0) {
				const show = result.tv_results[0];
				return {
					tmdbId: show.id,
					title: show.name,
					originalTitle: show.original_name,
					year: show.first_air_date ? parseInt(show.first_air_date.slice(0, 4)) : undefined,
					mediaType: 'tv',
					posterPath: show.poster_path ?? undefined,
					overview: show.overview,
					confidence: 1.0
				};
			}

			return null;
		} catch (error) {
			logger.error({ err: error, ...{ tvdbId } }, `Failed to find by TVDB ID ${tvdbId}`);
			return null;
		}
	}

	/**
	 * Search by title with fuzzy matching
	 */
	private async searchByTitle(
		title: string,
		year: number | undefined,
		mediaType: 'movie' | 'tv'
	): Promise<TmdbMatch | null> {
		try {
			const searchFn = mediaType === 'movie' ? tmdb.searchMovies : tmdb.searchTv;
			const result = await searchFn.call(tmdb, title, year);

			if (result.results.length === 0) {
				// Try again without year
				if (year) {
					const resultNoYear = await searchFn.call(tmdb, title);
					if (resultNoYear.results.length === 0) {
						return null;
					}
					return this.findBestMatch(resultNoYear.results, title, year, mediaType);
				}
				return null;
			}

			return this.findBestMatch(result.results, title, year, mediaType);
		} catch (error) {
			logger.error(
				{ err: error, ...{ title, year, mediaType } },
				`Failed to search for "${title}"`
			);
			return null;
		}
	}

	/**
	 * Find the best match from search results using fuzzy matching
	 */
	private findBestMatch(
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
		}>,
		searchTitle: string,
		searchYear: number | undefined,
		mediaType: 'movie' | 'tv'
	): TmdbMatch | null {
		let bestMatch: TmdbMatch | null = null;
		let bestScore = 0;

		for (const item of results) {
			const itemTitle = item.title ?? item.name ?? '';
			const itemOriginalTitle = item.original_title ?? item.original_name;
			const itemDate = item.release_date ?? item.first_air_date;
			const itemYear = itemDate ? parseInt(itemDate.slice(0, 4)) : undefined;

			// Calculate title similarity
			const titleSim = this.titleSimilarity(searchTitle, itemTitle);
			const originalTitleSim = itemOriginalTitle
				? this.titleSimilarity(searchTitle, itemOriginalTitle)
				: 0;
			const maxTitleSim = Math.max(titleSim, originalTitleSim);

			// Year matching bonus
			let yearBonus = 0;
			if (searchYear && itemYear) {
				if (searchYear === itemYear) {
					yearBonus = 0.2;
				} else if (Math.abs(searchYear - itemYear) <= 1) {
					yearBonus = 0.1;
				}
			}

			const totalScore = maxTitleSim * 0.8 + yearBonus;

			if (totalScore > bestScore && totalScore > 0.5) {
				bestScore = totalScore;
				bestMatch = {
					tmdbId: item.id,
					title: itemTitle,
					originalTitle: itemOriginalTitle,
					year: itemYear,
					mediaType,
					posterPath: item.poster_path ?? undefined,
					overview: item.overview,
					confidence: Math.min(1, totalScore)
				};
			}
		}

		return bestMatch;
	}

	/**
	 * Calculate title similarity (0-1)
	 * Uses normalized Levenshtein distance
	 */
	titleSimilarity(a: string, b: string): number {
		const normalizedA = this.normalizeTitle(a);
		const normalizedB = this.normalizeTitle(b);

		if (normalizedA === normalizedB) {
			return 1.0;
		}

		const distance = this.levenshteinDistance(normalizedA, normalizedB);
		const maxLength = Math.max(normalizedA.length, normalizedB.length);

		if (maxLength === 0) return 1.0;

		return 1 - distance / maxLength;
	}

	/**
	 * Normalize a title for comparison
	 */
	private normalizeTitle(title: string): string {
		return title
			.toLowerCase()
			.replace(/[^\w\s]/g, '') // Remove punctuation
			.replace(/\s+/g, ' ') // Normalize whitespace
			.trim();
	}

	/**
	 * Calculate Levenshtein distance between two strings
	 */
	private levenshteinDistance(a: string, b: string): number {
		const matrix: number[][] = [];

		for (let i = 0; i <= b.length; i++) {
			matrix[i] = [i];
		}

		for (let j = 0; j <= a.length; j++) {
			matrix[0][j] = j;
		}

		for (let i = 1; i <= b.length; i++) {
			for (let j = 1; j <= a.length; j++) {
				if (b.charAt(i - 1) === a.charAt(j - 1)) {
					matrix[i][j] = matrix[i - 1][j - 1];
				} else {
					matrix[i][j] = Math.min(
						matrix[i - 1][j - 1] + 1, // substitution
						matrix[i][j - 1] + 1, // insertion
						matrix[i - 1][j] + 1 // deletion
					);
				}
			}
		}

		return matrix[b.length][a.length];
	}

	/**
	 * Get cached external IDs for a TMDB entry
	 */
	async getCachedExternalIds(
		tmdbId: number,
		mediaType: 'movie' | 'tv'
	): Promise<{ imdbId: string | null; tvdbId: number | null } | null> {
		const cached = await db
			.select()
			.from(externalIdCache)
			.where(and(eq(externalIdCache.tmdbId, tmdbId), eq(externalIdCache.mediaType, mediaType)))
			.get();

		if (!cached) return null;

		// Check if cache is expired
		const cachedAt = new Date(cached.cachedAt ?? 0).getTime();
		if (Date.now() - cachedAt > this.CACHE_EXPIRY_MS) {
			return null;
		}

		return {
			imdbId: cached.imdbId,
			tvdbId: cached.tvdbId
		};
	}

	/**
	 * Get external IDs for a TMDB entry (with caching)
	 */
	async getExternalIds(
		tmdbId: number,
		mediaType: 'movie' | 'tv'
	): Promise<{ imdbId: string | null; tvdbId: number | null }> {
		// Check cache first
		const cached = await this.getCachedExternalIds(tmdbId, mediaType);
		if (cached) return cached;

		// Fetch from TMDB
		try {
			const externalIds =
				mediaType === 'movie'
					? await tmdb.getMovieExternalIds(tmdbId)
					: await tmdb.getTvExternalIds(tmdbId);

			// Cache the result
			await db
				.insert(externalIdCache)
				.values({
					tmdbId,
					mediaType,
					imdbId: externalIds.imdb_id,
					tvdbId: externalIds.tvdb_id
				})
				.onConflictDoUpdate({
					target: [externalIdCache.tmdbId, externalIdCache.mediaType],
					set: {
						imdbId: externalIds.imdb_id,
						tvdbId: externalIds.tvdb_id,
						cachedAt: new Date().toISOString()
					}
				});

			return {
				imdbId: externalIds.imdb_id,
				tvdbId: externalIds.tvdb_id
			};
		} catch (error) {
			logger.error(
				{
					err: error,
					...{
						mediaType,
						tmdbId
					}
				},
				`Failed to get external IDs for ${mediaType} ${tmdbId}`
			);
			return { imdbId: null, tvdbId: null };
		}
	}
}

/**
 * Singleton instance
 */
export const tmdbMatcher = new TmdbMatcher();
