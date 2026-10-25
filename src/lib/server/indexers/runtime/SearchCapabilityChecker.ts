/**
 * SearchCapabilityChecker - Single source of truth for canSearch() logic.
 *
 * Uses Prowlarr-style strict checking:
 * - If criteria has IDs (IMDB, TMDB, etc.), indexer MUST support those IDs
 * - NO fallback to text search - prevents garbage results
 */

import type { IndexerCapabilities, SearchCriteria, SearchType } from '../types';
import {
	canHandleSearchType,
	supportsParam,
	isMovieSearch,
	isTvSearch,
	indexerHasCategoriesForSearchType,
	restrictionAllowsSearchType
} from '../types';

/**
 * Checks whether an indexer can handle given search criteria.
 * Implements Prowlarr-style strict checking to prevent garbage results.
 */
export class SearchCapabilityChecker {
	/**
	 * Check if an indexer can handle the given search criteria.
	 *
	 * @param criteria - The search criteria to check
	 * @param capabilities - The indexer's capabilities
	 * @returns true if the indexer can handle this search
	 */
	canSearch(
		criteria: SearchCriteria,
		capabilities: IndexerCapabilities,
		categoryRestriction?: number[]
	): boolean {
		const searchType = criteria.searchType as SearchType;

		// First check: Does the indexer have categories that match this search type?
		// This is the primary filter - if an indexer only has TV categories (5xxx),
		// it shouldn't be used for movie searches, regardless of capabilities.
		if (searchType !== 'basic') {
			const hasMatchingCategories = indexerHasCategoriesForSearchType(
				capabilities.categories,
				searchType
			);
			if (!hasMatchingCategories) {
				return false;
			}

			// The indexer's own declared capabilities are necessary but not
			// sufficient: a user may have restricted this specific instance to a
			// narrower set of categories (e.g. "Movies only") than what the
			// indexer natively supports. That restriction only ever fed into the
			// outgoing cat= parameter before, never into eligibility - so a TV
			// search would still fire against a Movies-restricted indexer.
			if (!restrictionAllowsSearchType(categoryRestriction, searchType)) {
				return false;
			}
		}

		// Second check: Does the indexer support this search type capability?
		if (!canHandleSearchType(capabilities, searchType)) {
			return false;
		}

		// Third check (Prowlarr-style): If criteria has IDs, indexer must support
		// AT LEAST ONE of them. No fallback to text search for ID-based searches.
		// This prevents indexers with broken text search from returning garbage.
		if (isMovieSearch(criteria)) {
			const hasAnyId = criteria.imdbId || criteria.tmdbId;
			if (hasAnyId) {
				const supportsAnyProvidedId =
					(criteria.imdbId && supportsParam(capabilities, 'movie', 'imdbId')) ||
					(criteria.tmdbId && supportsParam(capabilities, 'movie', 'tmdbId'));

				if (!supportsAnyProvidedId) {
					return false;
				}
			}
		}

		if (isTvSearch(criteria)) {
			const hasAnyId = criteria.imdbId || criteria.tmdbId || criteria.tvdbId || criteria.tvMazeId;
			if (hasAnyId) {
				const supportsAnyProvidedId =
					(criteria.imdbId && supportsParam(capabilities, 'tv', 'imdbId')) ||
					(criteria.tmdbId && supportsParam(capabilities, 'tv', 'tmdbId')) ||
					(criteria.tvdbId && supportsParam(capabilities, 'tv', 'tvdbId')) ||
					(criteria.tvMazeId && supportsParam(capabilities, 'tv', 'tvMazeId'));

				if (!supportsAnyProvidedId) {
					return false;
				}
			}
		}

		return true;
	}

	/**
	 * Check if an indexer can handle the given search criteria, with detailed reason for rejection.
	 * Useful for debugging why indexers are being filtered out.
	 *
	 * @param criteria - The search criteria to check
	 * @param capabilities - The indexer's capabilities
	 * @returns Object with canSearch boolean and optional reason string
	 */
	canSearchWithReason(
		criteria: SearchCriteria,
		capabilities: IndexerCapabilities,
		categoryRestriction?: number[]
	): { canSearch: boolean; reason?: string } {
		const searchType = criteria.searchType as SearchType;

		// First check: Does the indexer have categories that match this search type?
		if (searchType !== 'basic') {
			const hasMatchingCategories = indexerHasCategoriesForSearchType(
				capabilities.categories,
				searchType
			);
			if (!hasMatchingCategories) {
				return {
					canSearch: false,
					reason: `No ${searchType} categories (indexer has: ${Array.from(capabilities.categories.keys()).join(', ')})`
				};
			}

			if (!restrictionAllowsSearchType(categoryRestriction, searchType)) {
				return {
					canSearch: false,
					reason: `Indexer is restricted to categories [${categoryRestriction?.join(', ')}], which don't include ${searchType}`
				};
			}
		}

		// Second check: Does the indexer support this search type capability?
		if (!canHandleSearchType(capabilities, searchType)) {
			return {
				canSearch: false,
				reason: `Search mode '${searchType}' not available`
			};
		}

		// Third check: ID support for movie searches
		if (isMovieSearch(criteria)) {
			const hasAnyId = criteria.imdbId || criteria.tmdbId;
			if (hasAnyId) {
				const supportsAnyProvidedId =
					(criteria.imdbId && supportsParam(capabilities, 'movie', 'imdbId')) ||
					(criteria.tmdbId && supportsParam(capabilities, 'movie', 'tmdbId'));

				if (!supportsAnyProvidedId) {
					const providedIds = [criteria.imdbId && 'imdbId', criteria.tmdbId && 'tmdbId'].filter(
						Boolean
					);
					const supportedParams = capabilities.movieSearch?.supportedParams || [];
					return {
						canSearch: false,
						reason: `Movie search has IDs [${providedIds.join(', ')}] but indexer only supports [${supportedParams.join(', ')}]`
					};
				}
			}
		}

		// Third check: ID support for TV searches
		if (isTvSearch(criteria)) {
			const hasAnyId = criteria.imdbId || criteria.tmdbId || criteria.tvdbId || criteria.tvMazeId;
			if (hasAnyId) {
				const supportsAnyProvidedId =
					(criteria.imdbId && supportsParam(capabilities, 'tv', 'imdbId')) ||
					(criteria.tmdbId && supportsParam(capabilities, 'tv', 'tmdbId')) ||
					(criteria.tvdbId && supportsParam(capabilities, 'tv', 'tvdbId')) ||
					(criteria.tvMazeId && supportsParam(capabilities, 'tv', 'tvMazeId'));

				if (!supportsAnyProvidedId) {
					const providedIds = [
						criteria.imdbId && 'imdbId',
						criteria.tmdbId && 'tmdbId',
						criteria.tvdbId && 'tvdbId',
						criteria.tvMazeId && 'tvMazeId'
					].filter(Boolean);
					const supportedParams = capabilities.tvSearch?.supportedParams || [];
					return {
						canSearch: false,
						reason: `TV search has IDs [${providedIds.join(', ')}] but indexer only supports [${supportedParams.join(', ')}]`
					};
				}
			}
		}

		return { canSearch: true };
	}
}
