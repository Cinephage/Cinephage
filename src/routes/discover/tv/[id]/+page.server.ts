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

const logger = createChildLogger({ module: 'DiscoverTvPage', logDomain: 'system' });

export const load: PageServerLoad = async ({ params, locals }) => {
	const id = parseInt(params.id);
	if (isNaN(id)) {
		throw error(400, 'Invalid TV Show ID');
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
		const tv = await tmdb.getTVShow(id);

		// Handle null response (shouldn't happen since we checked config, but be safe)
		if (!tv) {
			throw error(
				503,
				'TMDB API key not configured. Please configure your TMDB API key in Settings > Integrations.'
			);
		}

		const blockedKeywordIds = await keywordBlocklistService.getBlockedKeywordIds();
		const tvKeywords: { id: number; name: string }[] = tv.keywords?.results ?? [];
		const blockedMatches = tvKeywords.filter((k) => blockedKeywordIds.includes(k.id));
		const hasBlockedKeywords = blockedMatches.length > 0;

		// Get library status for the TV show itself
		const tvStatus = await getLibraryStatus([id], 'tv');
		const requestState =
			(await getRequestStateMap([id], 'tv', locals.user?.id ?? null))[id] ?? null;
		const tvWithStatus = {
			...tv,
			inLibrary: tvStatus[id]?.inLibrary ?? false,
			hasFile: tvStatus[id]?.hasFile ?? false,
			libraryId: tvStatus[id]?.libraryId
		};

		// Enrich recommendations and similar with library status
		const [enrichedRecommendations, enrichedSimilar] = await Promise.all([
			tv.recommendations?.results
				? enrichWithLibraryStatus(tv.recommendations.results, 'tv')
				: Promise.resolve([]),
			tv.similar?.results ? enrichWithLibraryStatus(tv.similar.results, 'tv') : Promise.resolve([])
		]);

		const [filteredRecommendations, filteredSimilar] = await Promise.all([
			filterBlockedMedia(enrichedRecommendations, 'tv'),
			filterBlockedMedia(enrichedSimilar, 'tv')
		]);

		// Update tv object with enriched data
		if (tvWithStatus.recommendations) {
			tvWithStatus.recommendations = {
				...tvWithStatus.recommendations,
				results: filteredRecommendations
			};
		}
		if (tvWithStatus.similar) {
			tvWithStatus.similar = {
				...tvWithStatus.similar,
				results: filteredSimilar
			};
		}

		return {
			tv: tvWithStatus,
			requestState,
			hasBlockedKeywords,
			blockedKeywords: blockedMatches.map((k) => k.name)
		};
	} catch (e) {
		logger.error({ err: e, ...{ tvShowId: id } }, 'Failed to fetch TV show');
		throw error(404, 'TV Show not found');
	}
};
