/**
 * Search Orchestrator - Manages tiered search across multiple indexers.
 * Handles ID-based search with fallback to text search.
 */

import type {
	IIndexer,
	SearchCriteria,
	ReleaseResult,
	SearchResult,
	IndexerSearchResult,
	RejectedIndexer,
	EnhancedReleaseResult
} from '../types';
import {
	hasSearchableIds,
	createIdOnlyCriteria,
	createTextOnlyCriteria,
	criteriaToString,
	supportsParam,
	isMovieSearch,
	isTvSearch,
	indexerHasCategoriesForSearchType,
	restrictionAllowsSearchType,
	categoryMatchesSearchType,
	getCategoryContentType,
	isXxxCategory,
	isMovieCategory,
	CINEPHAGE_STREAM_DEFINITION_ID
} from '../types';

import {
	getEffectiveEpisodeFormats,
	getEpisodeFormats,
	ANIME_EPISODE_FORMATS,
	type EpisodeFormat
} from './SearchFormatProvider';
import { getPersistentStatusTracker, type PersistentStatusTracker } from '../status';
import { isQuotaExceededMessage } from '../status/types';
import { getRateLimitRegistry, type RateLimitRegistry } from '../ratelimit';
import { getHostRateLimiter, type HostRateLimiter } from '../ratelimit/HostRateLimiter';
import {
	getHostConcurrencyLimiter,
	type HostConcurrencyLimiter
} from '../ratelimit/HostConcurrencyLimiter';
import { ReleaseDeduplicator } from './ReleaseDeduplicator';
import { ReleaseRanker } from './ReleaseRanker';
import { ReleaseCache } from './ReleaseCache';
import {
	RUTRACKER_AUTOMATIC_MAX_TITLES,
	RUTRACKER_AUTOMATIC_SEASON_CACHE_TTL_MS,
	prefersNativeCyrillicTitles,
	isRuTrackerIndexerName,
	isRuTrackerHost
} from './russian-trackers';
import { parseRelease } from '../parser';
import { extractLanguages } from '../parser/patterns/language';
import {
	rankLanguageEvidenceSet,
	type EffectiveAudioPreference
} from '#lib/server/languages/audio-preference.js';
import { resolveAudioPreferenceForItem } from '#lib/server/languages/audio-preference-resolver.js';
import { normalizeLanguageCode } from '#lib/shared/languages.js';
import { CloudflareProtectedError } from '../http/CloudflareDetection';
import {
	releaseEnricher,
	type EnrichmentOptions,
	type IndexerConfigForEnrichment
} from '../../quality';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });
import { tmdb } from '#lib/server/tmdb.js';
import { db } from '#lib/server/db/index.js';
import { movies, series } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { blocklistService } from '#lib/server/blocklist/BlocklistService.js';
import { DANGEROUS_EXTENSIONS, EXECUTABLE_EXTENSIONS } from '#lib/config/constants.js';
import { matchTitleContainment } from '#lib/server/releases/release-identity.js';

/** Options for search orchestration */
export interface SearchOrchestratorOptions {
	/** Search source: 'interactive' (manual) or 'automatic' (background) */
	searchSource?: 'interactive' | 'automatic';
	/** Skip disabled indexers (default: true) */
	respectEnabled?: boolean;
	/** Skip indexers in backoff (default: true) */
	respectBackoff?: boolean;
	/** Use tiered search strategy (default: true) */
	useTieredSearch?: boolean;
	/** Timeout per indexer in ms (default: 30000) */
	timeout?: number;
	/** Use cache (default: true) */
	useCache?: boolean;
	/** Enrichment options for quality filtering and TMDB matching */
	enrichment?: EnrichmentOptions;
	/** Filter indexers by protocol (from scoring profile's allowedProtocols) */
	protocolFilter?: string[];
}

/** Enhanced search result with enriched releases */
export interface FilterBreakdown {
	afterSeasonEpisode: number;
	afterCategory: number;
	afterNonVideo: number;
	afterIdTitle: number;
}

export interface EnhancedSearchResult {
	/** Enriched releases (parsed, scored, optionally TMDB-matched) */
	releases: EnhancedReleaseResult[];
	/** Total results across all indexers before any filtering (raw from indexers) */
	totalResults: number;
	/** Results after first deduplication pass (before enrichment) */
	afterDedup?: number;
	/** Results after season/category filtering (before enrichment) */
	afterFiltering?: number;
	/** Per-step breakdown of how many results survived each filter */
	filterBreakdown?: FilterBreakdown;
	/** Results after enrichment (before limit applied) */
	afterEnrichment?: number;
	/** Number of releases rejected by quality filter */
	rejectedCount: number;
	/** Total search time in milliseconds */
	searchTimeMs: number;
	/** Enrichment time in milliseconds */
	enrichTimeMs: number;
	/** Whether results came from cache */
	fromCache?: boolean;
	/** Per-indexer results */
	indexerResults: IndexerSearchResult[];
	/** Indexers that were rejected from this search */
	rejectedIndexers?: RejectedIndexer[];
	/** Scoring profile used for quality scoring */
	scoringProfileId?: string;
}

/** Resolved options after merging with defaults */
type ResolvedSearchOptions = Required<
	Omit<SearchOrchestratorOptions, 'enrichment' | 'searchSource' | 'protocolFilter'>
> & {
	enrichment?: EnrichmentOptions;
	searchSource?: 'interactive' | 'automatic';
	protocolFilter?: string[];
};

const DEFAULT_OPTIONS: Required<
	Omit<SearchOrchestratorOptions, 'enrichment' | 'searchSource' | 'protocolFilter'>
> = {
	respectEnabled: true,
	respectBackoff: true,
	useTieredSearch: true,
	timeout: getPositiveIntEnv('INDEXER_SEARCH_TIMEOUT_MS', 30_000),
	useCache: true
};

const CYRILLIC_REGEX = /\p{Script=Cyrillic}/u;

function containsCyrillic(value: string): boolean {
	return CYRILLIC_REGEX.test(value);
}

const NON_VIDEO_ARTIFACT_TITLE_PATTERNS: RegExp[] = [
	/\boriginal\s+soundtrack\b/i,
	/\bsoundtrack\b/i,
	/\b(?:film|movie|motion\s+picture|series)\s+score\b/i,
	/\[(?:\s*(?:score|soundtrack|ost)\s*(?:,\s*(?:score|soundtrack|ost)\s*)*)\]/i,
	/\((?:\s*(?:score|soundtrack|ost)\s*(?:,\s*(?:score|soundtrack|ost)\s*)*)\)/i,
	/\bost\b/i,
	/\bdiscography\b/i,
	/\balbum\b/i,
	/\bvinyl\b/i,
	/\blossless\b/i,
	/\bflac\b/i,
	/\bmp3\b/i,
	/\baac\b/i,
	/\bm4a\b/i,
	/\btrailer\b/i,
	/\bteaser\b/i,
	/\bpromo\b/i,
	/\bpreview\b/i,
	/\bclip\b/i,
	/\bfeaturette\b/i,
	/\b(?:audio\s*)?cd\b/i,
	/\b(?:epub|pdf|mobi|azw3|cbz|cbr)\b/i
];

const TRAILER_ARTIFACT_TITLE_PATTERNS: RegExp[] = [
	/\btrailer\b/i,
	/\bteaser\b/i,
	/\bpromo\b/i,
	/\bpreview\b/i,
	/\bclip\b/i,
	/\bfeaturette\b/i
];

const VIDEO_SIGNAL_PATTERN =
	/\b(?:\d{3,4}p|4k|8k|web[-.\s]?dl|web[-.\s]?rip|webrip|bluray|bdrip|bdremux|remux|hdtv|dvdrip|x264|x265|h\.?264|h\.?265|hevc|av1|s\d{1,2}e\d{1,3}|\d{1,2}x\d{2,3})\b/i;

/**
 * Hardcoded pattern for executable/dangerous file extensions in release titles.
 * Built from DANGEROUS_EXTENSIONS + EXECUTABLE_EXTENSIONS in constants.ts.
 * Not user-configurable — these are security rules, not preferences.
 */
