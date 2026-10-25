import type { RequestHandler } from './$types';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import type { SearchCriteria } from '#lib/server/indexers/types/index.js';
import {
	getCategoriesForSearchType,
	expandCategoriesForClassification
} from '#lib/server/indexers/types/index.js';
import { searchQuerySchema } from '#lib/validation/schemas.js';
import { extractSearchYear } from '#lib/utils/search-query.js';
import { qualityFilter, type EnrichmentOptions } from '#lib/server/quality/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { redactUrl } from '#lib/server/utils/urlSecurity.js';
import { db } from '#lib/server/db/index.js';
import { movies, series, settings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { evaluateIndexerSearchAvailability } from '#lib/server/indexers/search/availability.js';
import {
	getMovieSearchTitles,
	getSeriesSearchTitles,
	fetchAndStoreMovieAlternateTitles,
	fetchAndStoreSeriesAlternateTitles
} from '#lib/server/services/AlternateTitleService.js';

const logger = createChildLogger({ module: 'SearchApi', logDomain: 'system' });

/**
 * Per-indexer search timeout for interactive searches.
 * Interactive searches wait longer because the user is actively waiting and
 * proxied indexers (Prowlarr, Jackett) add upstream latency on top of the
 * network round trip to the remote tracker.
 * Matches INDEXER_SEARCH_TIMEOUT_MS env var if set, otherwise defaults to 45 s.
 */
const INTERACTIVE_SEARCH_TIMEOUT_MS = (() => {
	const raw = process.env.INDEXER_SEARCH_TIMEOUT_MS;
	const parsed = raw ? parseInt(raw, 10) : NaN;
	return parsed > 0 ? parsed : 45_000;
})();

/**
 * Redact sensitive URLs from release objects before returning in API responses.
 * This prevents API keys from being exposed to clients.
 */
function redactReleaseUrls<T extends { downloadUrl?: string | null }>(releases: T[]): T[] {
	return releases.map((release) => ({
		...release,
		downloadUrl: release.downloadUrl ? redactUrl(release.downloadUrl) : null
	}));
}

/**
 * GET /api/search?q=query&searchType=movie&imdbId=tt1234567&categories=2000
 * Performs a search across all enabled indexers with typed criteria.
 *
 * Enrichment options:
 * - enrich=true: Enable quality filtering and scoring
 * - scoringProfileId=xxx: Scoring profile ID to use
 * - matchToTmdb=true: Match releases to TMDB entries
 * - filterRejected=true: Filter out releases that don't meet quality requirements
 * - minScore=500: Minimum score to include (0-1000)
 */
export const GET: RequestHandler = async ({ url }) => {
	const params = Object.fromEntries(url.searchParams);
	const result = searchQuerySchema.safeParse(params);

	if (!result.success) {
		return Response.json(
			{
				error: 'Invalid query parameters',
				details: result.error.flatten()
			},
			{ status: 400 }
		);
	}

	const {
		q,
		searchType,
		searchMode,
		categories,
		indexers,
		limit,
		imdbId,
		tmdbId,
		tvdbId,
		year,
		season,
		episode,
		language,
		enrich,
		scoringProfileId,
		matchToTmdb,
		filterRejected,
		minScore
	} = result.data;
	let effectiveScoringProfileId = scoringProfileId;
	const isMultiSeasonPackTvSearch = searchType === 'tv' && searchMode === 'multiSeasonPack';

	// Build typed search criteria based on searchType
	// Auto-apply categories based on search type if none specified
	const effectiveCategories = isMultiSeasonPackTvSearch
		? (categories ?? [])
		: (categories ?? getCategoriesForSearchType(searchType));
	const effectiveLimit = isMultiSeasonPackTvSearch ? (limit ?? 200) : limit;

	// Movie/TV queries often carry a trailing year ("Se7en (1995)"). Indexers
	// match better with the bare title plus a separate year criterion; for
	// basic search there is no year field, so the query is left untouched.
	const isTypedSearch = searchType === 'movie' || searchType === 'tv';
	const { title: strippedTitle, year: embeddedYear } = isTypedSearch
		? extractSearchYear(q ?? '')
		: { title: q ?? '', year: undefined };
	const effectiveQuery = isTypedSearch ? strippedTitle : q;
	const effectiveYear = isTypedSearch ? (year ?? embeddedYear) : year;

	// Resolve language preference and global adult toggle from settings.
	// Explicit ?language= param takes precedence over the stored language preference.
	// An empty or "any" language means no preference (all alternate titles used,
	// no language boost) — the reporter's "any" option.
	let effectiveLanguage: string | undefined = language;
	let globalIncludeAdult = false;
	try {
		const filtersSetting = await db.query.settings.findFirst({
			where: eq(settings.key, 'global_filters')
		});
		if (filtersSetting?.value) {
			const globalFilters = JSON.parse(filtersSetting.value);
			const globalLanguage =
				typeof globalFilters?.language === 'string' ? globalFilters.language.trim() : '';
			if (!effectiveLanguage && globalLanguage && globalLanguage.toLowerCase() !== 'any') {
				effectiveLanguage = globalLanguage.toLowerCase().split('-')[0];
			}
			if (globalFilters?.include_adult === true) {
				globalIncludeAdult = true;
			}
		}
	} catch {
		// If settings are unavailable, proceed without language/adult preference
	}

	let criteria: SearchCriteria;

	if (searchType === 'movie') {
		criteria = {
			searchType: 'movie',
			query: effectiveQuery ?? '',
			categories: effectiveCategories.length > 0 ? effectiveCategories : undefined,
			indexerIds: indexers,
			limit: effectiveLimit,
			imdbId,
			tmdbId,
			year: effectiveYear,
			language: effectiveLanguage
		};
	} else if (searchType === 'tv') {
		criteria = {
			searchType: 'tv',
			query: effectiveQuery ?? '',
			categories: effectiveCategories.length > 0 ? effectiveCategories : undefined,
			indexerIds: indexers,
			limit: effectiveLimit,
			imdbId,
			tmdbId,
			tvdbId,
			year: effectiveYear,
			season,
			episode,
			language: effectiveLanguage
		};
	} else {
		// Basic search requires a query
		if (!q) {
			return Response.json({ error: 'Query (q) is required for basic search' }, { status: 400 });
		}
		criteria = {
			searchType: 'basic',
			query: q,
			categories: effectiveCategories.length > 0 ? effectiveCategories : undefined,
			indexerIds: indexers,
			limit: effectiveLimit,
			language: effectiveLanguage
		};
	}

	if (isMultiSeasonPackTvSearch) {
		logger.info(
			{
				query: criteria.query,
				limit: criteria.limit,
				categoriesApplied: !!(criteria.categories && criteria.categories.length > 0)
			},
			'[SearchAPI] Multi-season TV search mode enabled'
		);
	}

	// Populate searchTitles from alternate titles in the library database and
	// compute content classification (isAnime, isAdult) for category expansion.
	if (tmdbId && (searchType === 'movie' || searchType === 'tv')) {
		try {
			let searchTitles: string[] | undefined;
			if (searchType === 'movie') {
				const movie = await db.query.movies.findFirst({
					where: eq(movies.tmdbId, tmdbId),
					columns: { id: true, adult: true }
				});
				if (movie) {
					if (globalIncludeAdult && movie.adult) criteria.isAdult = true;
					searchTitles = await getMovieSearchTitles(movie.id, effectiveLanguage);
					if (searchTitles.length <= 1) {
						fetchAndStoreMovieAlternateTitles(movie.id, tmdbId).catch(() => {});
						searchTitles = await getMovieSearchTitles(movie.id, effectiveLanguage);
					}
				}
			} else {
				const show = await db.query.series.findFirst({
					where: eq(series.tmdbId, tmdbId),
					columns: { id: true, seriesType: true, adult: true }
				});
				if (show) {
					const isAnime = (show.seriesType ?? '').toLowerCase() === 'anime';
					criteria.isAnime = isAnime || undefined;
					if (globalIncludeAdult && show.adult) criteria.isAdult = true;

					searchTitles = await getSeriesSearchTitles(show.id, effectiveLanguage);
					if (searchTitles.length <= 1) {
						fetchAndStoreSeriesAlternateTitles(show.id, tmdbId).catch(() => {});
						searchTitles = await getSeriesSearchTitles(show.id, effectiveLanguage);
					}
				}
			}
			if (searchTitles && searchTitles.length > 0) {
				criteria.searchTitles = searchTitles;
			}
		} catch (error) {
			logger.warn(
				{
					tmdbId,
					searchType,
					error: error instanceof Error ? error.message : String(error)
				},
				'[SearchAPI] Failed to look up alternate titles or classify content'
			);
		}

		// Expand categories based on classification (isAnime, isAdult).
		// isAdult requires the global include_adult toggle to be on; the adult column
		// lands in WP-Q so criteria.isAdult is always false until then.
		if (criteria.isAnime || criteria.isAdult) {
			const base = criteria.categories ?? getCategoriesForSearchType(searchType as 'movie' | 'tv');
			const expanded = expandCategoriesForClassification(base, {
				isAnime: criteria.isAnime,
				isAdult: criteria.isAdult
			});
			criteria.categories = expanded.length > 0 ? expanded : undefined;
		}
	}

	const manager = await getIndexerManager();
	const configuredIndexers = await manager.getIndexers();

	// Use enhanced search if enrichment is requested
	if (enrich) {
		if (!effectiveScoringProfileId) {
			const defaultScoringProfile = await qualityFilter.getDefaultScoringProfile();
			effectiveScoringProfileId = defaultScoringProfile.id;
		}

		// Load the scoring profile to get allowedProtocols for indexer filtering
		let protocolFilter: string[] | undefined;
		if (effectiveScoringProfileId) {
			const profile = await qualityFilter.getProfile(effectiveScoringProfileId);
			if (profile?.allowedProtocols && profile.allowedProtocols.length > 0) {
				protocolFilter = profile.allowedProtocols;
			}
		}

		// Debug logging for profile issues
		logger.info(
			{
				scoringProfileId: effectiveScoringProfileId ?? 'none',
				protocolFilter
			},
			'[SearchAPI] Enrichment requested'
		);

		const enrichmentOpts: EnrichmentOptions = {
			scoringProfileId: effectiveScoringProfileId,
			matchToTmdb: matchToTmdb ?? false,
			filterRejected: filterRejected ?? false,
			minScore,
			// Pass TMDB hint if we have IDs from criteria
			tmdbHint:
				tmdbId || imdbId
					? {
							tmdbId,
							imdbId,
							tvdbId,
							mediaType: searchType === 'tv' ? 'tv' : 'movie'
						}
					: undefined
		};

		const availability = evaluateIndexerSearchAvailability(configuredIndexers, {
			searchType,
			searchSource: 'interactive',
			protocolFilter,
			scoringProfileId: effectiveScoringProfileId,
			getDefinitionCapabilities: (definitionId) => manager.getDefinitionCapabilities(definitionId)
		});

		if (!availability.ok) {
			return Response.json(
				{
					error: availability.message,
					errorCode: availability.code
				},
				{ status: 400 }
			);
		}

		const searchResult = await manager.searchEnhanced(criteria, {
			searchSource: 'interactive',
			enrichment: enrichmentOpts,
			protocolFilter,
			timeout: INTERACTIVE_SEARCH_TIMEOUT_MS
		});

		return Response.json({
			releases: redactReleaseUrls(searchResult.releases),
			meta: {
				totalResults: searchResult.totalResults,
				afterDedup: searchResult.afterDedup,
				afterFiltering: searchResult.afterFiltering,
				filterBreakdown: searchResult.filterBreakdown,
				afterEnrichment: searchResult.afterEnrichment,
				rejectedCount: searchResult.rejectedCount,
				searchTimeMs: searchResult.searchTimeMs,
				enrichTimeMs: searchResult.enrichTimeMs,
				scoringProfileId: searchResult.scoringProfileId,
				indexerCount: searchResult.indexerResults.length,
				indexerResults: Object.fromEntries(
					searchResult.indexerResults.map((ir) => [
						ir.indexerId,
						{
							name: ir.indexerName,
							count: ir.results.length,
							durationMs: ir.searchTimeMs,
							error: ir.error,
							searchMethod: ir.searchMethod
						}
					])
				),
				rejectedIndexers: searchResult.rejectedIndexers
			}
		});
	}

	const availability = evaluateIndexerSearchAvailability(configuredIndexers, {
		searchType,
		searchSource: 'interactive',
		scoringProfileId: effectiveScoringProfileId,
		getDefinitionCapabilities: (definitionId) => manager.getDefinitionCapabilities(definitionId)
	});

	if (!availability.ok) {
		return Response.json(
			{
				error: availability.message,
				errorCode: availability.code
			},
			{ status: 400 }
		);
	}

	// Standard search without enrichment (interactive)
	const searchResult = await manager.search(criteria, {
		searchSource: 'interactive',
		timeout: INTERACTIVE_SEARCH_TIMEOUT_MS
	});

	return Response.json({
		releases: redactReleaseUrls(searchResult.releases),
		meta: {
			totalResults: searchResult.totalResults,
			searchTimeMs: searchResult.searchTimeMs,
			indexerCount: searchResult.indexerResults.length,
			indexerResults: searchResult.indexerResults.map((ir) => ({
				indexerId: ir.indexerId,
				indexerName: ir.indexerName,
				count: ir.results.length,
				durationMs: ir.searchTimeMs,
				error: ir.error,
				searchMethod: ir.searchMethod
			})),
			rejectedIndexers: searchResult.rejectedIndexers
		}
	});
};
