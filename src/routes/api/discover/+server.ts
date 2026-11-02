import { getDiscoverResults, resolveWithOriginalLanguage } from '#lib/server/discover.js';
import { contentFilterPipeline } from '#lib/server/filters/ContentFilterPipeline.js';
import { enrichWithReleaseDates } from '#lib/server/release-enrichment.js';
import { tmdb } from '#lib/server/tmdb.js';
import { db } from '#lib/server/db/index.js';
import { languageSettings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'DiscoverApi', logDomain: 'system' });

/**
 * Query parameter validation schema for discover endpoint.
 */
const discoverQuerySchema = z.object({
	type: z.enum(['movie', 'tv', 'all']).default('all'),
	page: z.coerce.number().int().min(1).default(1),
	sort_by: z.string().default('popularity.desc'),
	trending: z.enum(['day', 'week']).optional(),
	top_rated: z.enum(['true', 'false']).optional(),
	with_watch_providers: z.string().default(''),
	watch_region: z.string().optional(),
	with_networks: z.string().default(''),
	with_genres: z.string().default(''),
	with_keywords: z.string().default(''),
	without_keywords: z.string().default(''),
	with_original_language: z.string().nullable().default(null),
	'primary_release_date.gte': z.string().nullable().default(null),
	'primary_release_date.lte': z.string().nullable().default(null),
	'vote_average.gte': z.string().nullable().default(null),
	certification: z.string().nullable().default(null),
	exclude_in_library: z.enum(['true', 'false']).optional(),
	skip_blocked: z.enum(['true', 'false']).optional()
});

interface TmdbPaginatedResult {
	results: Array<{ id: number; vote_average?: number; media_type?: string }>;
	page: number;
	total_pages: number;
	total_results: number;
}

export const GET: RequestHandler = async ({ url }) => {
	// Parse query parameters into an object
	const queryParams = Object.fromEntries(url.searchParams.entries());
	const result = discoverQuerySchema.safeParse(queryParams);

	if (!result.success) {
		return Response.json(
			{
				error: 'Invalid query parameters',
				details: result.error.flatten()
			},
			{ status: 400 }
		);
	}

	const params = result.data;

	try {
		// Content-origin filter: URL param wins (normalized), then the stored
		// instance setting. The curated top_rated endpoint cannot filter, so it
		// yields to the discover grid when a filter is active.
		let storedOriginalFilter: string | null = null;
		try {
			const languageRow = await db.query.languageSettings.findFirst({
				where: eq(languageSettings.id, 'singleton')
			});
			storedOriginalFilter = languageRow?.discoverOriginalFilter ?? null;
		} catch {
			// Non-fatal: no stored filter.
		}
		const effectiveOriginalLanguage = resolveWithOriginalLanguage(
			params.with_original_language,
			storedOriginalFilter
		);

		let results: Array<{ id: number }>;
		let pagination: { page: number; total_pages: number; total_results: number };

		if (params.top_rated === 'true' && !effectiveOriginalLanguage) {
			// Handle top_rated endpoint
			if (params.type === 'movie') {
				const data = (await tmdb.fetch(
					`/movie/top_rated?page=${params.page}`
				)) as TmdbPaginatedResult;
				results = data.results.map((r) => ({ ...r, media_type: 'movie' }));
				pagination = {
					page: data.page,
					total_pages: data.total_pages,
					total_results: data.total_results
				};
			} else if (params.type === 'tv') {
				const data = (await tmdb.fetch(`/tv/top_rated?page=${params.page}`)) as TmdbPaginatedResult;
				results = data.results.map((r) => ({ ...r, media_type: 'tv' }));
				pagination = {
					page: data.page,
					total_pages: data.total_pages,
					total_results: data.total_results
				};
			} else {
				// For 'all', fetch both and combine
				const [moviesData, tvData] = (await Promise.all([
					tmdb.fetch(`/movie/top_rated?page=${params.page}`),
					tmdb.fetch(`/tv/top_rated?page=${params.page}`)
				])) as TmdbPaginatedResult[];

				const movieResults = moviesData.results.map((m) => ({ ...m, media_type: 'movie' }));
				const tvResults = tvData.results.map((t) => ({ ...t, media_type: 'tv' }));
				results = [...movieResults, ...tvResults].sort(
					(a, b) => (b.vote_average || 0) - (a.vote_average || 0)
				);
				pagination = {
					page: 1,
					total_pages: Math.max(moviesData.total_pages, tvData.total_pages),
					total_results: moviesData.total_results + tvData.total_results
				};
			}
		} else {
			// Use regular discover results
			const discoverResult = await getDiscoverResults({
				type: params.type,
				page: String(params.page),
				sortBy: params.sort_by,
				trending: params.trending ?? null,
				withWatchProviders: params.with_watch_providers,
				watchRegion: params.watch_region ?? '',
				withNetworks: params.with_networks,
				withGenres: params.with_genres,
				withKeywords: params.with_keywords,
				withoutKeywords: params.without_keywords,
				withOriginalLanguage: effectiveOriginalLanguage,
				minDate: params['primary_release_date.gte'],
				maxDate: params['primary_release_date.lte'],
				minRating: params['vote_average.gte'],
				certification: params.certification,
				skipKeywordBlocklist: params.skip_blocked === 'true'
			});
			results = discoverResult.results;
			pagination = discoverResult.pagination;
		}

		// Enrich results with library status and filter blocked media
		const mediaTypeFilter = params.type === 'movie' ? 'movie' : params.type === 'tv' ? 'tv' : 'all';
		const { results: filteredResults } = await contentFilterPipeline.apply(results, {
			mediaType: mediaTypeFilter,
			excludeInLibrary: params.exclude_in_library === 'true'
		});
		const enrichedResults = await enrichWithReleaseDates(filteredResults);

		return Response.json({
			results: enrichedResults,
			pagination
		});
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Unknown error';
		logger.error({ err: e, ...{ errorMessage: message } }, 'Discover API error');
		return Response.json({ error: 'Failed to load content' }, { status: 500 });
	}
};