function buildDangerousExtensionPattern(extensions: string[]): RegExp {
	const alternation = extensions
		.map((ext) => ext.replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('|');
	return new RegExp(`\\b\\.?(?:${alternation})\\b`, 'i');
}

const DEFAULT_DANGEROUS_EXTENSION_PATTERN = buildDangerousExtensionPattern([
	...DANGEROUS_EXTENSIONS,
	...EXECUTABLE_EXTENSIONS
]);

interface TvEpisodeCounts {
	seriesEpisodeCount?: number;
	seasonEpisodeCounts: Map<number, number>;
}

interface SeasonEpisodeFilterContext {
	seasonEpisodeCount?: number;
	seasonEpisodeCounts?: Map<number, number>;
}

function getPositiveIntEnv(name: string, fallback: number): number {
	const envValue = process.env[name];
	if (!envValue) return fallback;

	const parsed = Number(envValue);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;

	return Math.round(parsed);
}

/**
 * Orchestrates searches across multiple indexers with tiered strategy.
 */
export class SearchOrchestrator {
	private statusTracker: PersistentStatusTracker;
	/** Cache for season episode counts (tmdbId:season -> count) */
	private seasonEpisodeCountCache: Map<string, number> = new Map();
	/** Cache for TV show episode counts (tmdbId -> aggregate + per-season counts) */
	private tvEpisodeCountsCache: Map<number, TvEpisodeCounts> = new Map();
	/** Short-lived cache for RuTracker automatic TV season searches (reduces per-episode query fan-out). */
	private rutrackerAutomaticSeasonSearchCache: Map<
		string,
		{ cachedAtMs: number; releases: ReleaseResult[] }
	> = new Map();
	/** In-flight dedupe for identical RuTracker automatic season searches. */
	private rutrackerAutomaticSeasonSearchInFlight: Map<string, Promise<ReleaseResult[]>> = new Map();
	/** Single-lane queue for RuTracker automatic season searches to avoid bursty host traffic. */
	private rutrackerAutomaticSearchLane: Promise<void> = Promise.resolve();
	private rateLimitRegistry: RateLimitRegistry;
	private hostRateLimiter: HostRateLimiter;
	private hostConcurrencyLimiter: HostConcurrencyLimiter;
	private deduplicator: ReleaseDeduplicator;
	private ranker: ReleaseRanker;
	private cache: ReleaseCache;
	private enhancedCache: Map<
		string,
		{
			releases: ReleaseResult[];
			indexerResults: IndexerSearchResult[];
			rejectedIndexers: RejectedIndexer[];
			cachedAt: number;
		}
	>;
	private static readonly ENHANCED_CACHE_TTL_MS = 5 * 60 * 1000;
	constructor() {
		this.statusTracker = getPersistentStatusTracker();
		this.rateLimitRegistry = getRateLimitRegistry();
		this.hostRateLimiter = getHostRateLimiter();
		this.hostConcurrencyLimiter = getHostConcurrencyLimiter();
		this.deduplicator = new ReleaseDeduplicator();
		this.ranker = new ReleaseRanker();
		this.cache = new ReleaseCache();
		this.enhancedCache = new Map();
	}

	/** Search across all provided indexers */
	async search(
		indexers: IIndexer[],
		criteria: SearchCriteria,
		options: SearchOrchestratorOptions = {}
	): Promise<SearchResult> {
		const startTime = Date.now();
		const opts = { ...DEFAULT_OPTIONS, ...options };
		const indexerResults: IndexerSearchResult[] = [];
		const criteriaWithSource = opts.searchSource
			? { ...criteria, searchSource: opts.searchSource }
			: criteria;

		logger.debug(
			{
				criteria: criteriaToString(criteriaWithSource),
				indexerCount: indexers.length,
				options: opts
			},
			'Starting search orchestration'
		);

		const [enrichedCriteria, indexerFilterResult] = await Promise.all([
			this.enrichCriteriaWithIds(criteriaWithSource),
			this.filterIndexers(indexers, criteriaWithSource, opts)
		]);

		const { eligible: eligibleIndexers, rejected: rejectedIndexers } = indexerFilterResult;

		// Cache raw indexer results only. Downstream processing (blocklist,
		// season/episode, category, language boost, ranking, limit) re-runs on
		// every request, including cache hits, since it depends on state that
		// can change between requests.
		let allReleases: ReleaseResult[] = [];
		let fromCache = false;
		if (opts.useCache) {
			const cached = this.cache.get(enrichedCriteria);
			if (cached) {
				logger.debug({ resultCount: cached.length }, 'Cache hit');
				allReleases = [...cached];
				fromCache = true;
			}
		}

		if (!fromCache) {
			if (eligibleIndexers.length === 0) {
				logger.warn(
					{
						criteria: criteriaToString(criteria)
					},
					'No eligible indexers for search'
				);
				return {
					releases: [],
					totalResults: 0,
					searchTimeMs: Date.now() - startTime,
					fromCache: false,
					indexerResults: [],
					rejectedIndexers
				};
			}

			// Sort by priority
			eligibleIndexers.sort((a, b) => {
				const statusA = this.statusTracker.getStatusSync(a.id);
				const statusB = this.statusTracker.getStatusSync(b.id);
				return statusA.priority - statusB.priority;
			});

			// Execute searches with enriched criteria (includes IMDB ID if looked up)
			allReleases = await this.executeSearches(
				eligibleIndexers,
				enrichedCriteria,
				indexerResults,
				opts
			);

			if (opts.useCache && allReleases.length > 0) {
				this.cache.set(enrichedCriteria, [...allReleases]);
			}
		}

		// Deduplicate
		const { releases: deduped } = this.deduplicator.deduplicate(allReleases);

		// Filter by season/episode if specified.
		// Use criteriaWithSource so interactive/automatic behavior is respected.
		// (season/episode fields are unchanged from original criteria)
		let filtered = await this.filterByBlocklist(deduped, criteriaWithSource);
		filtered = this.filterBySeasonEpisode(filtered, criteriaWithSource);

		// Filter by category match (reject releases in wrong categories).
		// Skip for season-only TV searches: the season/episode filter already validated
		// these releases as season packs, and indexer categories are an unreliable signal
		// for packs (see isSeasonOnlyTvSearch).
		if (criteria.searchType !== 'basic' && !this.isSeasonOnlyTvSearch(criteriaWithSource)) {
			const searchType = criteria.searchType as 'movie' | 'tv' | 'music' | 'book';
			filtered = this.filterByCategoryMatch(filtered, searchType, criteriaWithSource);
		}
		filtered = this.filterOutNonVideoArtifacts(filtered, criteriaWithSource);

		// Hard filter by ID match with title+year fallback (same as searchEnhanced path).
		if (isMovieSearch(criteriaWithSource) || isTvSearch(criteriaWithSource)) {
			filtered = this.filterByIdOrTitleMatch(filtered, criteriaWithSource);
		}

		// Boost releases matching preferred language
		filtered = this.boostByLanguage(filtered, criteriaWithSource);
		// Graded ordered-preference boost from the effective language profile.
		// Uses enrichedCriteria — the preference is attached during criteria
		// enrichment, not on the caller's object.
		filtered = this.boostByAudioPreference(filtered, enrichedCriteria);

		// Rank
		const ranked = this.ranker.rank(filtered);

		// Apply limit (only if explicitly specified)
		const limited = criteria.limit ? ranked.slice(0, criteria.limit) : ranked;

		const result: SearchResult = {
			releases: limited,
			totalResults: allReleases.length,
			searchTimeMs: Date.now() - startTime,
			fromCache,
			indexerResults,
			rejectedIndexers
		};

		logger.info(
			{
				totalResults: result.totalResults,
				returned: result.releases.length,
				timeMs: result.searchTimeMs
			},
			'Search completed'
		);

		return result;
	}

	/**
	 * Search with enrichment - parses, scores, and optionally matches to TMDB.
	 * Returns EnhancedReleaseResult with quality scores and parsed metadata.
	 */
	async searchEnhanced(
		indexers: IIndexer[],
		criteria: SearchCriteria,
		options: SearchOrchestratorOptions = {}
	): Promise<EnhancedSearchResult> {
		const startTime = Date.now();
		const opts = { ...DEFAULT_OPTIONS, ...options };
		const indexerResults: IndexerSearchResult[] = [];
		const criteriaWithSource = opts.searchSource
			? { ...criteria, searchSource: opts.searchSource }
			: criteria;

		logger.debug(
			{
				criteria: criteriaToString(criteriaWithSource),
				indexerCount: indexers.length,
				enrichment: opts.enrichment
			},
			'Starting enhanced search orchestration'
		);

		const [enrichedCriteria, indexerFilterResult] = await Promise.all([
			this.enrichCriteriaWithIds(criteriaWithSource),
			this.filterIndexers(indexers, criteriaWithSource, opts)
		]);

		const { eligible: eligibleIndexers, rejected: rejectedIndexers } = indexerFilterResult;

		// Cache raw indexer results only (keyed by criteria + protocol filter).
		// Everything downstream (blocklist, filters, language boost, scoring,
		// enhanced dedup, limit) depends on state that can change between
		// requests (scoring profile, blocklist, language, limit), so it must
		// re-run on every request, including cache hits.
		const interactiveCacheKey =
			opts.useCache && opts.searchSource === 'interactive'
				? this.cache.generateKey(enrichedCriteria, {
						pf: [...(opts.protocolFilter ?? [])].sort().join(',')
					})
				: null;

		let allReleases: ReleaseResult[] = [];
		let fromCache = false;
		if (interactiveCacheKey) {
			const cached = this.enhancedCache.get(interactiveCacheKey);
			if (cached && Date.now() - cached.cachedAt < SearchOrchestrator.ENHANCED_CACHE_TTL_MS) {
				logger.debug({ resultCount: cached.releases.length }, 'Enhanced search cache hit');
				allReleases = [...cached.releases];
				indexerResults.push(...cached.indexerResults);
				fromCache = true;
			} else if (cached) {
				this.enhancedCache.delete(interactiveCacheKey);
			}
		}

		if (!fromCache) {
			if (eligibleIndexers.length === 0) {
				logger.warn(
					{
						criteria: criteriaToString(enrichedCriteria)
					},
					'No eligible indexers for search'
				);
				return {
					releases: [],
					totalResults: 0,
					rejectedCount: 0,
					searchTimeMs: Date.now() - startTime,
					enrichTimeMs: 0,
					fromCache: false,
					indexerResults: [],
					rejectedIndexers
				};
			}

			// Sort by priority
			eligibleIndexers.sort((a, b) => {
				const statusA = this.statusTracker.getStatusSync(a.id);
				const statusB = this.statusTracker.getStatusSync(b.id);
				return statusA.priority - statusB.priority;
			});

			// Execute searches
			allReleases = await this.executeSearches(
				eligibleIndexers,
				enrichedCriteria,
				indexerResults,
				opts
			);

			if (interactiveCacheKey && allReleases.length > 0) {
				this.enhancedCache.set(interactiveCacheKey, {
					releases: [...allReleases],
					indexerResults: [...indexerResults],
					rejectedIndexers,
					cachedAt: Date.now()
				});
			}
		}

		const searchTimeMs = Date.now() - startTime;

		logger.debug(
			{
				indexerCounts: indexerResults.map((r) => ({
					indexer: r.indexerName,
					returned: r.results?.length ?? 0,
					duration: r.searchTimeMs,
					error: r.error
				}))
			},
			'Per-indexer result counts'
		);

		// Pass 1: Basic deduplication (by infoHash/title, prefer more seeders)
		const { releases: deduped } = this.deduplicator.deduplicate(allReleases);
		const afterDedupCount = deduped.length;

		// Get TV episode counts from TMDB for season-pack size validation and
		// RuTracker season-pack completion gating.
		let seriesEpisodeCount = opts.enrichment?.seriesEpisodeCount;
		let seasonEpisodeCounts = opts.enrichment?.seasonEpisodeCounts;
		if (
			isTvSearch(enrichedCriteria) &&
			enrichedCriteria.tmdbId &&
			(seriesEpisodeCount === undefined || !seasonEpisodeCounts || seasonEpisodeCounts.size === 0)
		) {
			const tvCounts = await this.getTvEpisodeCounts(enrichedCriteria.tmdbId);
			if (tvCounts) {
				seriesEpisodeCount ??= tvCounts.seriesEpisodeCount;
				seasonEpisodeCounts ??= tvCounts.seasonEpisodeCounts;
			}
		}

		let seasonEpisodeCount = opts.enrichment?.seasonEpisodeCount;
		if (
			seasonEpisodeCount === undefined &&
			isTvSearch(enrichedCriteria) &&
			enrichedCriteria.season !== undefined
		) {
			seasonEpisodeCount =
				seasonEpisodeCounts?.get(enrichedCriteria.season) ??
				(await this.getSeasonEpisodeCount(enrichedCriteria));
		}

		// Filter by season/episode if specified
		let filtered = await this.filterByBlocklist(deduped, enrichedCriteria);
		filtered = this.filterBySeasonEpisode(filtered, enrichedCriteria, {
			seasonEpisodeCount,
			seasonEpisodeCounts
		});
		const afterSeasonEpisodeCount = filtered.length;
		logger.debug(
			{ afterSeasonEpisode: afterSeasonEpisodeCount },
			'[SearchOrchestrator] DEBUG: after season/episode filter'
		);

		// Filter by category match (reject releases in wrong categories).
		// Skip for season-only TV searches: the season/episode filter already validated
		// these releases as season packs, and indexer categories are an unreliable signal
		// for packs (see isSeasonOnlyTvSearch).
		if (enrichedCriteria.searchType !== 'basic' && !this.isSeasonOnlyTvSearch(enrichedCriteria)) {
			const searchType = enrichedCriteria.searchType as 'movie' | 'tv' | 'music' | 'book';
			filtered = this.filterByCategoryMatch(filtered, searchType, enrichedCriteria);
		}
		const afterCategoryCount = filtered.length;
		logger.debug(
			{ afterCategory: afterCategoryCount },
			'[SearchOrchestrator] DEBUG: after category filter'
		);

		filtered = this.filterOutNonVideoArtifacts(filtered, enrichedCriteria);
		const afterNonVideoCount = filtered.length;
		logger.debug(
			{ afterNonVideo: afterNonVideoCount },
			'[SearchOrchestrator] DEBUG: after non-video filter'
		);

		// Hard filter by ID match with title+year fallback.
		// Also validates title relevance for releases without IDs.
		if (isMovieSearch(enrichedCriteria) || isTvSearch(enrichedCriteria)) {
			filtered = this.filterByIdOrTitleMatch(filtered, enrichedCriteria);
		}
		const afterIdTitleCount = filtered.length;
		logger.debug(
			{ afterIdTitle: afterIdTitleCount },
			'[SearchOrchestrator] DEBUG: after ID/title filter'
		);

		const afterFilteringCount = filtered.length;

		// Enrich with quality scoring and optional TMDB matching
		// Determine media type from search criteria for size validation
		const mediaType =
			enrichedCriteria.searchType === 'movie'
				? 'movie'
				: enrichedCriteria.searchType === 'tv'
					? 'tv'
					: undefined;

		// Build indexer config map for protocol-specific rejection (seeder minimums, dead torrents, etc.)
		const indexerConfigs = new Map<string, IndexerConfigForEnrichment>();
		for (const indexer of eligibleIndexers) {
			indexerConfigs.set(indexer.id, {
				id: indexer.id,
				name: indexer.name,
				protocol: indexer.protocol,
				protocolSettings: indexer.protocolSettings
			});
		}

		const enrichmentOpts: EnrichmentOptions = {
			scoringProfileId: opts.enrichment?.scoringProfileId,
			matchToTmdb: opts.enrichment?.matchToTmdb ?? false,
			tmdbHint: opts.enrichment?.tmdbHint,
			filterRejected: opts.enrichment?.filterRejected ?? false,
			minScore: opts.enrichment?.minScore,
			useEnhancedScoring: opts.enrichment?.useEnhancedScoring,
			mediaType,
			seasonEpisodeCount,
			seriesEpisodeCount,
			seasonEpisodeCounts,
			indexerConfigs
		};

		const enrichResult = await releaseEnricher.enrich(filtered, enrichmentOpts);

		// Surface interactive blocklist annotations through the existing
		// rejected-releases machinery (showRejected toggle + rejection
		// badges) instead of dropping the releases silently.
		const blocklistAnnotated = this.annotateBlocklistedReleases(enrichResult.releases);

		// Preferred-language boost for the enhanced path: applied AFTER enrichment
		// (protocol seeder checks during enrich saw the real seeders) as an
		// explicit totalScore contribution, re-sorted by totalScore. Semantics
		// match the rank path's boostByLanguage — see applyLanguageScoreBonus.
		const languageBoosted = this.applyLanguageScoreBonus(blocklistAnnotated, enrichedCriteria);
		// Graded ordered-preference boost (effective language profile) — see
		// applyAudioPreferenceBonus. Applied after the legacy single-code bonus
		// so both can contribute when a manual search also carries a profile.
		const audioPreferenceBoosted = this.applyAudioPreferenceBonus(
			languageBoosted,
			enrichedCriteria
		);

		// Pass 2: Enhanced deduplication using Radarr-style preference logic
		// Now that we have rejection counts, prefer releases with fewer rejections and higher indexer priority
		const { releases: smartDeduped } =
			this.deduplicator.deduplicateEnhanced(audioPreferenceBoosted);
		const afterEnrichmentCount = smartDeduped.length;

		logger.debug(
			{
				beforeDedup: blocklistAnnotated.length,
				afterDedup: smartDeduped.length,
				removed: blocklistAnnotated.length - smartDeduped.length
			},
			'[SearchOrchestrator] After enhanced deduplication'
		);

		// Apply limit (releases are already sorted by totalScore from enricher)
		const limited = enrichedCriteria.limit
			? smartDeduped.slice(0, enrichedCriteria.limit)
			: smartDeduped;

		// Assign releaseWeight (position in final sorted results, 1 = best)
		const withWeights = limited.map((release, index) => ({
			...release,
			releaseWeight: index + 1
		}));

		const result: EnhancedSearchResult = {
			releases: withWeights,
			totalResults: allReleases.length,
			afterDedup: afterDedupCount,
			afterFiltering: afterFilteringCount,
			filterBreakdown: {
				afterSeasonEpisode: afterSeasonEpisodeCount,
				afterCategory: afterCategoryCount,
				afterNonVideo: afterNonVideoCount,
				afterIdTitle: afterIdTitleCount
			},
			afterEnrichment: afterEnrichmentCount,
			rejectedCount: enrichResult.rejectedCount,
			searchTimeMs,
			enrichTimeMs: enrichResult.enrichTimeMs,
			fromCache,
			indexerResults,
			rejectedIndexers,
			scoringProfileId: enrichResult.scoringProfile?.id
		};

		logger.info(
			{
				totalResults: result.totalResults,
				afterDedup: result.afterDedup,
				afterFiltering: result.afterFiltering,
				afterEnrichment: result.afterEnrichment,
				returned: result.releases.length,
				rejected: result.rejectedCount,
				searchTimeMs: result.searchTimeMs,
				enrichTimeMs: result.enrichTimeMs
			},
			'Enhanced search completed'
		);

		return result;
	}

	/** Filter indexers based on criteria and options, returning both eligible and rejected */
	private filterIndexers(
		indexers: IIndexer[],
		criteria: SearchCriteria,
		options: ResolvedSearchOptions
	): { eligible: IIndexer[]; rejected: RejectedIndexer[] } {
		const eligible: IIndexer[] = [];
		const rejected: RejectedIndexer[] = [];

		for (const indexer of indexers) {
			// Check if indexer can handle this search type at all (categories + basic capability)
			// Use relaxed check that allows text-only indexers
			if (!this.canIndexerHandleSearchType(indexer, criteria)) {
				rejected.push({
					indexerId: indexer.id,
					indexerName: indexer.name,
					reason: 'searchType',
					message: `Cannot handle ${criteria.searchType} search (missing categories or search mode)`
				});
				logger.debug(
					{
						indexerId: indexer.id,
						searchType: criteria.searchType,
						tvSearchMode: indexer.capabilities.tvSearch,
						movieSearchMode: indexer.capabilities.movieSearch
					},
					`Indexer ${indexer.name} rejected: cannot handle search type`
				);
				continue;
			}

			// Check search source capability (interactive/automatic)
			if (options.searchSource) {
				let allowed = true;
				if (options.searchSource === 'interactive' && !indexer.enableInteractiveSearch) {
					allowed = false;
				} else if (options.searchSource === 'automatic' && !indexer.enableAutomaticSearch) {
					allowed = false;
				}
				if (!allowed) {
					rejected.push({
						indexerId: indexer.id,
						indexerName: indexer.name,
						reason: 'searchSource',
						message: `${options.searchSource} search is disabled for this indexer`
					});
					logger.debug(
						{
							indexerId: indexer.id,
							searchSource: options.searchSource,
							enableInteractiveSearch: indexer.enableInteractiveSearch,
							enableAutomaticSearch: indexer.enableAutomaticSearch
						},
						`Indexer ${indexer.name} rejected: ${options.searchSource} search disabled`
					);
					continue;
				}
			}

			// Check enabled status
			if (options.respectEnabled) {
				const status = this.statusTracker.getStatusSync(indexer.id);
				if (!status.isEnabled) {
					rejected.push({
						indexerId: indexer.id,
						indexerName: indexer.name,
						reason: 'disabled',
						message: 'Indexer is disabled'
					});
					logger.debug(
						{
							indexerId: indexer.id
						},
						`Indexer ${indexer.name} rejected: disabled by user`
					);
					continue;
				}
			}

			// Check backoff status
			if (options.respectBackoff) {
				if (!this.statusTracker.canUse(indexer.id)) {
					rejected.push({
						indexerId: indexer.id,
						indexerName: indexer.name,
						reason: 'backoff',
						message: 'Indexer auto-disabled due to repeated failures'
					});
					logger.debug(
						{
							indexerId: indexer.id
						},
						`Indexer ${indexer.name} rejected: in backoff period`
					);
					continue;
				}
			}

			// Check specific indexer filter
			if (criteria.indexerIds?.length && !criteria.indexerIds.includes(indexer.id)) {
				rejected.push({
					indexerId: indexer.id,
					indexerName: indexer.name,
					reason: 'indexerFilter',
					message: 'Excluded by indexer filter'
				});
				continue;
			}

			// Streamer profile must only search the internal Cinephage Library indexer.
			// This prevents auto-grab from hitting torrent/usenet/external indexers when
			// the profile is explicitly configured for .strm streaming behavior.
			if (
				options.enrichment?.scoringProfileId === 'streamer' &&
				indexer.definitionId !== CINEPHAGE_STREAM_DEFINITION_ID
			) {
				rejected.push({
					indexerId: indexer.id,
					indexerName: indexer.name,
					reason: 'indexerFilter',
					message: 'Excluded by streamer profile indexer rule (Cinephage Library only)'
				});
				logger.debug(
					{
						indexerId: indexer.id,
						definitionId: indexer.definitionId
					},
					`Indexer ${indexer.name} rejected: streamer profile rule`
				);
				continue;
			}

			// Check protocol filter (from scoring profile's allowedProtocols)
			// In interactive search, always allow streaming-protocol indexers so their
			// releases appear as rejected fallback options under "Show Rejected"
			if (options.protocolFilter && options.protocolFilter.length > 0) {
				const isStreamingInInteractive =
					options.searchSource === 'interactive' && indexer.protocol === 'streaming';
				if (!isStreamingInInteractive && !options.protocolFilter.includes(indexer.protocol)) {
					rejected.push({
						indexerId: indexer.id,
						indexerName: indexer.name,
						reason: 'protocol',
						message: `Protocol '${indexer.protocol}' not in allowed protocols: ${options.protocolFilter.join(', ')}`
					});
					logger.debug(
						{
							indexerId: indexer.id,
							protocol: indexer.protocol,
							allowedProtocols: options.protocolFilter
						},
						`Indexer ${indexer.name} rejected: protocol not allowed`
					);
					continue;
				}
			}

			logger.debug(
				{
					indexerId: indexer.id
				},
				`Indexer ${indexer.name} eligible for search`
			);
			eligible.push(indexer);
		}

		// Log summary at info level for visibility
		if (rejected.length > 0 || indexers.length > 0) {
			const rejectedByReason = rejected.reduce(
				(acc, r) => {
					acc[r.reason] = acc[r.reason] || [];
					acc[r.reason].push(r.indexerName);
					return acc;
				},
				{} as Record<string, string[]>
			);

			logger.info(
				{
					searchType: criteria.searchType,
					searchSource: options.searchSource,
					total: indexers.length,
					eligible: eligible.length,
					rejected: rejected.length,
					rejectedBySearchType: rejectedByReason.searchType,
					rejectedBySearchSource: rejectedByReason.searchSource,
					rejectedByDisabled: rejectedByReason.disabled,
					rejectedByBackoff: rejectedByReason.backoff,
					rejectedByFilter: rejectedByReason.indexerFilter,
					rejectedByProtocol: rejectedByReason.protocol,
					eligibleIndexers: eligible.map((i) => i.name)
				},
				'Indexer filtering complete'
			);
		}

		return { eligible, rejected };
	}

	private async executeSearches(
		indexers: IIndexer[],
		criteria: SearchCriteria,
		results: IndexerSearchResult[],
		options: ResolvedSearchOptions
	): Promise<ReleaseResult[]> {
		const allReleases: ReleaseResult[] = [];

		logger.debug(
			{
				indexerCount: indexers.length,
				criteria: { type: criteria.searchType, query: criteria.query }
			},
			'[executeSearches] Starting'
		);

		const allSettled = await Promise.allSettled(
			indexers.map((indexer) =>
				this.searchIndexer(indexer, criteria, options.timeout, options.useTieredSearch)
			)
		);

		for (const settled of allSettled) {
			if (settled.status === 'fulfilled') {
				const result = settled.value;
				logger.debug(
					{
						indexer: result.indexerName,
						resultCount: result.results.length,
						timeMs: result.searchTimeMs,
						error: result.error
					},
					'[executeSearches] Indexer result'
				);
				results.push(result);
				allReleases.push(...result.results);
			} else {
				logger.warn({ error: settled.reason }, '[executeSearches] Indexer search failed');
			}
		}

		logger.debug(
			{
				totalReleases: allReleases.length
			},
			'[executeSearches] Completed'
		);

		return allReleases;
	}

	/** Search a single indexer with tiered strategy */
	private async searchIndexer(
		indexer: IIndexer,
		criteria: SearchCriteria,
		timeout: number,
		useTieredSearch: boolean
	): Promise<IndexerSearchResult> {
		const startTime = Date.now();

		try {
			const limiter = this.rateLimitRegistry.get(indexer.id);

			// Atomically check and record rate limits — concurrent callers each see
			// the updated count, preventing all-zero thundering-herd reads.
			const rateCheck = this.hostRateLimiter.checkAndRecord(indexer.id, indexer.baseUrl, limiter);

			if (!rateCheck.canProceed) {
				logger.debug(
					{ indexer: indexer.name, reason: rateCheck.reason, waitTimeMs: rateCheck.waitTimeMs },
					'Rate limited'
				);

				if (rateCheck.waitTimeMs > timeout) {
					return {
						indexerId: indexer.id,
						indexerName: indexer.name,
						results: [],
						searchTimeMs: Date.now() - startTime,
						error: `Rate limited: ${rateCheck.reason} (wait: ${rateCheck.waitTimeMs}ms)`
					};
				}

				await this.delay(rateCheck.waitTimeMs);
				// Record after waiting, now that the window has advanced
				limiter.recordRequest();
				this.hostRateLimiter.recordRequest(indexer.baseUrl);
			}

			// Acquire a concurrency slot — limits simultaneous in-flight requests to
			// the same host (e.g., many Prowlarr indexers sharing one instance).
			const remainingMs = timeout - (Date.now() - startTime);
			const acquired = await this.hostConcurrencyLimiter.acquire(indexer.baseUrl, remainingMs);
			if (!acquired) {
				return {
					indexerId: indexer.id,
					indexerName: indexer.name,
					results: [],
					searchTimeMs: Date.now() - startTime,
					error: 'Concurrency limit: too many requests in-flight to this host'
				};
			}

			// Execute search with timeout; release concurrency slot when done (success or error)
			// A per-search AbortController lets us cancel still-in-flight work (and close
			// any headless browser it spawned) when the timeout wins the race, instead of
			// leaving it running while the host slot is handed to the next search.
			const abortController = new AbortController();
			const searchCriteria: SearchCriteria = { ...criteria, signal: abortController.signal };

			const searchPromise = useTieredSearch
				? this.executeWithTiering(indexer, searchCriteria)
				: this.executeSimple(indexer, searchCriteria);

			const { releases, searchMethod } = await Promise.race([
				searchPromise,
				this.createTimeoutPromise(timeout)
			]).finally(() => {
				abortController.abort();
				this.hostConcurrencyLimiter.release(indexer.baseUrl);
			});

			await this.statusTracker.recordSuccess(indexer.id, Date.now() - startTime);

			// Attach indexer priority to each release for Radarr-style deduplication
			// Lower priority number = higher preference (1 is highest priority)
			const indexerPriority = this.statusTracker.getStatusSync(indexer.id).priority;
			const releasesWithPriority = releases.map((r) => ({
				...r,
				indexerPriority
			}));

			return {
				indexerId: indexer.id,
				indexerName: indexer.name,
				results: releasesWithPriority,
				searchTimeMs: Date.now() - startTime,
				searchMethod
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			// Handle Cloudflare protection specifically
			if (error instanceof CloudflareProtectedError) {
				logger.warn(
					{
						indexer: indexer.name,
						host: error.host,
						statusCode: error.statusCode
					},
					'Cloudflare protection detected'
				);

				// Record failure with Cloudflare-specific message
				await this.statusTracker.recordFailure(
					indexer.id,
					`Cloudflare protection on ${error.host}`
				);

				return {
					indexerId: indexer.id,
					indexerName: indexer.name,
					results: [],
					searchTimeMs: Date.now() - startTime,
					error: `Cloudflare protection detected on ${error.host}`
				};
			}

			logger.warn(
				{
					indexer: indexer.name,
					error: message
				},
				'Indexer search failed'
			);

			// The indexer telling us outright that its API quota is exhausted is
			// authoritative, not flaky - disable it until the quota is expected to
			// reset rather than treating it like an ordinary transient failure.
			if (isQuotaExceededMessage(message)) {
				await this.statusTracker.recordQuotaExceeded(indexer.id, message);
				return {
					indexerId: indexer.id,
					indexerName: indexer.name,
					results: [],
					searchTimeMs: Date.now() - startTime,
					error: message
				};
			}

			// Timeouts are caused by slow upstream aggregators (Prowlarr/Jackett gathering
			// results across many trackers) and don't mean the indexer is broken.
			// Aborts are caller-initiated cancellations (early-exit sibling variants,
			// search race settled elsewhere), likewise not indexer health signals.
			// Only record a failure for actual errors.
			const lowerMessage = message.toLowerCase();
			const isTimeoutOrAbort = lowerMessage.includes('timeout') || lowerMessage.includes('abort');
			if (!isTimeoutOrAbort) {
				await this.statusTracker.recordFailure(indexer.id, message);
			}

			return {
				indexerId: indexer.id,
				indexerName: indexer.name,
				results: [],
				searchTimeMs: Date.now() - startTime,
				error: message
			};
		}
	}

	/** Execute search with tiered strategy: prefer ID search, fall back to text */
	private async executeWithTiering(
		indexer: IIndexer,
		criteria: SearchCriteria
	): Promise<{ releases: ReleaseResult[]; searchMethod: 'id' | 'text' }> {
		// Check if criteria has IDs AND if the indexer supports those specific IDs
		const indexerSupportsIds = this.indexerSupportsSearchIds(indexer, criteria);

		// Tier 1: If criteria has searchable IDs AND indexer supports them, use ID search.
		// If the ID query returns no results, fall back to text search for providers
		// with incomplete ID mapping (common on some Newznab instances).
		if (hasSearchableIds(criteria) && indexerSupportsIds) {
			const idCriteria = createIdOnlyCriteria(criteria);
			let idReleases = await indexer.search(idCriteria);

			const hasTextFallbackSource =
				!!criteria.query || !!(criteria.searchTitles && criteria.searchTitles.length > 0);

			// Some Newznab providers over-constrain movie ID searches when q/year
			// are present together. Retry once with IDs only before text fallback.
			// Prowlarr ID searches already send only the ID tokens, so the retry
			// would repeat the same request.
			if (
				idReleases.length === 0 &&
				isMovieSearch(criteria) &&
				(criteria.query || criteria.year) &&
				indexer.definitionId !== 'prowlarr'
			) {
				const movieIdOnlyCriteria = {
					...criteria,
					query: undefined,
					year: undefined
				};
				const movieIdOnlyReleases = await indexer.search(movieIdOnlyCriteria);
				if (movieIdOnlyReleases.length > 0) {
					logger.debug(
						{
							indexer: indexer.name,
							imdbId: criteria.imdbId,
							tmdbId: criteria.tmdbId
						},
						'Movie ID retry without q/year returned results'
					);
					idReleases = movieIdOnlyReleases;
				}
			}

			// An ID answer ends the search only when it holds a release that actually
			// matches; otherwise fall through to the title search and keep both.
			if (
				idReleases.length > 0 &&
				(!hasTextFallbackSource || this.hasRelevantReleases(idReleases, criteria))
			) {
				// For anime episode searches, also run an absolute-format text search ("Show 02")
				// even when the ID search succeeded.  ID search only finds releases catalogued as
				// season=N/ep=N; releases titled with the absolute episode number are missed.
				// We bypass executeMultiTitleTextSearch to avoid its early-exit-on-results logic
				// (which would skip the 'absolute' variant if standard/european/compact returned hits).
				if (
					criteria.isAnime &&
					isTvSearch(criteria) &&
					criteria.episode !== undefined &&
					hasTextFallbackSource
				) {
					const animeAbsoluteReleases = await this.executeAnimeAbsoluteSearch(
						indexer,
						criteria,
						idReleases
					);
					if (animeAbsoluteReleases.length > 0) {
						return {
							releases: [...idReleases, ...animeAbsoluteReleases],
							searchMethod: 'id'
						};
					}
				}

				return { releases: idReleases, searchMethod: 'id' };
			}

			if (!hasTextFallbackSource) {
				return { releases: [], searchMethod: 'id' };
			}

			logger.debug(
				{
					indexer: indexer.name,
					searchType: criteria.searchType,
					query: criteria.query,
					hasSearchTitles: !!criteria.searchTitles?.length
				},
				idReleases.length > 0
					? 'ID search returned no matching results, falling back to text search'
					: 'ID search returned no results, falling back to text search'
			);

			const fallbackReleases = await this.executeMultiTitleTextSearch(indexer, criteria);
			return { releases: [...idReleases, ...fallbackReleases], searchMethod: 'text' };
		}

		// Tier 2: Fall back to text search with multi-title support
		// This allows text-only indexers to participate
		// and searches with multiple titles for better regional tracker coverage
		const allReleases = await this.executeMultiTitleTextSearch(indexer, criteria);

		if (allReleases.length > 0) {
			return { releases: allReleases, searchMethod: 'text' };
		}

		// No results from any title variant
		if (!criteria.query && (!criteria.searchTitles || criteria.searchTitles.length === 0)) {
			logger.debug(
				{
					indexer: indexer.name
				},
				'Skipping indexer: no supported IDs and no query text'
			);
		}
		return { releases: [], searchMethod: 'text' };
	}

	/**
	 * Execute text search with multiple title variants.
	 * For TV searches, tries different episode format types based on indexer capabilities.
	 *
	 * Architecture note: Episode format handling is now driven by:
	 * 1. Indexer's searchFormats.episode capability (if specified in YAML)
	 * 2. Default fallback to all common formats (standard, european, compact)
	 *
	 * The query passed downstream is CLEAN (just the title). TemplateEngine is the
	 * sole component responsible for composing the final search keywords by adding
	 * the appropriate episode token to .Keywords.
	 */
	private async executeMultiTitleTextSearch(
		indexer: IIndexer,
		criteria: SearchCriteria
	): Promise<ReleaseResult[]> {
		const rawTitles: string[] =
			criteria.searchTitles && criteria.searchTitles.length > 0
				? criteria.searchTitles
				: criteria.query
					? [criteria.query]
					: [];

		let titlesToSearch = [...new Set(rawTitles.map((title) => title.trim()).filter(Boolean))];

		if (prefersNativeCyrillicTitles(indexer)) {
			const nativeCyrillicTitles = titlesToSearch.filter((title) => containsCyrillic(title));
			if (nativeCyrillicTitles.length > 0) {
				titlesToSearch = nativeCyrillicTitles;
			}

			titlesToSearch = [...titlesToSearch].sort((a, b) => {
				const aCyrillic = containsCyrillic(a) ? 1 : 0;
				const bCyrillic = containsCyrillic(b) ? 1 : 0;
				return bCyrillic - aCyrillic;
			});
		}

		if (titlesToSearch.length === 0) {
			return [];
		}

		if (this.shouldUseRuTrackerAutomaticSeasonSearch(indexer, criteria)) {
			return this.executeRuTrackerAutomaticSeasonSearch(indexer, criteria, titlesToSearch);
		}

		let episodeFormats: EpisodeFormat[] = [];
		if (isTvSearch(criteria)) {
			const hasEpisode = criteria.episode !== undefined;
			const hasPositiveSeason = criteria.season !== undefined && criteria.season > 0;
			if (!hasEpisode && !hasPositiveSeason) {
				episodeFormats = [];
			} else {
				const formatTypes = getEffectiveEpisodeFormats(
					indexer.capabilities.searchFormats?.episode,
					true
				);
				// Anime uses absolute episode numbering (01, 02...) in addition to standard
				// S01E05. Merge absolute into the format list so both query variants are tried.
				const effectiveFormats =
					criteria.isAnime && hasEpisode
						? [...new Set([...formatTypes, ...ANIME_EPISODE_FORMATS])]
						: formatTypes;
				episodeFormats = getEpisodeFormats(criteria, effectiveFormats);
			}
		}

		const titleBudget = prefersNativeCyrillicTitles(indexer) ? 5 : 3;
		const variantCriteria: SearchCriteria[] = [];

		for (const title of titlesToSearch.slice(0, titleBudget)) {
			if (episodeFormats.length > 0) {
				const shouldTryInteractiveTvTitleOnlyFallback =
					isTvSearch(criteria) &&
					criteria.searchSource === 'interactive' &&
					(criteria.season !== undefined || criteria.episode !== undefined);

				for (const format of episodeFormats) {
					variantCriteria.push(
						createTextOnlyCriteria({
							...criteria,
							query: title,
							preferredEpisodeFormat: format.type
						})
					);
				}

				if (shouldTryInteractiveTvTitleOnlyFallback) {
					variantCriteria.push(
						createTextOnlyCriteria({
							...criteria,
							query: title,
							season: undefined,
							episode: undefined,
							preferredEpisodeFormat: undefined
						})
					);
				}
			} else if (isMovieSearch(criteria)) {
				const movieFormats = indexer.capabilities.searchFormats?.movie ?? ['standard', 'noYear'];
				const seenMovieVariants = new Set<string>();

				for (const format of movieFormats) {
					let movieQuery = title;
					let movieYear = criteria.year;

					if (format === 'noYear') {
						movieYear = undefined;
					} else if (format === 'yearOnly') {
						if (!criteria.year) continue;
						movieQuery = String(criteria.year);
						movieYear = undefined;
					}

					const variantKey = `${movieQuery}::${movieYear ?? ''}`;
					if (seenMovieVariants.has(variantKey)) {
						continue;
					}
					seenMovieVariants.add(variantKey);

					variantCriteria.push(
						createTextOnlyCriteria({
							...criteria,
							query: movieQuery,
							year: movieYear
						})
					);
				}
			} else {
				variantCriteria.push(
					createTextOnlyCriteria({
						...criteria,
						query: title
					})
				);
			}
		}

		const allReleases: ReleaseResult[] = [];
		const seenGuids = new Set<string>();
		let successfulVariants = 0;
		const variantErrors: string[] = [];
		const BATCH_SIZE = 3;

		for (let i = 0; i < variantCriteria.length; i += BATCH_SIZE) {
			// Early exit: a matching release from a previous batch means an earlier
			// title already answered the search - skip remaining variants to avoid
			// redundant requests. This prevents FlareSolverr-backed indexers from being
			// overwhelmed by follow-up queries that can't finish within the per-indexer
			// timeout. Unrelated results (a generic localized title hitting other
			// content) don't count, so the next title still gets its turn.
			if (this.hasRelevantReleases(allReleases, criteria)) {
				break;
			}

			const batch = variantCriteria.slice(i, i + BATCH_SIZE);
			// Movie variants are redundant reformulations of the same query
			// (title±year), so the first variant that returns a matching release
			// answers the search - don't block on slower siblings stuck in Cloudflare
			// bypass, or their stall eats the whole per-indexer timeout and discards
			// the results already parsed (TV episode formats are alternative
			// encodings, not nested queries, so they still merge every variant).
			const answersSearch = isMovieSearch(criteria)
				? (releases: ReleaseResult[]) => this.hasRelevantReleases(releases, criteria)
				: null;
			const { settled } = await this.settleVariantBatch(
				batch.map((vc) => indexer.search(vc)),
				answersSearch
			);

			for (let j = 0; j < batch.length; j++) {
				const vc = batch[j];
				const result = settled[j];
				if (!result) continue;
				if (result.status === 'fulfilled') {
					successfulVariants++;
					for (const release of result.value) {
						if (!seenGuids.has(release.guid)) {
							seenGuids.add(release.guid);
							allReleases.push(release);
						}
					}
				} else {
					const message =
						result.reason instanceof Error ? result.reason.message : String(result.reason);
					variantErrors.push(message);
					logger.debug(
						{
							indexer: indexer.name,
							query: vc.query,
							format: (vc as { preferredEpisodeFormat?: string }).preferredEpisodeFormat,
							error: message
						},
						'Multi-title search variant failed'
					);
				}
			}
		}

		if (variantCriteria.length > 0 && successfulVariants === 0 && variantErrors.length > 0) {
			const uniqueErrors = [...new Set(variantErrors.filter(Boolean))];
			throw new Error(uniqueErrors.slice(0, 2).join('; ') || 'All text search attempts failed');
		}

		if (allReleases.length > 0) {
			logger.debug(
				{
					indexer: indexer.name,
					titlesSearched: Math.min(titlesToSearch.length, titleBudget),
					formatsUsed: episodeFormats.length || 1,
					totalResults: allReleases.length
				},
				'Multi-title text search completed'
			);
		}

		return allReleases;
	}

	private shouldUseRuTrackerAutomaticSeasonSearch(
		indexer: IIndexer,
		criteria: SearchCriteria
	): boolean {
		return (
			isTvSearch(criteria) &&
			criteria.season !== undefined &&
			criteria.episode !== undefined &&
			isRuTrackerHost(indexer.baseUrl) &&
			isRuTrackerIndexerName(indexer.name)
		);
	}

	/**
	 * Send one `absolute`-format text query per title ("Show 02") to catch anime releases
	 * that use absolute episode numbering rather than S01E02.  Only new GUIDs are returned
	 * (already-seen GUIDs from the ID search are excluded via `seenReleases`).
	 */
	private async executeAnimeAbsoluteSearch(
		indexer: IIndexer,
		criteria: SearchCriteria,
		seenReleases: ReleaseResult[]
	): Promise<ReleaseResult[]> {
		const rawTitles =
			criteria.searchTitles && criteria.searchTitles.length > 0
				? criteria.searchTitles
				: criteria.query
					? [criteria.query]
					: [];

		const seenGuids = new Set(seenReleases.map((r) => r.guid));
		const newReleases: ReleaseResult[] = [];

		for (const title of rawTitles.slice(0, 3)) {
			const absoluteCriteria = createTextOnlyCriteria({
				...criteria,
				query: title,
				preferredEpisodeFormat: 'absolute'
			});
			try {
				const releases = await indexer.search(absoluteCriteria);
				for (const r of releases) {
					if (!seenGuids.has(r.guid)) {
						seenGuids.add(r.guid);
						newReleases.push(r);
					}
				}
			} catch (err) {
				logger.debug(
					{ indexer: indexer.name, title, error: err instanceof Error ? err.message : String(err) },
					'Anime absolute search variant failed'
				);
			}
		}

		return newReleases;
	}

	private async executeRuTrackerAutomaticSeasonSearch(
		indexer: IIndexer,
		criteria: SearchCriteria,
		titlesToSearch: string[]
	): Promise<ReleaseResult[]> {
		const cacheKey = this.buildRuTrackerAutomaticSeasonCacheKey(indexer, criteria, titlesToSearch);
		const now = Date.now();
		const cached = this.rutrackerAutomaticSeasonSearchCache.get(cacheKey);

		if (cached && now - cached.cachedAtMs <= RUTRACKER_AUTOMATIC_SEASON_CACHE_TTL_MS) {
			return cached.releases;
		}

		const existingInFlight = this.rutrackerAutomaticSeasonSearchInFlight.get(cacheKey);
		if (existingInFlight) {
			return existingInFlight;
		}

		const inFlightPromise = this.enqueueRuTrackerAutomaticSeasonSearch(async () => {
			const allReleases: ReleaseResult[] = [];
			const seenGuids = new Set<string>();
			const limitedTitles = titlesToSearch.slice(0, RUTRACKER_AUTOMATIC_MAX_TITLES);
			let anyTitleSucceeded = false;

			for (const title of limitedTitles) {
				const seasonOnlyCriteria = createTextOnlyCriteria({
					...criteria,
					query: title,
					episode: undefined,
					preferredEpisodeFormat: 'standard'
				});

				try {
					const releases = await indexer.search(seasonOnlyCriteria);
					anyTitleSucceeded = true;
					for (const release of releases) {
						if (!seenGuids.has(release.guid)) {
							seenGuids.add(release.guid);
							allReleases.push(release);
						}
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logger.debug(
						{
							indexer: indexer.name,
							title,
							error: message
						},
						'Pointer-indexer season search variant failed'
					);
				}
			}

			// Poison-cache guard: when EVERY variant failed (timeout, abort, auth),
			// the accumulated empty set is not a truthful answer — caching it would
			// serve "no results" for the whole TTL and never retry. Only cache when
			// at least one query actually reached the indexer.
			if (anyTitleSucceeded) {
				this.rutrackerAutomaticSeasonSearchCache.set(cacheKey, {
					cachedAtMs: Date.now(),
					releases: allReleases
				});
			}

			return allReleases;
		});

		this.rutrackerAutomaticSeasonSearchInFlight.set(cacheKey, inFlightPromise);
		try {
			return await inFlightPromise;
		} finally {
			this.rutrackerAutomaticSeasonSearchInFlight.delete(cacheKey);
		}
	}

	private enqueueRuTrackerAutomaticSeasonSearch<T>(work: () => Promise<T>): Promise<T> {
		const queuedWork = this.rutrackerAutomaticSearchLane.then(work, work);
		this.rutrackerAutomaticSearchLane = queuedWork.then(
			() => undefined,
			() => undefined
		);
		return queuedWork;
	}

	private buildRuTrackerAutomaticSeasonCacheKey(
		indexer: IIndexer,
		criteria: SearchCriteria,
		titlesToSearch: string[]
	): string {
		const tmdbId = 'tmdbId' in criteria ? criteria.tmdbId : undefined;
		const tvdbId = 'tvdbId' in criteria ? criteria.tvdbId : undefined;
		const imdbId = 'imdbId' in criteria ? criteria.imdbId : undefined;
		const season = 'season' in criteria ? criteria.season : undefined;
		const primaryId =
			tmdbId?.toString() ?? tvdbId?.toString() ?? imdbId ?? criteria.query ?? 'unknown';
		const normalizedTitles = titlesToSearch
			.slice(0, RUTRACKER_AUTOMATIC_MAX_TITLES)
			.map((title) => this.normalizeForComparison(title))
			.filter(Boolean)
			.join('|');
		return `${indexer.id}::${primaryId}::s${season ?? 'x'}::${normalizedTitles}`;
	}

	/** Check if the indexer supports the specific IDs in the search criteria */
	private indexerSupportsSearchIds(indexer: IIndexer, criteria: SearchCriteria): boolean {
		const caps = indexer.capabilities;

		if (isMovieSearch(criteria)) {
			// Check if indexer supports any of the IDs in the criteria
			if (criteria.imdbId && supportsParam(caps, 'movie', 'imdbId')) return true;
			if (criteria.tmdbId && supportsParam(caps, 'movie', 'tmdbId')) return true;
			return false;
		}

		if (isTvSearch(criteria)) {
			// Check if indexer supports any of the IDs in the criteria
			if (criteria.imdbId && supportsParam(caps, 'tv', 'imdbId')) return true;
			if (criteria.tmdbId && supportsParam(caps, 'tv', 'tmdbId')) return true;
			if (criteria.tvdbId && supportsParam(caps, 'tv', 'tvdbId')) return true;
			if (criteria.tvMazeId && supportsParam(caps, 'tv', 'tvMazeId')) return true;
			return false;
		}

		return false;
	}

	/**
	 * Check if indexer can handle the search type (categories + basic capability).
	 * This is a relaxed check that allows text-only indexers.
	 */
	private canIndexerHandleSearchType(indexer: IIndexer, criteria: SearchCriteria): boolean {
		const caps = indexer.capabilities;
		const searchType = criteria.searchType;

		// A user-configured "restrict to only these categories" setting narrows
		// eligibility below what the indexer natively supports (e.g. an indexer
		// that supports both Movies and TV, but the user restricted this
		// instance to Movies only). Without this check the restriction only
		// ever affected the outgoing cat= parameter, never whether the indexer
		// was queried at all.
		if (!restrictionAllowsSearchType(indexer.additionalCategories, searchType)) {
			return false;
		}

		// Check categories match (movie indexer for movie search, etc.)
		if (searchType === 'movie') {
			const hasMovieCategories = indexerHasCategoriesForSearchType(caps.categories, 'movie');
			if (!hasMovieCategories) return false;
			// Check if movie search mode is available (regardless of ID support)
			return caps.movieSearch?.available ?? false;
		}

		if (searchType === 'tv') {
			const hasTvCategories = indexerHasCategoriesForSearchType(caps.categories, 'tv');
			if (!hasTvCategories) return false;
			// Check if TV search mode is available (regardless of ID support)
			return caps.tvSearch?.available ?? false;
		}

		// Basic search - just needs to be enabled
		return true;
	}

	/** Simple search without tiering */
	private async executeSimple(
		indexer: IIndexer,
		criteria: SearchCriteria
	): Promise<{ releases: ReleaseResult[]; searchMethod: 'text' }> {
		const releases = await indexer.search(criteria);
		return { releases, searchMethod: 'text' };
	}

	/**
	 * Await a batch of variant searches. With `answersSearch`, resolve as soon as
	 * any variant fulfills with results it accepts; slower siblings keep running
	 * in the background and their outcomes are ignored (their rejections stay
	 * handled, and the outer AbortController cancels them on timeout).
	 * Entries for still-in-flight variants remain unset when we resolve early.
	 */
	private settleVariantBatch(
		promises: Promise<ReleaseResult[]>[],
		answersSearch: ((releases: ReleaseResult[]) => boolean) | null
	): Promise<{ settled: PromiseSettledResult<ReleaseResult[]>[] }> {
		if (!answersSearch) {
			return Promise.allSettled(promises).then((settled) => ({ settled }));
		}

		return new Promise((resolve) => {
			const settled: PromiseSettledResult<ReleaseResult[]>[] = new Array(promises.length);
			let pending = promises.length;
			let finished = false;

			const finishIfAllSettled = () => {
				if (!finished && pending === 0) {
					finished = true;
					resolve({ settled });
				}
			};

			promises.forEach((promise, index) => {
				promise.then(
					(value) => {
						if (finished) return;
						settled[index] = { status: 'fulfilled', value };
						pending -= 1;
						if (Array.isArray(value) && answersSearch(value)) {
							finished = true;
							resolve({ settled });
							return;
						}
						finishIfAllSettled();
					},
					(reason) => {
						if (finished) return;
						settled[index] = { status: 'rejected', reason };
						pending -= 1;
						finishIfAllSettled();
					}
				);
			});
		});
	}

	/** Create a timeout promise */
	private createTimeoutPromise(timeout: number): Promise<never> {
		return new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`Search timeout after ${timeout}ms`)), timeout)
		);
	}

	/** Delay for given milliseconds */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Filter releases by season/episode when specified in criteria.
	 *
	 * For movie searches: Rejects releases that are clearly TV episodes (have S01E03 patterns)
	 *
	 * For TV searches with season/episode specified:
	 * - Season-only search: Returns single-season packs that exactly match the target season
	 *   (multi-season packs and complete series are excluded; pointer-indexer packs must be verifiably complete)
	 * - Season+episode search:
	 *   - RuTracker/Kinozal: returns episode pointers from matching season packs (never raw season packs)
	 *   - Other indexers:
	 *     - interactive: returns exact episodes, falls back to season-pack pointers
	 *     - automatic: returns exact episodes and season-pack candidates
	 * - Episode-only search:
	 *   - RuTracker/Kinozal: returns episode pointers from matching season packs (never raw season packs)
	 *   - Other indexers:
	 *     - interactive: returns exact episodes, falls back to season-pack pointers
	 *     - automatic: returns exact episodes and season-pack candidates
	 *
	 * Optimization: Caches parsed results on releases to avoid re-parsing in enricher.
	 */
	private filterBySeasonEpisode(
		releases: ReleaseResult[],
		criteria: SearchCriteria,
		context?: SeasonEpisodeFilterContext
	): ReleaseResult[] {
		// For movie searches, reject releases that are clearly TV episodes.
		// Parses run in 'movie' mode: ambiguous word-based "Season N" markers are
		// not extracted (movie titles like "Open Season 3" are not season packs),
		// while unambiguous TV notation (SxxExx) is still detected and rejected.
		if (isMovieSearch(criteria)) {
			const searchTmdbId = criteria.tmdbId;
			const searchImdbId = criteria.imdbId;

			return releases.filter((release) => {
				// ID-first classification: when the release carries an ID, it decides —
				// an ID match means the release IS the searched movie, and title-based
				// parsing (which can misread titles like "Open Season 3" as TV season
				// packs) never overrides it. Native-Cyrillic tracker ID mismatches are
				// definitive; aggregator ID mismatches fall through to title parsing.
				if (searchTmdbId && release.tmdbId) {
					if (release.tmdbId === searchTmdbId) return true;
					if (
						prefersNativeCyrillicTitles({
							name: release.indexerName ?? ''
						} as IIndexer)
					) {
						return false;
					}
				}
				if (searchImdbId && release.imdbId) {
					if (release.imdbId === searchImdbId) return true;
					if (
						prefersNativeCyrillicTitles({
							name: release.indexerName ?? ''
						} as IIndexer)
					) {
						return false;
					}
				}

				const releaseWithCache = release as ReleaseResult & {
					_parsedRelease?: ReturnType<typeof parseRelease>;
				};
				if (!releaseWithCache._parsedRelease) {
					releaseWithCache._parsedRelease = parseRelease(release.title, {
						sourceLanguage: release.sourceLanguage,
						mode: 'movie'
					});
				}
				const parsed = releaseWithCache._parsedRelease;

				if (parsed.episode) {
					logger.debug(
						{
							title: release.title,
							episode: parsed.episode
						},
						'[SearchOrchestrator] Rejecting TV release for movie search'
					);
					return false;
				}
				return true;
			});
		}

		if (!isTvSearch(criteria)) {
			return releases;
		}

		const targetSeason = criteria.season;
		const targetEpisode = criteria.episode;
		const isInteractiveSearch = criteria.searchSource === 'interactive';
		const expectedSeasonEpisodeCount =
			targetSeason === undefined
				? undefined
				: (context?.seasonEpisodeCount ?? context?.seasonEpisodeCounts?.get(targetSeason));

		// If no season/episode specified, return all
		if (targetSeason === undefined && targetEpisode === undefined) {
			return releases;
		}

		const parsedReleases = releases
			.map((release) => {
				// Parse the release title to get episode info
				// Cache parsed result on release to avoid re-parsing in ReleaseEnricher
				const releaseWithCache = release as ReleaseResult & {
					_parsedRelease?: ReturnType<typeof parseRelease>;
				};
				if (!releaseWithCache._parsedRelease) {
					releaseWithCache._parsedRelease = parseRelease(release.title, {
						sourceLanguage: release.sourceLanguage
					});
				}
				return {
					release,
					episodeInfo: releaseWithCache._parsedRelease.episode
				};
			})
			.filter(
				(
					item
				): item is {
					release: ReleaseResult;
					episodeInfo: NonNullable<ReturnType<typeof parseRelease>['episode']>;
				} => Boolean(item.episodeInfo)
			);

		const isSingleSeasonMatch = (
			episodeInfo: NonNullable<ReturnType<typeof parseRelease>['episode']>
		): boolean => {
			// Reject complete series packs (e.g., "Complete Series", "All Seasons")
			if (episodeInfo.isCompleteSeries) {
				return false;
			}
			// Reject multi-season packs (e.g., S01-S05, Seasons 1-5)
			if (episodeInfo.seasons && episodeInfo.seasons.length > 1) {
				return false;
			}
			// Single season: exact match
			return targetSeason !== undefined && episodeInfo.season === targetSeason;
		};

		const seasonPackContainsEpisode = (
			episodeInfo: NonNullable<ReturnType<typeof parseRelease>['episode']>,
			episode: number
		): boolean => {
			if (!episodeInfo.isSeasonPack) return false;
			if (episodeInfo.episodes && episodeInfo.episodes.length > 0) {
				return episodeInfo.episodes.includes(episode);
			}
			// If pack episode boundaries are unknown, keep as a fallback candidate.
			return true;
		};

		// Season-only search: filter to single-season packs matching the target season.
		if (targetSeason !== undefined && targetEpisode === undefined) {
			const isAnimeSearch = isTvSearch(criteria) && !!criteria.isAnime;
			const parsedMatches = parsedReleases
				.filter(
					({ release, episodeInfo }) =>
						episodeInfo.isSeasonPack &&
						isSingleSeasonMatch(episodeInfo) &&
						this.isAllowedSeasonPackForSeasonOnlySearch(
							release,
							episodeInfo,
							expectedSeasonEpisodeCount
						)
				)
				.map(({ release }) => this.withFormattedSeasonPackTitle(release));

			if (!isAnimeSearch) {
				return parsedMatches;
			}

			// Anime trackers use non-standard pack formats like "[01-08 END]" that the
			// episode parser cannot classify (episodeInfo=null). These are overwhelmingly
			// season/series packs rather than individual episodes, so include them and let
			// the title filter reject releases that don't match the show name.
			// The _parsedRelease cache is already populated by the parsedReleases map above.
			const animeUnparsedReleases = releases.filter((release) => {
				const cached = release as ReleaseResult & {
					_parsedRelease?: ReturnType<typeof parseRelease>;
				};
				return !cached._parsedRelease?.episode;
			});

			return [...parsedMatches, ...animeUnparsedReleases];
		}

		// Season + episode search:
		// - interactive: prefer exact episodes, fallback to matching single-season packs
		// - automatic: include exact episodes and matching single-season packs
		if (targetSeason !== undefined && targetEpisode !== undefined) {
			const isAnimeSearch = isTvSearch(criteria) && !!criteria.isAnime;

			const exactEpisodeMatches = parsedReleases.filter(
				({ episodeInfo }) =>
					!episodeInfo.isSeasonPack &&
					episodeInfo.season === targetSeason &&
					episodeInfo.episodes?.includes(targetEpisode)
			);
			// Anime uses absolute episode numbering without an explicit season token.
			// The parser sets `absoluteEpisode` (not `episodes`) for these releases:
			// e.g. "Kegareboshi - 01" → { absoluteEpisode: 1, season: undefined }.
			// Accept them when the absolute episode number matches the target episode.
			const animeAbsoluteMatches = isAnimeSearch
				? parsedReleases.filter(
						({ episodeInfo }) =>
							!episodeInfo.isSeasonPack &&
							episodeInfo.season === undefined &&
							episodeInfo.absoluteEpisode === targetEpisode
					)
				: [];
			const allExactMatches = [...exactEpisodeMatches, ...animeAbsoluteMatches];

			const seasonPackMatches = parsedReleases.filter(
				({ episodeInfo }) =>
					episodeInfo.isSeasonPack &&
					isSingleSeasonMatch(episodeInfo) &&
					seasonPackContainsEpisode(episodeInfo, targetEpisode)
			);
			const rutrackerSeasonPackPointers = seasonPackMatches
				.filter(({ release }) => this.shouldCreateRutrackerEpisodePointer(release))
				.map(({ release, episodeInfo }) =>
					this.createEpisodePointerRelease(release, targetEpisode, targetSeason, episodeInfo)
				);
			const nonRuTrackerExactReleases = allExactMatches
				.filter(({ release }) => !this.shouldCreateRutrackerEpisodePointer(release))
				.map(({ release }) => release);
			const nonRuTrackerSeasonPackReleases = seasonPackMatches
				.filter(({ release }) => !this.shouldCreateRutrackerEpisodePointer(release))
				.map(({ release }) => release);

			// Anime packs like "[01-08 END]" have episodeInfo=null and are absent from
			// parsedReleases. Surface them as a fallback when no individual episode file
			// or parsed season pack is found; the title filter rejects wrong shows.
			const animeUnparsedFallback = isAnimeSearch
				? releases.filter((release) => {
						const cached = release as ReleaseResult & {
							_parsedRelease?: ReturnType<typeof parseRelease>;
						};
						return !cached._parsedRelease?.episode;
					})
				: [];

			if (isInteractiveSearch) {
				if (rutrackerSeasonPackPointers.length > 0) {
					return [...nonRuTrackerExactReleases, ...rutrackerSeasonPackPointers];
				}

				if (nonRuTrackerExactReleases.length > 0) {
					return nonRuTrackerExactReleases;
				}

				return [
					...seasonPackMatches.map(({ release, episodeInfo }) =>
						this.createEpisodePointerRelease(release, targetEpisode, targetSeason, episodeInfo)
					),
					...animeUnparsedFallback
				];
			}

			return [
				...nonRuTrackerExactReleases,
				...rutrackerSeasonPackPointers,
				...nonRuTrackerSeasonPackReleases,
				...animeUnparsedFallback
			];
		}

		// Episode-only search (rare):
		// - interactive: prefer exact episode match, fallback to season packs containing episode
		// - automatic: include exact episodes and season packs
		if (targetEpisode !== undefined) {
			const exactEpisodeMatches = parsedReleases.filter(
				({ episodeInfo }) =>
					!episodeInfo.isSeasonPack && episodeInfo.episodes?.includes(targetEpisode)
			);
			const seasonPackMatches = parsedReleases.filter(({ episodeInfo }) =>
				seasonPackContainsEpisode(episodeInfo, targetEpisode)
			);
			const rutrackerSeasonPackPointers = seasonPackMatches
				.filter(({ release }) => this.shouldCreateRutrackerEpisodePointer(release))
				.map(({ release, episodeInfo }) =>
					this.createEpisodePointerRelease(release, targetEpisode, undefined, episodeInfo)
				);
			const nonRuTrackerExactReleases = exactEpisodeMatches
				.filter(({ release }) => !this.shouldCreateRutrackerEpisodePointer(release))
				.map(({ release }) => release);
			const nonRuTrackerSeasonPackReleases = seasonPackMatches
				.filter(({ release }) => !this.shouldCreateRutrackerEpisodePointer(release))
				.map(({ release }) => release);

			if (isInteractiveSearch) {
				if (rutrackerSeasonPackPointers.length > 0) {
					return [...nonRuTrackerExactReleases, ...rutrackerSeasonPackPointers];
				}

				if (nonRuTrackerExactReleases.length > 0) {
					return nonRuTrackerExactReleases;
				}

				return seasonPackMatches.map(({ release, episodeInfo }) =>
					this.createEpisodePointerRelease(release, targetEpisode, undefined, episodeInfo)
				);
			}

			return [
				...nonRuTrackerExactReleases,
				...rutrackerSeasonPackPointers,
				...nonRuTrackerSeasonPackReleases
			];
		}

		return releases;
	}

	private shouldCreateRutrackerEpisodePointer(release: ReleaseResult): boolean {
		return isRuTrackerIndexerName(release.indexerName);
	}

	private isAllowedSeasonPackForSeasonOnlySearch(
		release: ReleaseResult,
		episodeInfo: NonNullable<ReturnType<typeof parseRelease>['episode']>,
		expectedSeasonEpisodeCount?: number
	): boolean {
		if (!isRuTrackerIndexerName(release.indexerName)) {
			return true;
		}

		const isCompleted = this.isCompletedRuTrackerSeasonPack(
			release.title,
			episodeInfo,
			expectedSeasonEpisodeCount
		);

		if (!isCompleted) {
			logger.debug(
				{
					title: release.title,
					indexer: release.indexerName,
					expectedSeasonEpisodeCount
				},
				'[SearchOrchestrator] Rejecting incomplete pointer-indexer season pack for season-only search'
			);
		}

		return isCompleted;
	}

	private isCompletedRuTrackerSeasonPack(
		title: string,
		episodeInfo: NonNullable<ReturnType<typeof parseRelease>['episode']>,
		expectedSeasonEpisodeCount?: number
	): boolean {
		if (!episodeInfo.isSeasonPack) {
			return false;
		}

		if (this.titleLooksLikeMultiSeasonPack(title)) {
			return false;
		}

		const coveredEpisodes = Array.from(
			new Set((episodeInfo.episodes ?? []).filter((ep) => Number.isInteger(ep) && ep > 0))
		).sort((a, b) => a - b);
		if (coveredEpisodes.length === 0) {
			return false;
		}

		const explicitTotal = this.extractExplicitSeasonEpisodeTotal(title);
		const expectedTotal =
			typeof expectedSeasonEpisodeCount === 'number' && expectedSeasonEpisodeCount > 0
				? expectedSeasonEpisodeCount
				: explicitTotal;

		// For pointer-indexer season-pack grabs we require a verifiable complete-season signal.
		if (expectedTotal === undefined || expectedTotal <= 0) {
			return false;
		}

		if (coveredEpisodes[0] !== 1) {
			return false;
		}

		const maxCoveredEpisode = coveredEpisodes[coveredEpisodes.length - 1];
		if (maxCoveredEpisode !== expectedTotal || coveredEpisodes.length !== expectedTotal) {
			return false;
		}

		for (let episodeNumber = 1; episodeNumber <= expectedTotal; episodeNumber++) {
			if (coveredEpisodes[episodeNumber - 1] !== episodeNumber) {
				return false;
			}
		}

		return true;
	}

	private titleLooksLikeMultiSeasonPack(title: string): boolean {
		const multiSeasonPatterns = [
			/\bseasons?\s*[:\s]*\d{1,2}\s*[-–]\s*\d{1,2}\b/iu,
			/\bseason\s*[:\s]*\d{1,2}\s*-\s*\d{1,2}\b/iu,
			/\bS\d{1,2}\s*[-–]\s*S?\d{1,2}\b/iu,
			/\bepisodes?\s*[:\s]*\d{1,3}\s*[-–]\s*\d{3,4}\b/iu
		];
		return multiSeasonPatterns.some((pattern) => pattern.test(title));
	}

	private extractExplicitSeasonEpisodeTotal(title: string): number | undefined {
		const patterns = [
			/\bepisodes?\s*:\s*\d{1,3}\s*[-–]\s*\d{1,3}\s*of\s*(\d{1,3})\b/iu,
			/\bS\d{1,2}E\d{1,3}\s*[-–]\s*\d{1,3}\s*of\s*(\d{1,3})\b/iu,
			/\bS\d{1,2}E\d{1,3}\s*[-–]\s*\d{1,3}\s+(\d{1,3})\b/iu
		];
		for (const pattern of patterns) {
			const match = title.match(pattern);
			if (!match) {
				continue;
			}
			const parsed = Number(match[1]);
			if (Number.isInteger(parsed) && parsed > 0) {
				return parsed;
			}
		}
		return undefined;
	}

	/**
	 * Build an interactive episode pointer from a season pack release.
	 * The pointer keeps the original download URL, but presents an episode-focused title.
	 */
	private createEpisodePointerRelease(
		release: ReleaseResult,
		targetEpisode: number,
		targetSeason: number | undefined,
		episodeInfo: NonNullable<ReturnType<typeof parseRelease>['episode']>
	): ReleaseResult {
		const season = targetSeason ?? episodeInfo.season;
		const episodeToken = this.formatEpisodeToken(season, targetEpisode);
		const readablePointer =
			season === undefined
				? `Episode ${targetEpisode}`
				: `Season ${season} Episode ${targetEpisode}`;
		const cleanedTitle = this.formatPointerDisplayTitle(release.title);

		// Estimate per-episode size for display when pack episode count is known.
		const episodeCount = episodeInfo.episodes?.length ?? 0;
		const pointerSize =
			episodeCount > 0 && release.size > 0
				? Math.max(1, Math.round(release.size / episodeCount))
				: release.size;

		return {
			...release,
			guid: `${release.guid}::episode-pointer::${episodeToken.toLowerCase()}`,
			title: `${readablePointer} - ${cleanedTitle}`,
			size: pointerSize,
			season,
			episode: targetEpisode
		};
	}

	private formatPointerDisplayTitle(title: string): string {
		let normalized = title.trim();
		normalized = normalized.replace(/^\s*[-–—]+\s*\/\s*/u, '');
		normalized = normalized.replace(/^\s*\/\s*/u, '');
		normalized = normalized.replace(/\b(S\d+E\d+(?:-\d+)?)\s+(\d{1,2})(?=\s*\[)/iu, '$1 of $2');
		normalized = normalized.replace(
			/^(.+?)\s*\/\s*(S\d+E\d+(?:-\d+)?(?:\s+of\s+\d+)?\b)/iu,
			'$1: $2'
		);
		normalized = normalized.replace(/\s{2,}/g, ' ');
		return normalized.trim();
	}

	private withFormattedSeasonPackTitle(release: ReleaseResult): ReleaseResult {
		const formatted = this.formatPointerDisplayTitle(release.title);
		if (formatted === release.title) {
			return release;
		}
		return {
			...release,
			title: formatted
		};
	}

	private formatEpisodeToken(season: number | undefined, episode: number): string {
		if (season === undefined || season < 0) {
			return `E${String(episode).padStart(2, '0')}`;
		}
		return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
	}

	/**
	 * Whether this is a TV search scoped to a whole season (season set, no episode).
	 * Used to bypass {@link filterByCategoryMatch}: by the time it would run,
	 * {@link filterBySeasonEpisode} has already validated these releases as season packs
	 * via strict title parsing. Indexer categories are unreliable for packs (often filed as
	 * Movies/XXX/Other on Jackett/Prowlarr and other aggregators), so applying the broad
	 * category guard to this already-narrow set can wipe out every pack and yield zero
	 * results. The title/season match is the authoritative signal here.
	 */
	private isSeasonOnlyTvSearch(criteria: SearchCriteria): boolean {
		return isTvSearch(criteria) && criteria.season !== undefined && criteria.episode === undefined;
	}

	/**
	 * Filter releases by category match.
	 * Rejects releases where the category doesn't match the search type.
	 * When criteria.isAdult is true, XXX categories (6xxx) are also accepted.
	 */
	private filterByCategoryMatch(
		releases: ReleaseResult[],
		searchType: 'movie' | 'tv' | 'music' | 'book',
		criteria?: SearchCriteria
	): ReleaseResult[] {
		return releases.filter((release) => {
			// ID-first: a release whose content ID matches the search target IS the
			// right content type. Indexer categories are noisy — aggregators mis-file
			// TV packs as Movies, anime as Other, soundtracks with their movie — and
			// must not override an authoritative ID match.
			const searchTmdbId = criteria && 'tmdbId' in criteria ? criteria.tmdbId : undefined;
			const searchImdbId = criteria && 'imdbId' in criteria ? criteria.imdbId : undefined;
			const searchTvdbId = criteria && 'tvdbId' in criteria ? criteria.tvdbId : undefined;
			if (searchTmdbId && release.tmdbId === searchTmdbId) {
				return true;
			}
			if (searchImdbId && release.imdbId === searchImdbId) {
				return true;
			}
			if (searchType === 'tv' && searchTvdbId && release.tvdbId === searchTvdbId) {
				return true;
			}

			// If release has no categories, allow it (benefit of the doubt)
			if (!release.categories || release.categories.length === 0) {
				return true;
			}

			// Check if ANY of the release's categories match the search type.
			// Also accept "Other" (8000+) since many trackers (e.g. LimeTorrents) file
			// anime/hentai under a generic catch-all rather than TV or XXX.
			// Also accept XXX when the search is for adult content.
			// Also accept Movies (2000-2999) when searching for adult TV content: hentai OVAs
			// are often categorized as movies on public trackers even though the user is
			// looking for them as part of a TV series.
			const hasMatchingCategory = release.categories.some(
				(cat) =>
					categoryMatchesSearchType(cat, searchType) ||
					(criteria?.isAdult && (isXxxCategory(cat) || isMovieCategory(cat))) ||
					cat >= 8000
			);

			if (!hasMatchingCategory) {
				const actualContentType = getCategoryContentType(release.categories[0]);
				logger.debug(
					{
						title: release.title,
						categories: release.categories,
						expectedSearchType: searchType,
						actualContentType
					},
					'[SearchOrchestrator] Rejecting release due to category mismatch'
				);
			}

			return hasMatchingCategory;
		});
	}

	/**
	 * Filter releases that are in the blocklist (previously blocked due to
	 * download failures, blocked extensions, or manual actions).
	 */
	private async filterByBlocklist(
		releases: ReleaseResult[],
		criteria: SearchCriteria
	): Promise<ReleaseResult[]> {
		if (releases.length === 0) return releases;

		const searchTmdbId = 'tmdbId' in criteria ? criteria.tmdbId : undefined;
		let movieId: string | undefined;
		let seriesId: string | undefined;

		if (isMovieSearch(criteria) && searchTmdbId) {
			const movie = await db.query.movies.findFirst({
				where: eq(movies.tmdbId, searchTmdbId),
				columns: { id: true }
			});
			movieId = movie?.id;
		} else if (isTvSearch(criteria) && searchTmdbId) {
			const s = await db.query.series.findFirst({
				where: eq(series.tmdbId, searchTmdbId),
				columns: { id: true }
			});
			seriesId = s?.id;
		}

		if (!movieId && !seriesId) return releases;

		const { blockedHashes, blockedTitles } = await blocklistService.getBlockedIdentifiers(
			movieId,
			seriesId
		);

		if (blockedHashes.size === 0 && blockedTitles.size === 0) return releases;

		const isBlocked = (release: ReleaseResult): boolean =>
			(!!release.infoHash && blockedHashes.has(release.infoHash)) ||
			blockedTitles.has(release.title);

		// Interactive searches show everything: blocklisted releases stay
		// visible with a `blocklisted` marker (surfaced as a rejection badge
		// after enrichment); the grab pipeline's BlocklistStage still guards
		// acquisition. Automatic searches remove them outright.
		if (criteria.searchSource === 'interactive') {
			return releases.map((release) =>
				isBlocked(release) ? { ...release, blocklisted: true } : release
			);
		}

		return releases.filter((release) => !isBlocked(release));
	}

	/**
	 * Convert `blocklisted` markers (set by filterByBlocklist for interactive
	 * searches) into Radarr-style rejection fields so the UI's existing
	 * rejection badge renders "Blocklisted".
	 */
	private annotateBlocklistedReleases(releases: EnhancedReleaseResult[]): EnhancedReleaseResult[] {
		return releases.map((release) => {
			if (!release.blocklisted) return release;
			return {
				...release,
				rejected: true,
				rejectionReason: release.rejectionReason ?? 'Blocklisted',
				rejections: [...(release.rejections ?? []), 'Blocklisted']
			};
		});
	}

	/**
	 * Filter non-video artifacts (soundtracks/scores/audio collections) for movie/TV searches.
	 * This is a safety net for indexers that mislabel categories or provide incomplete metadata.
	 */
	private filterOutNonVideoArtifacts(
		releases: ReleaseResult[],
		criteria: SearchCriteria
	): ReleaseResult[] {
		if (!isMovieSearch(criteria) && !isTvSearch(criteria)) {
			return releases;
		}

		const beforeCount = releases.length;
		const filtered = releases.filter((release) => {
			const title = release.title ?? '';

			// Hard-reject executable/dangerous file extensions masquerading as video.
			// No escape hatch — these are never legitimate video content.
			if (DEFAULT_DANGEROUS_EXTENSION_PATTERN.test(title)) {
				logger.debug(
					{
						title: release.title,
						searchType: criteria.searchType,
						indexer: release.indexerName
					},
					'[SearchOrchestrator] Rejecting release with dangerous file extension'
				);
				return false;
			}

			if (!this.matchesNonVideoArtifactTitle(title)) {
				return true;
			}

			if (this.matchesTrailerArtifactTitle(title)) {
				// Context check: when the searched movie/series title itself contains
				// the artifact token ("Trailer Park Boys"), the token is part of the
				// name — not an appended artifact. Otherwise ("Movie.2020.1080p.BluRay
				// .Trailer") the release is a promo/teaser artifact.
				const queryCandidates = [criteria.query, ...(criteria.searchTitles ?? [])]
					.filter((candidate): candidate is string => !!candidate)
					.map((candidate) => candidate.toLowerCase());

				const isTitleEmbedded = queryCandidates.some((candidate) =>
					TRAILER_ARTIFACT_TITLE_PATTERNS.some((pattern) => pattern.test(candidate))
				);

				if (!isTitleEmbedded) {
					logger.debug(
						{
							title: release.title,
							searchType: criteria.searchType,
							indexer: release.indexerName
						},
						'[SearchOrchestrator] Rejecting trailer/promo style release'
					);
					return false;
				}
			}

			const releaseWithCache = release as ReleaseResult & {
				_parsedRelease?: ReturnType<typeof parseRelease>;
			};
			if (!releaseWithCache._parsedRelease) {
				releaseWithCache._parsedRelease = parseRelease(title);
			}
			const parsed = releaseWithCache._parsedRelease;

			// Keep only when there are strong video signals.
			// We intentionally avoid trusting weak parser hints here because
			// soundtrack-style titles can contain ambiguous tokens.
			const hasVideoSignals =
				VIDEO_SIGNAL_PATTERN.test(title) ||
				parsed.episode !== undefined ||
				(parsed.resolution !== null && parsed.resolution !== 'unknown');

			if (!hasVideoSignals) {
				logger.debug(
					{
						title: release.title,
						searchType: criteria.searchType,
						indexer: release.indexerName
					},
					'[SearchOrchestrator] Rejecting non-video artifact release'
				);
			}

			return hasVideoSignals;
		});

		if (filtered.length < beforeCount) {
			logger.info(
				{
					before: beforeCount,
					after: filtered.length,
					removed: beforeCount - filtered.length,
					searchType: criteria.searchType
				},
				'[SearchOrchestrator] Non-video artifact filter removed releases'
			);
		}

		return filtered;
	}

	private matchesNonVideoArtifactTitle(title: string): boolean {
		return NON_VIDEO_ARTIFACT_TITLE_PATTERNS.some((pattern) => pattern.test(title));
	}

	private matchesTrailerArtifactTitle(title: string): boolean {
		return TRAILER_ARTIFACT_TITLE_PATTERNS.some((pattern) => pattern.test(title));
	}

	/**
	 * Normalize a preferred-language criterion to its comparable base tag.
	 *
	 * Both the criteria side ('en', 'EN-US', 'pt-BR') and the release-title
	 * side (parsed codes like 'en'/'ru'/'multi') go through
	 * normalizeLanguageCode, then reduce to the base subtag: release names
	 * almost never carry a region, so an 'EN-US' preference must still match
	 * a release tagged 'eng'/'en'. The 'multi' pseudo-code normalizes to
	 * itself and therefore never matches a real language preference.
	 */
	private resolvePreferredLanguageBase(criteria: SearchCriteria): string | null {
		const preferred = criteria.language?.trim();
		if (!preferred) return null;
		return normalizeLanguageCode(preferred).split('-')[0].toLowerCase();
	}

	/**
	 * Shared skip rule for the language boost (rank + enhanced paths).
	 *
	 * A bare `en` preference (the ecosystem default) is a no-op: English
	 * releases are the baseline, so boosting them would only add noise. An
	 * explicit locale like 'en-US' is NOT skipped — after title matching is
	 * base-normalized it boosts releases explicitly tagged english/eng, which
	 * is what a user preferring that locale wants (untagged releases assert no
	 * language at all, so they are never boosted).
	 */
	private isLanguageBoostDisabled(criteria: SearchCriteria): boolean {
		const raw = criteria.language?.trim().toLowerCase();
		return !raw || raw === 'en';
	}

	/**
	 * Whether a release title asserts the preferred language.
	 * Shared by both the rank and enhanced paths so language preference
	 * behaves identically regardless of which pipeline scores the release.
	 */
	private titleMatchesPreferredLanguage(title: string, preferredBase: string): boolean {
		const { languages } = extractLanguages(title);
		return languages.some(
			(code) => normalizeLanguageCode(code).split('-')[0].toLowerCase() === preferredBase
		);
	}

	/**
	 * Boost releases that match the preferred audio language (rank path).
	 * Uses extractLanguages() to detect language from release titles.
	 * Matching releases are returned as new copies with inflated seeders so the
	 * ReleaseRanker (which weights seeders at 0.4) ranks them above non-matching
	 * ones. Input objects are never mutated and non-matching releases pass through.
	 *
	 * The boost is a soft preference: non-matching releases still appear but
	 * are ranked below matching ones. This mirrors how Sonarr/Radarr handle
	 * language preferences via custom format scoring.
	 *
	 * Comparison is normalized on both sides (see resolvePreferredLanguageBase)
	 * and the skip rule is shared with the enhanced path (see
	 * isLanguageBoostDisabled).
	 */
	private boostByLanguage<T extends ReleaseResult>(releases: T[], criteria: SearchCriteria): T[] {
		const preferredBase = this.resolvePreferredLanguageBase(criteria);
		if (!preferredBase || this.isLanguageBoostDisabled(criteria) || releases.length === 0) {
			return releases;
		}

		let boostedCount = 0;
		const boosted = releases.map((release) => {
			if (!this.titleMatchesPreferredLanguage(release.title, preferredBase)) {
				return release;
			}

			boostedCount += 1;
			return {
				...release,
				// The ReleaseRanker weights seeders at 0.4 — a 30x multiplier pushes
				// matching releases well above non-matching ones.
				seeders: typeof release.seeders === 'number' ? Math.max(1, release.seeders * 30) : 1
			};
		});

		if (boostedCount > 0) {
			logger.debug(
				{
					preferredLanguage: criteria.language,
					totalReleases: releases.length,
					boostedCount
				},
				'[SearchOrchestrator] Language boost applied'
			);
		}

		return boosted;
	}

	/**
	 * Boost releases that match the preferred audio language (enhanced path).
	 *
	 * Applied AFTER enrichment so protocol checks (minimumSeeders, dead-torrent
	 * rejection) still see the real seeders, and expressed as an explicit
	 * totalScore contribution instead of seeders inflation — enrichment
	 * recomputes totalScore from scratch, so a pre-enrichment adjustment would
	 * be silently discarded. +20 points mirrors the rank path's magnitude: the
	 * 30x seeders multiplier at the ranker's 0.4 seeders weight is worth
	 * roughly 0.17–0.19 on the ranker's 0–1 scale for typical seeder counts,
	 * and matches the existing enhancementBonus (PROPER/REPACK) scale.
	 *
	 * Matching, normalization (normalizeLanguageCode on both sides) and the
	 * bare-`en` skip rule are identical to boostByLanguage (see
	 * isLanguageBoostDisabled), so both paths express the same preference.
	 * Results are returned as new copies, re-sorted by totalScore, ready for
	 * enhanced deduplication.
	 */
	private applyLanguageScoreBonus(
		releases: EnhancedReleaseResult[],
		criteria: SearchCriteria
	): EnhancedReleaseResult[] {
		const preferredBase = this.resolvePreferredLanguageBase(criteria);
		if (!preferredBase || this.isLanguageBoostDisabled(criteria) || releases.length === 0) {
			return releases;
		}

		const LANGUAGE_BONUS = 20;
		let boostedCount = 0;
		const boosted = releases.map((release) => {
			if (!this.titleMatchesPreferredLanguage(release.title, preferredBase)) {
				return release;
			}

			boostedCount += 1;
			const components = release.scoreComponents as
				{ languageBonus?: number; totalScore: number } | undefined;
			return {
				...release,
				totalScore: release.totalScore + LANGUAGE_BONUS,
				scoreComponents: components ? { ...components, languageBonus: LANGUAGE_BONUS } : components
			};
		});

		if (boostedCount > 0) {
			logger.debug(
				{
					preferredLanguage: criteria.language,
					totalReleases: releases.length,
					boostedCount,
					bonus: LANGUAGE_BONUS
				},
				'[SearchOrchestrator] Language boost applied (enhanced path)'
			);
		}

		return boosted.sort((a, b) => b.totalScore - a.totalScore);
	}

	/**
	 * Merge every language-evidence source available on a release into one
	 * token set: title tokens (parser, incl. 'multi'/'orig' pseudo-codes),
	 * structured indexer attrs (`languages`, Phase A), and the enriched
	 * parse. Deduped, order-preserving.
	 */
	private getReleaseLanguageEvidence(
		release: ReleaseResult & { parsed?: { languages?: string[] } }
	): string[] {
		const tokens: string[] = [];
		const seen = new Set<string>();
		const push = (tag: string) => {
			if (!tag || seen.has(tag)) return;
			seen.add(tag);
			tokens.push(tag);
		};

		for (const tag of release.languages ?? []) push(tag);
		for (const tag of release.parsed?.languages ?? []) push(tag);
		for (const tag of extractLanguages(release.title).languages) push(tag);
		return tokens;
	}

	/** True when the preference carries no ranking signal at all. */
	private isAudioPreferenceNeutral(preference: EffectiveAudioPreference): boolean {
		const hasOriginalSignal =
			preference.preferOriginal &&
			typeof preference.originalLanguage === 'string' &&
			preference.originalLanguage !== '';
		return preference.languages.length === 0 && !hasOriginalSignal;
	}

	/**
	 * Graded ordered-preference boost from the effective language profile
	 * (rank path). Ranks release language evidence with the shared
	 * four-bucket policy (`rankLanguageEvidenceSet`) and inflates seeders by
	 * a bucket-scaled multiplier: original ×30, preferred ×(30−4·index,
	 * floor 10), multi-pack ×8, everything else unchanged. Soft only — no
	 * release is ever demoted or dropped here.
	 */
	private boostByAudioPreference<T extends ReleaseResult>(
		releases: T[],
		criteria: SearchCriteria
	): T[] {
		const preference = criteria.audioPreference;
		if (!preference || this.isAudioPreferenceNeutral(preference) || releases.length === 0) {
			return releases;
		}

		let boostedCount = 0;
		const boosted = releases.map((release) => {
			const evidence = this.getReleaseLanguageEvidence(release);
			const { bucket, preferenceIndex } = rankLanguageEvidenceSet(evidence, preference);
			const multiplier =
				bucket === 0 ? 30 : bucket === 1 ? Math.max(30 - 4 * preferenceIndex, 10) : 1;
			if (multiplier <= 1) return release;

			boostedCount += 1;
			return {
				...release,
				seeders: typeof release.seeders === 'number' ? Math.max(1, release.seeders * multiplier) : 1
			};
		});

		if (boostedCount > 0) {
			logger.debug(
				{
					preference,
					totalReleases: releases.length,
					boostedCount
				},
				'[SearchOrchestrator] Audio preference boost applied'
			);
		}

		return boosted;
	}

	/**
	 * Graded ordered-preference bonus (enhanced path), mirroring
	 * boostByAudioPreference as an explicit totalScore contribution:
	 * original +25, preferred +max(20−2·index, 10), multi-pack +12,
	 * everything else +0. Recorded as `scoreComponents.languageBonus` when
	 * nonzero; never negative (soft mode).
	 */
	private applyAudioPreferenceBonus(
		releases: EnhancedReleaseResult[],
		criteria: SearchCriteria
	): EnhancedReleaseResult[] {
		const preference = criteria.audioPreference;
		if (!preference || this.isAudioPreferenceNeutral(preference) || releases.length === 0) {
			return releases;
		}

		let boostedCount = 0;
		const boosted = releases.map((release) => {
			const evidence = this.getReleaseLanguageEvidence(release);
			const { bucket, preferenceIndex } = rankLanguageEvidenceSet(evidence, preference);
			// bucket 1 with index === preference.languages.length is the
			// 'multi' candidate slot
			const isMultiCandidate = bucket === 1 && preferenceIndex === preference.languages.length;
			const finalBonus = isMultiCandidate
				? 12
				: bucket === 0
					? 25
					: bucket === 1
						? Math.max(20 - 2 * preferenceIndex, 10)
						: 0;
			if (finalBonus <= 0) return release;

			boostedCount += 1;
			const components = release.scoreComponents as
				{ languageBonus?: number; totalScore: number } | undefined;
			return {
				...release,
				totalScore: release.totalScore + finalBonus,
				scoreComponents: components ? { ...components, languageBonus: finalBonus } : components
			};
		});

		if (boostedCount > 0) {
			logger.debug(
				{
					preference,
					totalReleases: releases.length,
					boostedCount
				},
				'[SearchOrchestrator] Audio preference bonus applied (enhanced path)'
			);
		}

		return boosted.sort((a, b) => b.totalScore - a.totalScore);
	}

	/**
	 * Calculate title similarity using Levenshtein distance.
	 * Returns a value between 0 (completely different) and 1 (identical).
	 */
	private calculateTitleSimilarity(a: string, b: string): number {
		if (a === b) return 1.0;

		const m = a.length;
		const n = b.length;
		const maxLength = Math.max(m, n);
		if (maxLength === 0) return 1.0;

		const maxDistance = Math.floor(maxLength * 0.3);

		if (Math.abs(m - n) > maxDistance) return 0;

		const prev = new Uint16Array(m + 1);
		const curr = new Uint16Array(m + 1);
		for (let j = 0; j <= m; j++) prev[j] = j;

		for (let i = 1; i <= n; i++) {
			curr[0] = i;
			let rowMin = i;
			for (let j = 1; j <= m; j++) {
				if (b.charAt(i - 1) === a.charAt(j - 1)) {
					curr[j] = prev[j - 1];
				} else {
					curr[j] = Math.min(prev[j - 1] + 1, curr[j - 1] + 1, prev[j] + 1);
				}
				if (curr[j] < rowMin) rowMin = curr[j];
			}
			if (rowMin > maxDistance) return 0;
			prev.set(curr);
		}

		const distance = curr[m];
		if (distance > maxDistance) return 0;

		return 1 - distance / maxLength;
	}

	/**
	 * Whether any release actually matches the searched movie/series, using the
	 * same ID/title/year check the final results go through. Decides when a
	 * search step has answered the search: an unrelated hit (e.g. a generic
	 * localized title matching other content) must not stop the remaining
	 * titles from being searched. Non-movie/TV searches accept any result.
	 */
	private hasRelevantReleases(releases: ReleaseResult[], criteria: SearchCriteria): boolean {
		if (releases.length === 0) return false;
		if (!isMovieSearch(criteria) && !isTvSearch(criteria)) return true;
		return this.filterByIdOrTitleMatch(releases, criteria).length > 0;
	}

	/**
	 * Filter releases by ID match with title+year fallback.
	 *
	 * PRIORITY 1: ID Matching (preferred)
	 * - If indexer provides TMDB/IMDB/TVDB ID and it doesn't match search criteria, hard reject
	 * - If IDs match exactly, accept immediately
	 *
	 * PRIORITY 2: Title + Year Fallback (when no IDs)
	 * - Validate title similarity >= 0.7 AND year within 1 year
	 * - If can't validate (no criteria), keep release
	 *
	 * This completely removes mismatched releases (not just marks as rejected).
	 */
	private filterByIdOrTitleMatch(
		releases: ReleaseResult[],
		criteria: SearchCriteria
	): ReleaseResult[] {
		// Only process movie or TV searches
		if (!isMovieSearch(criteria) && !isTvSearch(criteria)) {
			return releases;
		}

		// Get search IDs (type-safe access)
		const searchTmdbId =
			isMovieSearch(criteria) || isTvSearch(criteria) ? criteria.tmdbId : undefined;
		const searchImdbId =
			isMovieSearch(criteria) || isTvSearch(criteria) ? criteria.imdbId : undefined;
		const searchTvdbId = isTvSearch(criteria) ? criteria.tvdbId : undefined;
		const searchYear = isMovieSearch(criteria) || isTvSearch(criteria) ? criteria.year : undefined;

		// Skip if we have no way to validate (no search IDs or titles)
		const hasSearchIds = searchTmdbId || searchImdbId || searchTvdbId;
		// Treat the query string as a title candidate when no explicit alternate titles are stored.
		// This prevents wrong results from passing through when searchTitles hasn't been populated yet.
		const hasSearchTitles =
			!!(criteria.searchTitles && criteria.searchTitles.length > 0) || !!criteria.query;
		const hasSearchYear = searchYear;

		if (!hasSearchIds && !hasSearchTitles && !hasSearchYear) {
			return releases;
		}

		const beforeCount = releases.length;
		const isInteractiveSearch = criteria.searchSource === 'interactive';
		const allowInteractiveFallback =
			isInteractiveSearch && isTvSearch(criteria) && !criteria.season && !criteria.episode;

		const filtered = releases.filter((release) => {
			let parsed: ReturnType<typeof parseRelease> | undefined;
			const getParsed = () => {
				if (!parsed) {
					parsed = parseRelease(release.title, {
						sourceLanguage: release.sourceLanguage,
						// Movie searches parse in 'movie' mode so titles like
						// "Open Season 3" keep their full title for matching.
						mode: isMovieSearch(criteria) ? 'movie' : undefined
					});
				}
				return parsed;
			};

			// PRIORITY 1: ID Matching
			// Any ID match → accept immediately (fast path).
			// ID mismatch alone is NOT a hard reject: aggregators (NZBHydra, Prowlarr)
			// attach their own IDs to results which can be wrong. Fall through to title
			// check so it can confirm or deny. Only reject when both IDs mismatch AND
			// title also fails, or when there is no title evidence to arbitrate.
			const releasePrefersNativeCyrillic = prefersNativeCyrillicTitles({
				name: release.indexerName ?? ''
			} as IIndexer);

			let hasIdMismatch = false;

			// TMDB ID check
			if (searchTmdbId && release.tmdbId) {
				if (release.tmdbId === searchTmdbId) return true;
				// Native-Cyrillic trackers (RuTracker, Kinozal, etc.) attach their own
				// authoritative IDs — mismatch is definitive, not an aggregator artifact.
				if (releasePrefersNativeCyrillic) return false;
				logger.debug(
					{
						releaseTitle: release.title,
						releaseTmdbId: release.tmdbId,
						criteriaTmdbId: searchTmdbId,
						indexer: release.indexerName
					},
					'[SearchOrchestrator] TMDB ID mismatch - falling through to title check'
				);
				hasIdMismatch = true;
			}

			// IMDB ID check
			if (searchImdbId && release.imdbId) {
				if (release.imdbId === searchImdbId) return true;
				if (releasePrefersNativeCyrillic) return false;
				logger.debug(
					{
						releaseTitle: release.title,
						releaseImdbId: release.imdbId,
						criteriaImdbId: searchImdbId,
						indexer: release.indexerName
					},
					'[SearchOrchestrator] IMDB ID mismatch - falling through to title check'
				);
				hasIdMismatch = true;
			}

			// TVDB ID check (TV only)
			if (searchTvdbId && release.tvdbId) {
				if (release.tvdbId === searchTvdbId) return true;
				if (releasePrefersNativeCyrillic) return false;
				logger.debug(
					{
						releaseTitle: release.title,
						releaseTvdbId: release.tvdbId,
						criteriaTvdbId: searchTvdbId,
						indexer: release.indexerName
					},
					'[SearchOrchestrator] TVDB ID mismatch - falling through to title check'
				);
				hasIdMismatch = true;
			}

			// For movies, enforce strict year matching whenever we can parse a year
			// from the release title, even if title variants are unavailable.
			// Allow ±1 year tolerance (festival release vs. wide release).
			if (isMovieSearch(criteria) && searchYear) {
				const parsedRelease = getParsed();
				if (parsedRelease.year && Math.abs(parsedRelease.year - searchYear) > 1) {
					logger.debug(
						{
							releaseTitle: release.title,
							releaseYear: parsedRelease.year,
							criteriaYear: searchYear,
							indexer: release.indexerName,
							releaseHasAnyId: !!(release.tmdbId || release.imdbId || release.tvdbId)
						},
						'[SearchOrchestrator] DEBUG: YEAR MISMATCH - removing movie release'
					);
					return false;
				}
				// Automatic movie searches treat a missing year as uncertainty,
				// not proof: a year-less "Halloween" cannot distinguish 1978 from
				// 2018. Interactive searches keep the release visible instead.
				if (!parsedRelease.year && !isInteractiveSearch && !release.tmdbId && !release.imdbId) {
					logger.debug(
						{
							releaseTitle: release.title,
							criteriaYear: searchYear,
							indexer: release.indexerName
						},
						'[SearchOrchestrator] Removing year-less movie release from automatic search'
					);
					return false;
				}
			}

			// PRIORITY 2: Title Fallback (if no ID match possible)
			// Runs whenever we have known titles; year is an additional filter only
			// when the search criteria carries one (TV series often don't).
			if (hasSearchTitles) {
				const isEpisodeTarget = isTvSearch(criteria) && criteria.episode !== undefined;
				const isSeasonTarget = isTvSearch(criteria) && criteria.season !== undefined;
				const releaseHasAnyId = !!(release.tmdbId || release.imdbId || release.tvdbId);

				// Parse release title
				const parsedRelease = getParsed();

				// Check title similarity. Include query as a fallback candidate in case
				// alternate-title storage is incomplete for this language.
				const titleCandidates = [
					...(criteria.searchTitles ?? []),
					...(criteria.query ? [criteria.query] : [])
				];
				const normalizedCandidates = titleCandidates
					.map((candidate) => this.normalizeForComparison(candidate))
					.filter((candidate) => candidate.length > 0);

				const releaseName = this.normalizeForComparison(parsedRelease.cleanTitle);
				const hasAnyLetterOrNumber = /[\p{L}\p{N}]/u.test(parsedRelease.cleanTitle);
				const isUnmappableLocalizedTitle = releaseName.length === 0 && hasAnyLetterOrNumber;

				let titleMatch = true;
				if (normalizedCandidates.length > 0 && releaseName.length > 0) {
					// Containment is display evidence, never automatic-acquisition
					// identity on scene-name indexers: raw substring containment
					// matched "Halloween" to "Detective Conan: The Bride of
					// Halloween" (2026-09-17 incident). It stays available for
					// interactive searches (show everything plausible; the grab
					// pipeline's IdentityStage gates acquisition) and for
					// native-Cyrillic trackers whose descriptive title format
					// ("Title (Director) [year, country, genre…]") the parser
					// cannot reduce to a clean title.
					const allowContainment = isInteractiveSearch || releasePrefersNativeCyrillic;
					titleMatch = normalizedCandidates.some((expectedName) => {
						const similarity = this.calculateTitleSimilarity(releaseName, expectedName);
						if (similarity >= 0.7) {
							return true;
						}
						if (!allowContainment) {
							return false;
						}
						return (
							matchTitleContainment(releaseName, expectedName, 1).contained ||
							(releaseName.length >= 5 &&
								expectedName.length >= 5 &&
								(releaseName.includes(expectedName) || expectedName.includes(releaseName)))
						);
					});
				} else if (isUnmappableLocalizedTitle) {
					// Interactive searches should not blank out results when title validation
					// is impossible due to script mismatch (e.g. Cyrillic-only tracker titles).
					// Automatic searches get the same escape when the release comes from a
					// native-Cyrillic tracker (RuTracker, Kinozal, …) — otherwise auto-grab
					// can never pick up releases it found.
					titleMatch =
						(isInteractiveSearch || releasePrefersNativeCyrillic) &&
						(isTvSearch(criteria) || releasePrefersNativeCyrillic);
				}

				// Year check: only applies when both the search criteria and the parsed
				// release title carry a year. Missing year on either side is not a failure.
				// Season targets additionally tolerate forward year drift: a season pack
				// carries the SEASON's air year, not the series first-air year
				// (e.g. "Show.S03.2017" for a show that first aired in 2015).
				const yearMatch =
					!searchYear ||
					!parsedRelease.year ||
					parsedRelease.year === searchYear ||
					(isSeasonTarget && parsedRelease.year >= searchYear - 1);

				if (!titleMatch || !yearMatch) {
					// Interactive fallback for localized/transliterated indexer titles that
					// don't match stored title variants yet. The year is allowed within ±1
					// (festival vs. wide release — matches the hard year check above).
					// Automatic searches are included when the release comes from a
					// native-Cyrillic tracker: its bracketed year is authoritative, so a
					// script-mismatched title + in-range year is a trustworthy match.
					// Keep this strict for targeted TV lookups (season/episode).
					const fallbackYearMatch =
						!searchYear || !parsedRelease.year || Math.abs(parsedRelease.year - searchYear) <= 1;
					const allowTitleFallback =
						(isInteractiveSearch || releasePrefersNativeCyrillic) &&
						fallbackYearMatch &&
						!releaseHasAnyId &&
						((isTvSearch(criteria) && !isEpisodeTarget && !isSeasonTarget) ||
							(isMovieSearch(criteria) && releasePrefersNativeCyrillic));
					if (allowTitleFallback) {
						logger.debug(
							{
								releaseTitle: release.title,
								parsedTitle: parsedRelease.cleanTitle,
								parsedYear: parsedRelease.year,
								criteriaYear: searchYear,
								titleMatch,
								yearMatch,
								isInteractiveSearch,
								releaseHasAnyId
							},
							'[SearchOrchestrator] DEBUG: Applying interactive localized-title fallback'
						);
						return true;
					}

					const simDetails = normalizedCandidates.map((expectedName) => ({
						expected: expectedName,
						similarity: this.calculateTitleSimilarity(releaseName, expectedName),
						containsEachOther:
							releaseName.includes(expectedName) || expectedName.includes(releaseName)
					}));
					logger.debug(
						{
							releaseTitle: release.title,
							parsedTitle: parsedRelease.cleanTitle,
							releaseName, // normalized
							parsedYear: parsedRelease.year,
							criteriaYear: searchYear,
							titleMatch,
							yearMatch,
							hasIdMismatch,
							isInteractiveSearch,
							releaseHasAnyId,
							normalizedCandidates,
							similarityDetails: simDetails
						},
						hasIdMismatch
							? '[SearchOrchestrator] ID mismatch confirmed by title/year mismatch - removing release'
							: '[SearchOrchestrator] DEBUG: TITLE/YEAR MISMATCH - removing release'
					);
					return false;
				}

				// Title (and year when available) match - accept
				return true;
			}

			// No title evidence to arbitrate: reject on ID mismatch, keep otherwise.
			if (hasIdMismatch) return false;
			return true;
		});

		if (filtered.length < beforeCount) {
			logger.info(
				{
					before: beforeCount,
					after: filtered.length,
					removed: beforeCount - filtered.length,
					criteriaTmdbId: searchTmdbId,
					criteriaImdbId: searchImdbId,
					hadSearchTitles: hasSearchTitles,
					criteriaYear: searchYear
				},
				'[SearchOrchestrator] ID/Title filter removed mismatched releases'
			);
		}

		// Interactive localized searches should not hard-fail here when the
		// tracker returns relevant releases in a different script/transliteration
		// and none of them expose authoritative IDs. Keep explicit ID mismatches
		// strict, but fall back to the pre-filtered set when everything else
		// would be removed.
		if (allowInteractiveFallback && beforeCount > 0 && filtered.length === 0) {
			const releasesWithoutIdConflicts = releases.filter((release) => {
				if (searchTmdbId && release.tmdbId && release.tmdbId !== searchTmdbId) {
					return false;
				}
				if (searchImdbId && release.imdbId && release.imdbId !== searchImdbId) {
					return false;
				}
				if (searchTvdbId && release.tvdbId && release.tvdbId !== searchTvdbId) {
					return false;
				}
				return true;
			});

			if (releasesWithoutIdConflicts.length > 0) {
				logger.info(
					{
						before: beforeCount,
						kept: releasesWithoutIdConflicts.length,
						searchType: criteria.searchType,
						searchSource: criteria.searchSource,
						criteriaTmdbId: searchTmdbId,
						criteriaImdbId: searchImdbId,
						criteriaTvdbId: searchTvdbId,
						criteriaYear: searchYear
					},
					'[SearchOrchestrator] ID/title fallback applied for interactive search'
				);
				return releasesWithoutIdConflicts;
			}
		}

		return filtered;
	}

	/**
	 * Normalize a string for title comparison.
	 * Removes diacritics, punctuation, converts to lowercase, normalizes whitespace.
	 */
	private normalizeForComparison(str: string): string {
		return str
			.normalize('NFD') // Decompose diacritics (e.g., ů → u + combining dot)
			.replace(/[\u0300-\u036f]/g, '') // Remove combining diacritics
			.normalize('NFKC') // Re-compose for consistent representation
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, '') // Remove punctuation, keep Unicode letters/numbers
			.replace(/\s+/g, ' ') // Normalize whitespace
			.trim();
	}

	/**
	 * Get aggregate and per-season episode counts for a TV show from TMDB.
	 * Excludes specials (season 0) from series totals to match library sizing semantics.
	 */
	private async getTvEpisodeCounts(tmdbId: number): Promise<TvEpisodeCounts | undefined> {
		if (this.tvEpisodeCountsCache.has(tmdbId)) {
			return this.tvEpisodeCountsCache.get(tmdbId);
		}

		try {
			const show = await tmdb.getTVShow(tmdbId);
			const seasonEpisodeCounts = new Map<number, number>();

			for (const season of show.seasons ?? []) {
				const seasonNumber = season.season_number;
				const episodeCount = season.episode_count;
				if (seasonNumber > 0 && episodeCount > 0) {
					seasonEpisodeCounts.set(seasonNumber, episodeCount);
				}
			}

			let seriesEpisodeCount = Array.from(seasonEpisodeCounts.values()).reduce(
				(total, count) => total + count,
				0
			);

			// Fallback to TMDB aggregate count if seasons were unavailable
			if (seriesEpisodeCount <= 0 && show.number_of_episodes > 0) {
				seriesEpisodeCount = show.number_of_episodes;
			}

			const counts: TvEpisodeCounts = {
				seriesEpisodeCount: seriesEpisodeCount > 0 ? seriesEpisodeCount : undefined,
				seasonEpisodeCounts
			};

			this.tvEpisodeCountsCache.set(tmdbId, counts);
			return counts;
		} catch (error) {
			logger.warn(
				{
					tmdbId,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to fetch TV episode counts from TMDB'
			);
			return undefined;
		}
	}

	/**
	 * Get episode count for a TV season from TMDB.
	 * Used for season pack size validation (per-episode size calculation).
	 * Returns undefined if unable to fetch (allows search to proceed without size validation).
	 */
	private async getSeasonEpisodeCount(criteria: SearchCriteria): Promise<number | undefined> {
		// Only works for TV searches with TMDB ID and season number
		if (!isTvSearch(criteria) || criteria.season === undefined) {
			return undefined;
		}

		// Need TMDB ID to fetch season details
		const tmdbId = criteria.tmdbId;
		if (!tmdbId) {
			return undefined;
		}

		// Reuse cached TV episode counts if available
		const cachedTvCounts = this.tvEpisodeCountsCache.get(tmdbId);
		if (cachedTvCounts) {
			const cachedSeasonCount = cachedTvCounts.seasonEpisodeCounts.get(criteria.season);
			if (cachedSeasonCount && cachedSeasonCount > 0) {
				return cachedSeasonCount;
			}
		}

		// Check cache first
		const cacheKey = `${tmdbId}:${criteria.season}`;
		if (this.seasonEpisodeCountCache.has(cacheKey)) {
			return this.seasonEpisodeCountCache.get(cacheKey);
		}

		try {
			const season = await tmdb.getSeason(tmdbId, criteria.season);
			const episodeCount = season.episode_count ?? season.episodes?.length;

			if (episodeCount && episodeCount > 0) {
				// Cache the result
				this.seasonEpisodeCountCache.set(cacheKey, episodeCount);
				logger.debug(
					{
						tmdbId,
						season: criteria.season,
						episodeCount
					},
					'Fetched season episode count from TMDB'
				);
				return episodeCount;
			}
		} catch (error) {
			// Log but don't fail - search can proceed without episode count
			// Size validation will be skipped for season packs
			logger.warn(
				{
					tmdbId,
					season: criteria.season,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to fetch season episode count from TMDB'
			);
		}

		return undefined;
	}

	/**
	 * Enrich search criteria with missing external IDs.
	 * If we have TMDB ID but no IMDB ID, look it up from TMDB.
	 * This enables more indexers to match the search.
	 */
	private async enrichCriteriaWithIds(criteria: SearchCriteria): Promise<SearchCriteria> {
		// Audio-preference attachment first (automatic searches only): resolve
		// the effective language profile's audio policy for the item and carry
		// it on the criteria so ranking expresses it. Runs before the ID
		// early-returns below and never blocks the search.
		const withAudioPreference = await this.attachAudioPreference(criteria);

		// Only enrich movie and TV searches
		if (withAudioPreference.searchType !== 'movie' && withAudioPreference.searchType !== 'tv') {
			return withAudioPreference;
		}

		const hasImdb = 'imdbId' in withAudioPreference && !!withAudioPreference.imdbId;
		const hasTvdb =
			withAudioPreference.searchType === 'tv' &&
			'tvdbId' in withAudioPreference &&
			!!withAudioPreference.tvdbId;

		// If we already have all relevant IDs, no enrichment needed
		if (hasImdb && (withAudioPreference.searchType === 'movie' || hasTvdb)) {
			return withAudioPreference;
		}

		// If we have TMDB ID, look up missing external IDs
		if ('tmdbId' in withAudioPreference && withAudioPreference.tmdbId) {
			try {
				const externalIds =
					withAudioPreference.searchType === 'movie'
						? await tmdb.getMovieExternalIds(withAudioPreference.tmdbId)
						: await tmdb.getTvExternalIds(withAudioPreference.tmdbId);

				let enriched = { ...withAudioPreference };

				if (!hasImdb && externalIds.imdb_id) {
					enriched = { ...enriched, imdbId: externalIds.imdb_id };
				}

				if (withAudioPreference.searchType === 'tv' && !hasTvdb && externalIds.tvdb_id) {
					enriched = { ...enriched, tvdbId: externalIds.tvdb_id } as typeof enriched;
				}

				logger.debug(
					{
						tmdbId: withAudioPreference.tmdbId,
						imdbId: 'imdbId' in enriched ? (enriched.imdbId as string) : null,
						tvdbId: 'tvdbId' in enriched ? (enriched.tvdbId as number) : null
					},
					'Enriched search criteria with external IDs'
				);

				return enriched as SearchCriteria;
			} catch (error) {
				// Log but don't fail - search can still proceed without external IDs
				logger.warn(
					{
						tmdbId: withAudioPreference.tmdbId,
						error: error instanceof Error ? error.message : String(error)
					},
					'Failed to look up external IDs from TMDB'
				);
			}
		}

		return withAudioPreference;
	}

	/**
	 * Attach the effective audio preference (from the item's language profile
	 * chain) to automatic movie/TV searches so both ranking paths express the
	 * profile's ordered audio preference. Interactive searches are skipped —
	 * the manual `?language=` parameter keeps its own single-code semantics
	 * and stacking both boosts would double-count. No-op when the caller
	 * already set a preference, the search carries no TMDB id, or resolution
	 * fails (never blocks the search).
	 */
	private async attachAudioPreference(criteria: SearchCriteria): Promise<SearchCriteria> {
		if (criteria.audioPreference) return criteria;
		if (criteria.searchSource !== 'automatic') return criteria;
		if (criteria.searchType !== 'movie' && criteria.searchType !== 'tv') return criteria;

		const tmdbId = 'tmdbId' in criteria ? criteria.tmdbId : undefined;
		if (!tmdbId) return criteria;

		try {
			const mediaType = criteria.searchType === 'movie' ? 'movie' : 'series';
			const table = mediaType === 'movie' ? movies : series;
			const row = (
				await db.select({ id: table.id }).from(table).where(eq(table.tmdbId, tmdbId)).limit(1)
			)[0];
			if (!row) return criteria;

			const preference = await resolveAudioPreferenceForItem(mediaType, row.id);
			if (
				preference.languages.length === 0 &&
				!(preference.preferOriginal && preference.originalLanguage)
			) {
				return criteria;
			}
			return { ...criteria, audioPreference: preference };
		} catch (error) {
			logger.debug(
				{
					tmdbId,
					searchType: criteria.searchType,
					error: error instanceof Error ? error.message : String(error)
				},
				'Audio preference attachment skipped'
			);
			return criteria;
		}
	}

	clearCache(): void {
		this.cache.clear();
		this.enhancedCache.clear();
	}
}

/** Singleton instance */
let orchestratorInstance: SearchOrchestrator | null = null;

/** Get the singleton SearchOrchestrator */
export function getSearchOrchestrator(): SearchOrchestrator {
	if (!orchestratorInstance) {
		orchestratorInstance = new SearchOrchestrator();
	}
	return orchestratorInstance;
}

/** Reset the singleton (for testing) */
export function resetSearchOrchestrator(): void {
	orchestratorInstance = null;
}

/** Clear all cached search results (call when indexer config changes). */
export function clearSearchCache(): void {
	orchestratorInstance?.clearCache();
}
