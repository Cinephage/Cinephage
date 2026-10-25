/**
 * Subtitle Search Service
 *
 * Orchestrates subtitle searches across multiple providers.
 * Handles deduplication, scoring, and result aggregation.
 */

import { db } from '#lib/server/db/index.js';
import {
	movies,
	episodes,
	series,
	movieFiles,
	episodeFiles,
	subtitleBlacklist,
	rootFolders,
	libraries
} from '#lib/server/db/schema.js';
import { basename, join } from 'path';
import { eq, and } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });
import type {
	SubtitleSearchCriteria,
	SubtitleSearchResult,
	AggregatedSearchResult,
	MediaContext,
	SubtitleMediaKind,
	LanguageCode
} from '../types';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';
import { DEFAULT_MINIMUM_SCORE } from '#lib/shared/language-profile.js';
import { selectBestCandidate } from '../acquisition.js';
import { languageSatisfies } from '../requirement-matcher.js';
import { getSubtitleProviderManager } from './SubtitleProviderManager';
import { getSubtitleScoringService } from './SubtitleScoringService';
import type { ISubtitleProvider } from '../providers/interfaces';
import type { ProviderCapabilities } from '../providers/BaseProvider';
import { normalizeLanguageTag } from '#lib/server/languages/normalize.js';

