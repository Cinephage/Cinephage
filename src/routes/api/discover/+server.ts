import { resolveWithOriginalLanguage } from '#lib/server/discover.js';
import { catalogSource, catalogSourceForKind } from '#lib/server/catalog/registry.js';
import { legacyRows } from '#lib/server/catalog/tmdb.js';
import { contentFilterPipeline } from '#lib/server/filters/ContentFilterPipeline.js';
import { enrichWithReleaseDates } from '#lib/server/release-enrichment.js';
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

/** The row shape this route has always returned: provider fields plus media_type. */
type DiscoverRow = { id: number; media_type?: string; vote_average?: number };

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

		// The catalog source owns the rows: 'movie'/'tv' resolve by kind, 'all'
		// stays on the browse source, whose own discover merges its kinds. A
		// kind no source serves answers 400 instead of an empty grid.
		const source =
			params.type === 'movie' || params.type === 'tv'
				? catalogSourceForKind(params.type)
				: catalogSource('tmdb');
		if (!source) {
			return Response.json(
				{ error: `No catalog source serves "${params.type}" yet` },
				{ status: 400 }
			);
		}

		const catalog = await source.discover({
			type: params.type,
			page: params.page,
			sortBy: params.sort_by,
			trending: params.trending ?? null,
			topRated: params.top_rated ?? null,
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
		if (!catalog) {
			return Response.json({ error: 'Catalog source unavailable' }, { status: 503 });
		}

		const results = legacyRows(catalog.items) as DiscoverRow[];
		const pagination = catalog.pagination;

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
