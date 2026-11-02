/**
 * Smart List Preview API
 * POST /api/smartlists/preview - Preview filter results without saving
 */

import type { RequestHandler } from './$types';
import { tmdb, type DiscoverParams } from '#lib/server/tmdb.js';
import { type SmartListFilters } from '#lib/server/db/schema.js';
import { contentFilterPipeline } from '#lib/server/filters/ContentFilterPipeline.js';
import { createChildLogger } from '#lib/logging/index.js';
import { z } from 'zod';
import { smartListPreviewSchema } from '#lib/validation/schemas.js';

const logger = createChildLogger({ module: 'SmartListsPreviewApi', logDomain: 'monitoring' });

function buildDiscoverParams(filters: SmartListFilters, sortBy: string): DiscoverParams {
	const params: DiscoverParams = {
		sort_by: sortBy
	};

	if (filters.withGenres?.length) {
		params.with_genres =
			filters.genreMode === 'and' ? filters.withGenres.join(',') : filters.withGenres.join('|');
	}
	if (filters.withoutGenres?.length) {
		params.without_genres = filters.withoutGenres.join(',');
	}

	if (filters.yearMin) {
		params['primary_release_date.gte'] = `${filters.yearMin}-01-01`;
		params['first_air_date.gte'] = `${filters.yearMin}-01-01`;
	}
	if (filters.yearMax) {
		params['primary_release_date.lte'] = `${filters.yearMax}-12-31`;
		params['first_air_date.lte'] = `${filters.yearMax}-12-31`;
	}

	if (filters.voteAverageMin !== undefined) {
		params['vote_average.gte'] = filters.voteAverageMin;
	}
	if (filters.voteAverageMax !== undefined) {
		params['vote_average.lte'] = filters.voteAverageMax;
	}
	if (filters.voteCountMin !== undefined) {
		params['vote_count.gte'] = filters.voteCountMin;
	}

	if (filters.withCast?.length) {
		params.with_cast = filters.withCast.join(',');
	}
	if (filters.withCrew?.length) {
		params.with_crew = filters.withCrew.join(',');
	}

	if (filters.withKeywords?.length) {
		params.with_keywords = filters.withKeywords.join(',');
	}
	if (filters.withoutKeywords?.length) {
		params.without_keywords = filters.withoutKeywords.join(',');
	}

	if (filters.withWatchProviders?.length) {
		params.with_watch_providers = filters.withWatchProviders.join('|');
		if (filters.watchRegion) {
			params.watch_region = filters.watchRegion;
		}
	}

	if (filters.certification) {
		params.certification = filters.certification;
		if (filters.certificationCountry) {
			params.certification_country = filters.certificationCountry;
		}
	}

	if (filters.runtimeMin !== undefined) {
		params['with_runtime.gte'] = filters.runtimeMin;
	}
	if (filters.runtimeMax !== undefined) {
		params['with_runtime.lte'] = filters.runtimeMax;
	}

	if (filters.withOriginalLanguage) {
		params.with_original_language = filters.withOriginalLanguage;
	}

	if (filters.withStatus) {
		params.with_status = filters.withStatus;
	}

	if (filters.withReleaseType?.length) {
		params.with_release_type = filters.withReleaseType.join('|');
	}

	return params;
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		logger.debug('[Preview API] Received body', body);
		const data = smartListPreviewSchema.parse(body);

		const params = buildDiscoverParams(data.filters, data.sortBy);
		const TMDB_PAGE_SIZE = 20;
		const PREVIEW_PAGE_SIZE = 27; // 3 rows of 8 items for better grid display, can adjust as needed
		const startIndex = (data.page - 1) * PREVIEW_PAGE_SIZE;
		const tmdbStartPage = Math.floor(startIndex / TMDB_PAGE_SIZE) + 1;
		const tmdbOffset = startIndex % TMDB_PAGE_SIZE;

		const fetchDiscoverPage = async (page: number) => {
			const pageParams: DiscoverParams = { ...params, page };
			return data.mediaType === 'movie'
				? tmdb.discoverMovies(pageParams)
				: tmdb.discoverTv(pageParams);
		};

		const firstResult = await fetchDiscoverPage(tmdbStartPage);
		const cappedTotalResults = Math.min(firstResult.total_results, data.itemLimit);
		const totalPages = Math.ceil(cappedTotalResults / PREVIEW_PAGE_SIZE);

		if (cappedTotalResults === 0 || data.page > totalPages) {
			return Response.json({
				items: [],
				page: data.page,
				totalPages,
				totalResults: cappedTotalResults,
				itemLimit: data.itemLimit,
				unfilteredTotal: firstResult.total_results
			});
		}

		const endIndexExclusive = Math.min(startIndex + PREVIEW_PAGE_SIZE, cappedTotalResults);
		const neededCount = Math.max(0, endIndexExclusive - startIndex);

		let items = firstResult.results.slice(tmdbOffset, tmdbOffset + neededCount);

		if (items.length < neededCount) {
			const nextTmdbPage = tmdbStartPage + 1;
			if (nextTmdbPage <= firstResult.total_pages) {
				const secondResult = await fetchDiscoverPage(nextTmdbPage);
				const remaining = neededCount - items.length;
				items = [...items, ...secondResult.results.slice(0, remaining)];
			}
		}

		const { results: itemsWithLibraryStatus } = await contentFilterPipeline.apply(items, {
			mediaType: data.mediaType
		});

		return Response.json({
			items: itemsWithLibraryStatus,
			page: data.page,
			totalPages,
			totalResults: cappedTotalResults,
			itemLimit: data.itemLimit,
			unfilteredTotal: firstResult.total_results
		});
	} catch (error) {
		if (error instanceof z.ZodError) {
			logger.error({ issues: error.issues }, '[Preview API] Validation error');
			return Response.json({ error: 'Validation failed', details: error.issues }, { status: 400 });
		}
		logger.error('[Preview API] Error', error);
		const message = error instanceof Error ? error.message : 'Unknown error';
		return Response.json({ error: message }, { status: 500 });
	}
};