const criteriaIdCache = new Map<string, { imdbId?: string; tvdbId?: number; expires: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Canonical tag for a stored original-language value, or undefined when it is
 * missing or unresolvable so providers can pick their own fallback.
 */
function originalLanguageTag(raw: string | null | undefined): LanguageCode | undefined {
	if (!raw) return undefined;
	const tag = normalizeLanguageTag(raw);
	return tag === 'und' ? undefined : tag;
}

export function clearIdCacheForTests(): void {
	criteriaIdCache.clear();
}

/** Search options */
export interface SubtitleSearchOptions {
	/** Specific provider IDs to search (null = all enabled) */
	providerIds?: string[];
	/** Maximum results per provider */
	maxResultsPerProvider?: number;
	/** Request timeout in ms */
	timeout?: number;
	/** Whether to include blacklisted results (filtered by default) */
	includeBlacklisted?: boolean;
	/** Drop forced results when false (default: include) */
	includeForced?: boolean;
	/** Drop HI results when false (default: include) */
	includeHearingImpaired?: boolean;
	/** Drop HI results when true (default: keep) */
	excludeHearingImpaired?: boolean;
	/**
	 * Media kind for provider capability gating. Derived automatically by
	 * `searchForMovie`/`searchForEpisode`; direct `search()` callers may pass it.
	 * When omitted, capability gating by media type is skipped.
	 */
	mediaKind?: SubtitleMediaKind;
	/**
	 * When true, providers whose capabilities cannot verify hearing-impaired
	 * status are skipped (used when acquiring a `require-hi` requirement).
	 */
	requireHearingImpaired?: boolean;
	/**
	 * When true, hash-verifiable providers are ordered ahead of non-hash
	 * providers within a priority tier. Defaults to true when the criteria
	 * carries a video hash.
	 */
	preferHashVerifiable?: boolean;
	/**
	 * Single requirement currently being acquired. When provided, priority tiers
	 * stop as soon as a tier yields a candidate accepted by
	 * `selectBestCandidate` for this requirement.
	 */
	requirement?: SubtitleRequirement;
	/**
	 * All requirements currently being acquired. When provided (and no single
	 * `requirement`), the priority cascade only stops once every requirement has
	 * an acceptable candidate in the accumulated results — otherwise a tier
	 * with a weak candidate for one language would hide better candidates for
	 * the others in lower-priority providers.
	 */
	requirements?: SubtitleRequirement[];
	/** Minimum match score for the tier-acceptance check (default 70). */
	minimumScore?: number;
}

/**
 * Service for searching subtitles across providers
 */
export class SubtitleSearchService {
	private static instance: SubtitleSearchService | null = null;

	private constructor() {}

	static getInstance(): SubtitleSearchService {
		if (!SubtitleSearchService.instance) {
			SubtitleSearchService.instance = new SubtitleSearchService();
		}
		return SubtitleSearchService.instance;
	}

	/**
	 * Search for subtitles for a movie
	 *
	 * Runs one search per movie file so each quality tier gets its own
	 * hash-matchable results. Every result in a file's batch is tagged with
	 * that file's id, which SubtitleDownloadService uses to target the
	 * correct file. For a single-file movie this is exactly one search
	 * (behavior unchanged). A movie with no files falls back to a single
	 * metadata-only search.
	 *
	 * Note: a movie with N files triggers N provider search rounds
	 * (intentional - each file deserves hash matching), so provider load
	 * scales linearly with file count.
	 */
	async searchForMovie(
		movieId: string,
		languages: string[],
		options?: SubtitleSearchOptions
	): Promise<AggregatedSearchResult> {
		// Get movie details
		const movie = await db.select().from(movies).where(eq(movies.id, movieId)).limit(1);

		if (!movie[0]) {
			throw new Error(`Movie not found: ${movieId}`);
		}

		// Get all movie files (one search per file)
		const files = await db.select().from(movieFiles).where(eq(movieFiles.movieId, movieId));

		// Resolve root folder path once (shared by all files of this movie)
		let rootPath: string | undefined;
		if (movie[0].rootFolderId) {
			const rootFolder = await db
				.select()
				.from(rootFolders)
				.where(eq(rootFolders.id, movie[0].rootFolderId))
				.limit(1);
			if (rootFolder[0]) {
				rootPath = rootFolder[0].path;
			}
		}

		// No files: metadata-only search (backward compatible, no movieFileId tag)
		if (files.length === 0) {
			const criteria: SubtitleSearchCriteria = {
				title: movie[0].title,
				originalTitle: movie[0].originalTitle || undefined,
				originalLanguage: originalLanguageTag(movie[0].originalLanguage),
				year: movie[0].year || undefined,
				imdbId: movie[0].imdbId || undefined,
				tmdbId: movie[0].tmdbId,
				languages,
				includeForced: options?.includeForced,
				includeHearingImpaired: options?.includeHearingImpaired,
				excludeHearingImpaired: options?.excludeHearingImpaired
			};
			return this.search(criteria, { movieId }, { ...options, mediaKind: 'movie' });
		}

		// Per-file search: each file gets its own hash matching.
		// Duplicate provider results across files are expected and correct:
		// each file gets its own subtitle row/sidecar, and findExistingSubtitle
		// already scopes by movieFileId so there is no cross-file clobber.
		const startTime = Date.now();
		const allResults: SubtitleSearchResult[] = [];
		const providerResults: AggregatedSearchResult['providerResults'] = [];

		for (const file of files) {
			const filePath = rootPath ? join(rootPath, movie[0].path, file.relativePath) : undefined;

			const criteria: SubtitleSearchCriteria = {
				title: movie[0].title,
				originalTitle: movie[0].originalTitle || undefined,
				originalLanguage: originalLanguageTag(movie[0].originalLanguage),
				year: movie[0].year || undefined,
				imdbId: movie[0].imdbId || undefined,
				tmdbId: movie[0].tmdbId,
				languages,
				filePath,
				fileSize: file.size || undefined,
				includeForced: options?.includeForced,
				includeHearingImpaired: options?.includeHearingImpaired,
				excludeHearingImpaired: options?.excludeHearingImpaired
			};

			try {
				const batch = await this.search(criteria, { movieId }, { ...options, mediaKind: 'movie' });

				// Tag every result in this batch with the originating file id and a
				// display label so the interactive modal can group/label results.
				for (const result of batch.results) {
					result.movieFileId = file.id;
					result.movieFileName = basename(file.relativePath);
				}

				allResults.push(...batch.results);
				providerResults.push(...batch.providerResults);
			} catch (error) {
				// Isolate per-file failures: a single file's search error must not
				// abort the whole movie search. Log and continue so remaining files
				// still get their (partial) results.
				logger.warn(
					{
						movieId,
						movieFileId: file.id,
						relativePath: file.relativePath,
						err: error
					},
					'[Subtitles] Per-file subtitle search failed; continuing with remaining files'
				);
			}
		}

		return {
			results: allResults,
			totalResults: allResults.length,
			searchTimeMs: Date.now() - startTime,
			providerResults
		};
	}

	/**
	 * Search for subtitles for an episode
	 */
	async searchForEpisode(
		episodeId: string,
		languages: string[],
		options?: SubtitleSearchOptions
	): Promise<AggregatedSearchResult> {
		// Get episode with series details
		const episode = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1);

		if (!episode[0]) {
			throw new Error(`Episode not found: ${episodeId}`);
		}

		const seriesData = await db
			.select()
			.from(series)
			.where(eq(series.id, episode[0].seriesId))
			.limit(1);

		if (!seriesData[0]) {
			throw new Error(`Series not found for episode: ${episodeId}`);
		}

		// Get episode file
		const files = await db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, episode[0].seriesId));
		const file = files.find((f) => {
			const ids = f.episodeIds as string[] | null;
			return ids?.includes(episodeId);
		});

		// Get root folder path
		let filePath: string | undefined;
		if (file && seriesData[0].rootFolderId) {
			const rootFolder = await db
				.select()
				.from(rootFolders)
				.where(eq(rootFolders.id, seriesData[0].rootFolderId))
				.limit(1);
			if (rootFolder[0]) {
				filePath = join(rootFolder[0].path, seriesData[0].path, file.relativePath);
			}
		}

		// Build search criteria
		const criteria: SubtitleSearchCriteria = {
			title: episode[0].title || seriesData[0].title,
			seriesTitle: seriesData[0].title,
			originalTitle: seriesData[0].originalTitle || undefined,
			originalLanguage: originalLanguageTag(seriesData[0].originalLanguage),
			year: seriesData[0].year || undefined,
			season: episode[0].seasonNumber,
			episode: episode[0].episodeNumber,
			episodeTitle: episode[0].title || undefined,
			imdbId: seriesData[0].imdbId || undefined,
			tmdbId: seriesData[0].tmdbId,
			languages,
			filePath,
			fileSize: file?.size || undefined,
			includeForced: options?.includeForced,
			includeHearingImpaired: options?.includeHearingImpaired,
			excludeHearingImpaired: options?.excludeHearingImpaired
		};

		return this.search(
			criteria,
			{ episodeId },
			{
				...options,
				mediaKind: await this.resolveSeriesMediaKind(seriesData[0])
			}
		);
	}

	/**
	 * Resolve the capability media kind for a series: `anime` when the series
	 * type is anime or its library subtype is anime, otherwise `tv`.
	 */
	private async resolveSeriesMediaKind(seriesRow: {
		seriesType?: string | null;
		libraryId?: string | null;
	}): Promise<SubtitleMediaKind> {
		if (seriesRow.seriesType === 'anime') return 'anime';
		if (!seriesRow.libraryId) return 'tv';

		const library = await db
			.select({ mediaSubType: libraries.mediaSubType })
			.from(libraries)
			.where(eq(libraries.id, seriesRow.libraryId))
			.limit(1);
		return library[0]?.mediaSubType === 'anime' ? 'anime' : 'tv';
	}

	/**
	 * Resolve missing external IDs (imdbId, tvdbId) from TMDB when tmdbId is available.
	 * This ensures all providers get the IDs they need regardless of what's stored in the DB.
	 */
	private async enrichCriteria(criteria: SubtitleSearchCriteria): Promise<SubtitleSearchCriteria> {
		if (!criteria.tmdbId) return criteria;

		const needsImdb = !criteria.imdbId;
		const needsTvdb = !criteria.tvdbId && criteria.season !== undefined;
		if (!needsImdb && !needsTvdb) return criteria;

		const cacheKey = `${criteria.tmdbId}:${criteria.season !== undefined ? 'tv' : 'movie'}`;
		const cached = criteriaIdCache.get(cacheKey);
		if (cached && cached.expires > Date.now()) {
			if (needsImdb && cached.imdbId) criteria.imdbId = cached.imdbId;
			if (needsTvdb && cached.tvdbId) criteria.tvdbId = cached.tvdbId;
			return criteria;
		}

		try {
			const { tmdb } = await import('#lib/server/tmdb.js');
			const isTv = criteria.season !== undefined;
			let resolvedImdb: string | undefined;
			let resolvedTvdb: number | undefined;

			if (isTv) {
				const ids = await tmdb.getTvExternalIds(criteria.tmdbId);
				resolvedImdb = ids.imdb_id ?? undefined;
				resolvedTvdb = ids.tvdb_id ?? undefined;
			} else {
				const ids = await tmdb.getMovieExternalIds(criteria.tmdbId);
				resolvedImdb = ids.imdb_id ?? undefined;
			}

			if (resolvedImdb || resolvedTvdb) {
				logger.debug(
					{
						tmdbId: criteria.tmdbId,
						imdbId: resolvedImdb,
						tvdbId: resolvedTvdb,
						type: isTv ? 'tv' : 'movie'
					},
					'[Subtitles] Resolved external IDs via TMDB'
				);
			}

			criteriaIdCache.set(cacheKey, {
				imdbId: resolvedImdb,
				tvdbId: resolvedTvdb,
				expires: Date.now() + CACHE_TTL_MS
			});

			if (needsImdb && resolvedImdb) criteria.imdbId = resolvedImdb;
			if (needsTvdb && resolvedTvdb) criteria.tvdbId = resolvedTvdb;
		} catch {
			logger.debug({ tmdbId: criteria.tmdbId }, '[Subtitles] TMDB ID resolution failed');
		}

		return criteria;
	}

	/**
	 * Search with custom criteria
	 */
	async search(
		criteria: SubtitleSearchCriteria,
		mediaRef: { movieId?: string; episodeId?: string },
		options?: SubtitleSearchOptions
	): Promise<AggregatedSearchResult> {
		const startTime = Date.now();
		const providerManager = getSubtitleProviderManager();
		const scoringService = getSubtitleScoringService();

		const enrichedCriteria = await this.enrichCriteria(criteria);

		// Get providers to search
		let providers = await providerManager.getEnabledProviders();

		if (options?.providerIds?.length) {
			providers = providers.filter((p) => options.providerIds!.includes(p.id));
		}

		if (providers.length === 0) {
			return {
				results: [],
				totalResults: 0,
				searchTimeMs: Date.now() - startTime,
				providerResults: []
			};
		}

		// Get blacklisted subtitles
		const blacklist = options?.includeBlacklisted
			? new Set<string>()
			: await this.getBlacklist(mediaRef);

		const providerResults: AggregatedSearchResult['providerResults'] = [];
		const allResults: SubtitleSearchResult[] = [];
		const tierTimings: NonNullable<AggregatedSearchResult['tierTimings']> = [];

		// ------------------------------------------------------------------
		// Capability gating
		//
		// Providers that cannot serve the requested media kind are skipped (with
		// a logged reason), as are providers that cannot verify HI subtitles when
		// the acquisition requires it. This happens before any network call.
		// ------------------------------------------------------------------
		const eligibleProviders: ISubtitleProvider[] = [];
		for (const provider of providers) {
			const skipReason = this.capabilitySkipReason(provider, options);
			if (skipReason) {
				logger.info(
					{ providerId: provider.id, providerName: provider.name, reason: skipReason },
					'[Subtitles] Provider skipped by capability gating'
				);
				providerResults.push({
					providerId: provider.id,
					providerName: provider.name,
					resultCount: 0,
					searchTimeMs: 0,
					skipped: skipReason
				});
				continue;
			}
			eligibleProviders.push(provider);
		}

		// ------------------------------------------------------------------
		// Priority tiers
		//
		// Enabled providers are grouped by ascending `priority` into tiers.
		// Tiers are queried sequentially (concurrent `Promise.all` within a tier)
		// and the cascade stops as soon as a tier yields acceptable candidates, so
		// lower-priority tiers act purely as fallback. "Acceptable" means:
		// - an explicit `options.requirement` is satisfied by a candidate accepted
		//   by `selectBestCandidate` at `minimumScore` (the requirement being
		//   acquired), or
		// - every requested language has a result whose language satisfies it
		//   (`languageSatisfies`) at `minimumScore` (default 0).
		// When neither is satisfied every tier is queried (pre-tier behavior).
		// ------------------------------------------------------------------
		const preferHashVerifiable =
			options?.preferHashVerifiable ??
			Boolean(enrichedCriteria.videoHash || enrichedCriteria.filePath);

		const tiers = new Map<number, ISubtitleProvider[]>();
		for (const provider of eligibleProviders) {
			const entry = tiers.get(provider.priority);
			if (entry) entry.push(provider);
			else tiers.set(provider.priority, [provider]);
		}

		const searchableProviders = Array.from(tiers.keys()).sort((a, b) => a - b);

		for (const priority of searchableProviders) {
			const tierProviders = [...(tiers.get(priority) ?? [])];

			// Prefer hash-verifiable providers within the tier when a hash is in play.
			if (preferHashVerifiable) {
				tierProviders.sort(
					(a, b) =>
						Number(b.capabilities?.hashVerifiable ?? false) -
						Number(a.capabilities?.hashVerifiable ?? false)
				);
			}

			const tierStart = Date.now();
			const tierResultsAll: SubtitleSearchResult[] = [];

			const searchResults = await Promise.all(
				tierProviders.map(async (provider) => {
					const providerStart = Date.now();
					try {
						// Check if provider can search
						if (!provider.canSearch(enrichedCriteria)) {
							return {
								providerId: provider.id,
								providerName: provider.name,
								resultCount: 0,
								error: undefined as string | undefined,
								skipped: 'Provider cannot search with given criteria' as string | undefined,
								searchTimeMs: 0
							};
						}

						// Shared per-provider rate limiter (keyed by provider id).
						await providerManager.acquireRateLimit(provider.id);

						const results = await provider.search(enrichedCriteria, {
							maxResults: options?.maxResultsPerProvider || 25,
							timeout: options?.timeout || 30000
						});

						// Score each result
						for (const result of results) {
							result.matchScore = scoringService.score(result, enrichedCriteria);
						}

						// Record success
						await providerManager.recordSuccess(provider.id);

						const searchTimeMs = Date.now() - providerStart;
						return {
							providerId: provider.id,
							providerName: provider.name,
							resultCount: results.length,
							error: undefined as string | undefined,
							skipped: undefined as string | undefined,
							searchTimeMs,
							results
						};
					} catch (error) {
						const errorMsg = error instanceof Error ? error.message : String(error);
						logger.error({ err: error }, `Provider search failed: ${provider.name}`);

						// Record error - pass actual error object to preserve type information for proper throttling
						await providerManager.recordError(
							provider.id,
							error instanceof Error ? error : errorMsg
						);

						return {
							providerId: provider.id,
							providerName: provider.name,
							resultCount: 0,
							error: errorMsg,
							skipped: undefined as string | undefined,
							searchTimeMs: Date.now() - providerStart
						};
					}
				})
			);

			// Aggregate this tier's results
			for (const result of searchResults) {
				providerResults.push({
					providerId: result.providerId,
					providerName: result.providerName,
					resultCount: result.resultCount,
					error: result.error,
					skipped: result.skipped,
					searchTimeMs: result.searchTimeMs
				});

				if ('results' in result && result.results) {
					allResults.push(...result.results);
					tierResultsAll.push(...result.results);
				}
			}

			// Blacklisted results must not satisfy tier acceptance — otherwise a
			// blacklisted-but-acceptable result stops the cascade and lower tiers
			// (which could hold a usable candidate) are never queried.
			const eligibleTierResults = tierResultsAll.filter(
				(r) => !blacklist.has(`${r.providerId}:${r.providerSubtitleId}`)
			);
			const accepted = this.tierAccepted(eligibleTierResults, criteria, options);
			tierTimings.push({
				priority,
				providerIds: tierProviders.map((p) => p.id),
				searchTimeMs: Date.now() - tierStart,
				accepted,
				stopped: accepted
			});

			if (accepted) break;
		}

		// Filter blacklisted
		const filteredResults = allResults.filter(
			(r) => !blacklist.has(`${r.providerId}:${r.providerSubtitleId}`)
		);

		// Apply caller-supplied forced/HI preferences on the normalized results so
		// the interactive filters work uniformly for providers that ignore the
		// criteria flags. Flags are only meaningful when explicitly set.
		const preferenceFiltered = filteredResults.filter((r) => {
			if (criteria.includeForced === false && r.isForced) return false;
			if (criteria.includeHearingImpaired === false && r.isHearingImpaired) return false;
			if (criteria.excludeHearingImpaired === true && r.isHearingImpaired) return false;
			return true;
		});

		// Deduplicate by provider+id
		const uniqueResults = this.deduplicateResults(preferenceFiltered);

		// Sort by score
		const rankedResults = scoringService.rank(uniqueResults);

		return {
			results: rankedResults,
			totalResults: rankedResults.length,
			searchTimeMs: Date.now() - startTime,
			providerResults,
			tierTimings
		};
	}

	/**
	 * Why a provider cannot serve this search, or null when it can.
	 * Media-kind gating uses `options.mediaKind`; HI gating is opt-in via
	 * `options.requireHearingImpaired`. Returns a human-readable reason.
	 */
	private capabilitySkipReason(
		provider: ISubtitleProvider,
		options?: SubtitleSearchOptions
	): string | null {
		const capabilities: ProviderCapabilities | undefined = provider.capabilities;
		if (!capabilities) return null;

		switch (options?.mediaKind) {
			case 'movie':
				if (!capabilities.supportsMovies) return 'provider does not support movies';
				break;
			case 'tv':
				if (!capabilities.supportsTvShows) return 'provider does not support TV shows';
				break;
			case 'anime':
				// Anime is episodic TV content. A provider is eligible when it opts
				// into anime explicitly OR supports TV shows (the sane default), so
				// anime libraries keep general-provider coverage; only providers
				// that support neither are skipped.
				if (!capabilities.supportsAnime && !capabilities.supportsTvShows) {
					return 'provider does not support anime';
				}
				break;
		}

		if (options?.requireHearingImpaired && !capabilities.hearingImpairedVerifiable) {
			return 'provider cannot verify hearing-impaired subtitles';
		}

		return null;
	}

	/**
	 * Whether a tier's results are acceptable enough to stop the priority
	 * cascade. See `search()` for the acceptance rules.
	 */
	private tierAccepted(
		tierResults: SubtitleSearchResult[],
		criteria: SubtitleSearchCriteria,
		options?: SubtitleSearchOptions
	): boolean {
		if (tierResults.length === 0) return false;

		if (options?.requirement) {
			const selection = selectBestCandidate(
				tierResults,
				options.requirement,
				options.minimumScore ?? DEFAULT_MINIMUM_SCORE
			);
			return Boolean(selection.best);
		}

		if (options?.requirements && options.requirements.length > 0) {
			const minScore = options.minimumScore ?? DEFAULT_MINIMUM_SCORE;
			// Accumulated tier results: accept only when EVERY acquired
			// requirement has an acceptable candidate so lower tiers still get a
			// chance to fill the gaps.
			return options.requirements.every((requirement) =>
				Boolean(selectBestCandidate(tierResults, requirement, minScore).best)
			);
		}

		const minScore = options?.minimumScore ?? 0;
		return criteria.languages.every((lang) =>
			tierResults.some((r) => r.matchScore >= minScore && languageSatisfies(r.language, lang))
		);
	}

	/**
	 * Build media context for a movie
	 */
	async getMovieContext(movieId: string): Promise<MediaContext | null> {
		const movie = await db.select().from(movies).where(eq(movies.id, movieId)).limit(1);
		if (!movie[0]) return null;

		const files = await db.select().from(movieFiles).where(eq(movieFiles.movieId, movieId));
		const file = files[0];

		// Get root folder path
		let filePath: string | undefined;
		if (file && movie[0].rootFolderId) {
			const rootFolder = await db
				.select()
				.from(rootFolders)
				.where(eq(rootFolders.id, movie[0].rootFolderId))
				.limit(1);
			if (rootFolder[0]) {
				filePath = join(rootFolder[0].path, movie[0].path, file.relativePath);
			}
		}

		return {
			type: 'movie',
			id: movieId,
			title: movie[0].title,
			year: movie[0].year || undefined,
			imdbId: movie[0].imdbId || undefined,
			tmdbId: movie[0].tmdbId,
			filePath,
			fileSize: file?.size || undefined
		};
	}

	/**
	 * Build media context for an episode
	 */
	async getEpisodeContext(episodeId: string): Promise<MediaContext | null> {
		const episode = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1);
		if (!episode[0]) return null;

		const seriesData = await db
			.select()
			.from(series)
			.where(eq(series.id, episode[0].seriesId))
			.limit(1);
		if (!seriesData[0]) return null;

		const files = await db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, episode[0].seriesId));
		const file = files.find((f) => {
			const ids = f.episodeIds as string[] | null;
			return ids?.includes(episodeId);
		});

		// Get root folder path
		let filePath: string | undefined;
		if (file && seriesData[0].rootFolderId) {
			const rootFolder = await db
				.select()
				.from(rootFolders)
				.where(eq(rootFolders.id, seriesData[0].rootFolderId))
				.limit(1);
			if (rootFolder[0]) {
				filePath = join(rootFolder[0].path, seriesData[0].path, file.relativePath);
			}
		}

		return {
			type: 'episode',
			id: episodeId,
			title: episode[0].title || seriesData[0].title,
			year: seriesData[0].year || undefined,
			imdbId: seriesData[0].imdbId || undefined,
			tmdbId: seriesData[0].tmdbId,
			seriesId: seriesData[0].id,
			seriesTitle: seriesData[0].title,
			season: episode[0].seasonNumber,
			episode: episode[0].episodeNumber,
			filePath,
			fileSize: file?.size || undefined
		};
	}

	/**
	 * Get blacklisted subtitle IDs for media
	 */
	private async getBlacklist(mediaRef: {
		movieId?: string;
		episodeId?: string;
	}): Promise<Set<string>> {
		const conditions = [];
		if (mediaRef.movieId) {
			conditions.push(eq(subtitleBlacklist.movieId, mediaRef.movieId));
		}
		if (mediaRef.episodeId) {
			conditions.push(eq(subtitleBlacklist.episodeId, mediaRef.episodeId));
		}

		if (conditions.length === 0) return new Set();

		const blacklisted = await db
			.select()
			.from(subtitleBlacklist)
			.where(conditions.length === 1 ? conditions[0] : and(...conditions));

		return new Set(blacklisted.map((b) => `${b.providerId}:${b.providerSubtitleId}`));
	}

	/**
	 * Deduplicate results from multiple providers
	 */
	private deduplicateResults(results: SubtitleSearchResult[]): SubtitleSearchResult[] {
		const seen = new Map<string, SubtitleSearchResult>();

		for (const result of results) {
			const key = `${result.providerId}:${result.providerSubtitleId}`;

			// Keep the one with higher score
			const existing = seen.get(key);
			if (!existing || result.matchScore > existing.matchScore) {
				seen.set(key, result);
			}
		}

		return Array.from(seen.values());
	}
}

/**
 * Get the singleton SubtitleSearchService
 */
export function getSubtitleSearchService(): SubtitleSearchService {
	return SubtitleSearchService.getInstance();
}
