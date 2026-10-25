import { tmdb } from '#lib/server/tmdb.js';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { createChildLogger } from '#lib/logging/index.js';

import {
	enrichWithLibraryStatus,
	getLibraryStatus,
	filterBlockedMedia,
	getRequestStateMap
} from '#lib/server/library/status.js';
import { keywordBlocklistService } from '#lib/server/settings/KeywordBlocklistService.js';
import { enrichWithReleaseDates } from '#lib/server/release-enrichment.js';

const logger = createChildLogger({ module: 'DiscoverMoviePage', logDomain: 'system' });

export const load: PageServerLoad = async ({ params, locals }) => {
	const id = parseInt(params.id);
	if (isNaN(id)) {
		throw error(400, 'Invalid movie ID');
	}

	// Check if TMDB is configured
	const tmdbConfigured = await tmdb.isConfigured();
	if (!tmdbConfigured) {
		throw error(
			503,
			'TMDB API key not configured. Please configure your TMDB API key in Settings > Integrations.'
		);
	}

	try {
		const movie = await tmdb.getMovie(id);

		// Handle null response (shouldn't happen since we checked config, but be safe)
		if (!movie) {
			throw error(
				503,
				'TMDB API key not configured. Please configure your TMDB API key in Settings > Integrations.'
			);
		}

		const blockedKeywordIds = await keywordBlocklistService.getBlockedKeywordIds();
		const movieKeywords: { id: number; name: string }[] = movie.keywords?.keywords ?? [];
		const blockedMatches = movieKeywords.filter((k) => blockedKeywordIds.includes(k.id));
		const hasBlockedKeywords = blockedMatches.length > 0;

		let collection = null;

		if (movie.belongs_to_collection) {
			try {
				collection = await tmdb.getCollection(movie.belongs_to_collection.id);
			} catch (e) {
				logger.error(
					{
						err: e,
						...{
							collectionId: movie.belongs_to_collection.id
						}
					},
					'Failed to fetch collection'
				);
			}
		}

		// Get library status for the movie itself
		const movieStatus = await getLibraryStatus([id], 'movie');
		const requestState =
			(await getRequestStateMap([id], 'movie', locals.user?.id ?? null))[id] ?? null;
		const movieWithStatus = {
			...movie,
			inLibrary: movieStatus[id]?.inLibrary ?? false,
			hasFile: movieStatus[id]?.hasFile ?? false,
			libraryId: movieStatus[id]?.libraryId
		};

		// Enrich recommendations, similar, and collection with library status
		const [enrichedRecommendations, enrichedSimilar, enrichedCollection] = await Promise.all([
			movie.recommendations?.results
				? enrichWithLibraryStatus(movie.recommendations.results, 'movie')
				: Promise.resolve([]),
			movie.similar?.results
				? enrichWithLibraryStatus(movie.similar.results, 'movie')
				: Promise.resolve([]),
			collection?.parts ? enrichWithLibraryStatus(collection.parts, 'movie') : Promise.resolve(null)
		]);

		const [filteredRecommendations, filteredSimilar, filteredCollection] = await Promise.all([
			filterBlockedMedia(enrichedRecommendations, 'movie'),
			filterBlockedMedia(enrichedSimilar, 'movie'),
			enrichedCollection ? filterBlockedMedia(enrichedCollection, 'movie') : Promise.resolve(null)
		]);

		const [releaseEnrichedRecommendations, releaseEnrichedSimilar, releaseEnrichedCollection] =
			await Promise.all([
				enrichWithReleaseDates(filteredRecommendations),
				enrichWithReleaseDates(filteredSimilar),
				filteredCollection ? enrichWithReleaseDates(filteredCollection) : Promise.resolve(null)
			]);

		// Update movie object with enriched data
		if (movieWithStatus.recommendations) {
			movieWithStatus.recommendations = {
				...movieWithStatus.recommendations,
				results: releaseEnrichedRecommendations
			};
		}
		if (movieWithStatus.similar) {
			movieWithStatus.similar = {
				...movieWithStatus.similar,
				results: releaseEnrichedSimilar
			};
		}

		// Update collection with enriched parts
		const enrichedCollectionData =
			collection && releaseEnrichedCollection
				? {
						...collection,
						parts: releaseEnrichedCollection
					}
				: null;

		return {
			movie: movieWithStatus,
			collection: enrichedCollectionData,
			requestState,
			hasBlockedKeywords,
			blockedKeywords: blockedMatches.map((k) => k.name)
		};
	} catch (e) {
		logger.error({ err: e, ...{ movieId: id } }, 'Failed to fetch movie');
		throw error(404, 'Movie not found');
	}
};
