/**
 * Monitoring Search Service
 *
 * Orchestrates searches for monitoring tasks:
 * - Filters content through specifications
 * - Executes searches via IndexerManager
 * - Evaluates results through decision engine
 * - Auto-grabs best releases
 */

import { db } from '#lib/server/db/index.js';
import { todayDateString } from '#lib/utils/format.js';
import {
	movies,
	movieFiles,
	series,
	episodes,
	episodeFiles,
	scoringProfiles,
	downloadQueue,
	settings
} from '#lib/server/db/schema.js';
import { eq, and, lte, gte, inArray, isNotNull } from 'drizzle-orm';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import {
	isRuTrackerHost,
	isRuTrackerIndexerName
} from '#lib/server/indexers/search/russian-trackers.js';
import { AUTO_GRAB_MIN_SCORE } from '#lib/server/library/searchOnAdd/search-utils.js';

import {
	parseEpisodePointerFromGuid,
	parseEpisodePointerFromTitle
} from '#lib/server/downloads/episode-pointer.js';
import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { SearchCriteria, EnhancedReleaseResult } from '#lib/server/indexers/types/index.js';
import { scoreRelease, isUpgrade } from '#lib/server/scoring/scorer.js';
import type { ScoringProfile } from '#lib/server/scoring/types.js';
import { qualityFilter } from '#lib/server/quality/index.js';
import { resolveMovieMultiQuality } from '#lib/server/quality/movie-buckets.js';
import { getFilledResolutions } from '#lib/server/quality/buckets.js';
import type { Resolution } from '#lib/server/indexers/parser/types.js';
import { TaskCancelledException } from '#lib/server/tasks/TaskCancelledException.js';
import {
	getMovieSearchTitles,
	getSeriesSearchTitles
} from '#lib/server/services/AlternateTitleService.js';

// Specifications
import {
	MovieMonitoredSpecification,
	EpisodeMonitoredSpecification,
	MovieMissingContentSpecification,
	EpisodeMissingContentSpecification,
	MovieCutoffUnmetSpecification,
	EpisodeCutoffUnmetSpecification,
	MovieUpgradeableSpecification,
	EpisodeUpgradeableSpecification,
	NewEpisodeSpecification,
	NEW_EPISODE_LOOKBACK_HOURS,
	MovieAvailabilitySpecification,
	MovieSearchCooldownSpecification,
	EpisodeSearchCooldownSpecification,
	ReleaseBlocklistSpecification,
	MovieReadOnlyFolderSpecification,
	EpisodeReadOnlyFolderSpecification,
	type MovieContext,
	type EpisodeContext,
	type ReleaseCandidate
} from '../specifications/index.js';

const logger = createChildLogger({ module: 'MonitoringSearchService', logDomain: 'monitoring' });

const parser = new ReleaseParser();

/**
 * Search result for individual item
 */
export interface ItemSearchResult {
	itemId: string;
	itemType: 'movie' | 'episode';
	title: string;
	searched: boolean;
	releasesFound: number;
	grabbed: boolean;
	grabbedRelease?: string;
	queueItemId?: string;
	error?: string;
	rejectionType?: string;
	skipped?: boolean;
	skipReason?: string;
}

/**
 * Aggregated search results
 */
export interface SearchResults {
	items: ItemSearchResult[];
	summary: {
		searched: number;
		found: number;
		grabbed: number;
		skipped: number;
		errors: number;
		rejectionBreakdown?: Record<string, number>;
	};
	/** Detailed upgrade decisions (only populated in dry-run mode) */
	upgradeDetails?: UpgradeDecisionDetail[];
}

/**
 * Detailed result for dry-run mode showing upgrade decision details
 */
export interface UpgradeDecisionDetail {
	itemId: string;
	itemType: 'movie' | 'episode';
	title: string;
	existingFile: {
		name: string;
		score: number;
		breakdown?: Record<string, number>;
	};
	bestCandidate: {
		name: string;
		score: number;
		improvement: number;
		breakdown?: Record<string, number>;
	} | null;
	candidatesChecked: number;
	wouldGrab: boolean;
	reason: string;
}

/**
 * Options for upgrade searches
 */
export interface UpgradeSearchOptions {
	movieIds?: string[];
	seriesIds?: string[];
	maxItems?: number;
	/**
	 * If true, only search items where cutoff is unmet (below target quality).
	 * If false, search ALL items with files for potential upgrades.
	 * Default: true (matches legacy behavior)
	 */
	cutoffUnmetOnly?: boolean;
	/**
	 * Optional AbortSignal for cancellation support
	 */
	signal?: AbortSignal;
	/**
	 * If true, don't actually grab releases - just simulate and log what would happen.
	 * Returns detailed upgrade decision info for debugging.
	 */
	dryRun?: boolean;
	/**
	 * When true, bypass search cooldown checks.
	 * Useful for manually-triggered "search now" flows.
	 */
	ignoreCooldown?: boolean;
	/**
	 * Per-item cooldown in hours for this search run.
	 * Typically derived from the scheduled task interval.
	 */
	cooldownHours?: number;
}

interface MissingSearchOptions {
	/**
	 * When true, bypass search cooldown checks.
	 * Useful for manually-triggered "search now" flows.
	 */
	ignoreCooldown?: boolean;
	/**
	 * Per-item cooldown in hours for this search run.
	 * Typically derived from the scheduled task interval.
	 */
	cooldownHours?: number;
}

/**
 * MonitoringSearchService - Coordinate searches for monitoring
 */
export class MonitoringSearchService {
	private readonly MAX_CONCURRENT_SEARCHES = 10;

	// Ceiling on individual per-episode indexer searches within a single
	// series search invocation. Without this, an automatic/manual search on
	// a large back-catalog series with hundreds of missing episodes falls
	// through the season-pack strategy (skipped below 50% missing per
	// season) into this per-episode loop and can fire hundreds of
	// sequential indexer requests, exhausting a real indexer's API quota.
	private readonly MAX_INDIVIDUAL_EPISODE_SEARCHES_PER_SERIES = 40;

	// Queue statuses that can block new searches for the same media.
	// 'paused' and 'seeding' are only blocking when import has not completed yet.
	private readonly BLOCKING_DOWNLOAD_STATUSES = [
		'queued',
		'downloading',
		'awaiting',
		'paused',
		'seeding',
		'importing'
	];
	private readonly ALWAYS_BLOCKING_DOWNLOAD_STATUSES = [
		'queued',
		'downloading',
		'awaiting',
		'importing'
	];

	// Cache for season episode counts to avoid N+1 queries
	// Key: `${seriesId}-${seasonNumber}`, Value: episode count
	private seasonEpisodeCountCache: Map<string, number> = new Map();

	private async getGlobalIncludeAdult(): Promise<boolean> {
		try {
			const row = await db.query.settings.findFirst({ where: eq(settings.key, 'global_filters') });
			if (!row?.value) return false;
			const parsed = JSON.parse(row.value);
			return parsed?.include_adult === true;
		} catch {
			return false;
		}
	}

	/**
	 * Select the best existing file to use as the upgrade baseline.
	 * Prefers downloaded files over .strm (which have poor quality metadata),
	 * then prefers higher resolution, then larger file size.
	 */
	private selectBestExistingFile<
		T extends {
			relativePath: string;
			quality?: { resolution?: string } | null;
			size?: number | null;
		}
	>(files: T[]): T {
		if (files.length <= 1) return files[0];

		const RESOLUTION_RANK: Record<string, number> = {
			'2160p': 6,
			'1080p': 5,
			'720p': 4,
			'480p': 3,
			'360p': 2
		};

		const scored = files.map((f) => {
			const isStrm = f.relativePath.endsWith('.strm');
			const res = f.quality?.resolution ?? '';
			const resRank = RESOLUTION_RANK[res] ?? 0;
			const size = f.size ?? 0;

			const typeBonus = isStrm ? 0 : 10000;
			return {
				file: f,
				score: typeBonus + resRank * 1000 + Math.min(size / (1024 * 1024), 100)
			};
		});

		scored.sort((a, b) => b.score - a.score);
		return scored[0].file;
	}

	// How long a failed download blocks re-grabs for the same media (ms).
	private readonly FAILED_DOWNLOAD_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

	private isRecentlyFailed(lastAttemptAt: string | null): boolean {
		if (!lastAttemptAt) return false;
		return Date.now() - new Date(lastAttemptAt).getTime() < this.FAILED_DOWNLOAD_COOLDOWN_MS;
	}

	/**
	 * Check if a movie already has an active download in the queue
	 */
	private async isMovieAlreadyDownloading(movieId: string): Promise<boolean> {
		const activeDownloads = await db
			.select({
				id: downloadQueue.id,
				status: downloadQueue.status,
				title: downloadQueue.title,
				importedAt: downloadQueue.importedAt,
				lastAttemptAt: downloadQueue.lastAttemptAt
			})
			.from(downloadQueue)
			.where(
				and(
					eq(downloadQueue.movieId, movieId),
					inArray(downloadQueue.status, [...this.BLOCKING_DOWNLOAD_STATUSES, 'failed'])
				)
			);

		const blockingDownload = activeDownloads.find((download) => {
			if (this.ALWAYS_BLOCKING_DOWNLOAD_STATUSES.includes(download.status)) {
				return true;
			}

			// Recently failed downloads block re-grabs to prevent rapid grab-fail cycles.
			if (download.status === 'failed') {
				return this.isRecentlyFailed(download.lastAttemptAt);
			}

			// Legacy/active torrent states: only block if import has not happened yet.
			return (
				(download.status === 'paused' || download.status === 'seeding') && !download.importedAt
			);
		});

		const found = Boolean(blockingDownload);
		logger.debug(
			{
				movieId,
				found,
				activeDownload: blockingDownload
			},
			'[MonitoringSearch] isMovieAlreadyDownloading check'
		);

		return found;
	}

	/**
	 * Check if any of the episodes already have an active download in the queue
	 */
	private async areEpisodesAlreadyDownloading(episodeIds: string[]): Promise<boolean> {
		// Download queue stores episodeIds as JSON array - we need to check if any overlap
		const activeDownloads = await db
			.select({
				episodeIds: downloadQueue.episodeIds,
				status: downloadQueue.status,
				importedAt: downloadQueue.importedAt,
				lastAttemptAt: downloadQueue.lastAttemptAt
			})
			.from(downloadQueue)
			.where(inArray(downloadQueue.status, [...this.BLOCKING_DOWNLOAD_STATUSES, 'failed']));

		const activeEpisodeIds = new Set<string>();
		for (const download of activeDownloads) {
			const isBlocking =
				this.ALWAYS_BLOCKING_DOWNLOAD_STATUSES.includes(download.status) ||
				(download.status === 'failed' && this.isRecentlyFailed(download.lastAttemptAt)) ||
				((download.status === 'paused' || download.status === 'seeding') && !download.importedAt);

			if (!isBlocking) {
				continue;
			}

			if (download.episodeIds) {
				for (const id of download.episodeIds) {
					activeEpisodeIds.add(id);
				}
			}
		}

		return episodeIds.some((id) => activeEpisodeIds.has(id));
	}

	/**
	 * Detect and repair movies where hasFile=false but a movieFiles row exists.
	 * Returns the set of movie IDs that were stale and have been corrected.
	 */
	private async repairStaleMovieHasFile(movieIds: string[]): Promise<Set<string>> {
		if (movieIds.length === 0) return new Set();

		const filesForMovies = await db
			.select({ movieId: movieFiles.movieId })
			.from(movieFiles)
			.where(inArray(movieFiles.movieId, movieIds))
			.all();

		if (filesForMovies.length === 0) return new Set();

		const staleMovieIds = new Set(filesForMovies.map((f) => f.movieId));

		await db
			.update(movies)
			.set({ hasFile: true })
			.where(inArray(movies.id, Array.from(staleMovieIds)));

		logger.warn(
			{ movieIds: Array.from(staleMovieIds) },
			'[MonitoringSearch] Repaired stale hasFile flag: movies had movieFiles rows but hasFile=false. Skipping search for these movies.'
		);

		return staleMovieIds;
	}

	/**
	 * Detect and repair episodes where hasFile=false but an episodeFiles row references them.
	 * Returns the set of episode IDs that were stale and have been corrected.
	 */
	private async repairStaleEpisodeHasFile(
		episodeIds: string[],
		seriesIds: string[]
	): Promise<Set<string>> {
		if (episodeIds.length === 0 || seriesIds.length === 0) return new Set();

		// Fetch episodeFiles for the affected series, retrieving the episodeIds JSON arrays
		const filesForSeries = await db
			.select({ episodeIds: episodeFiles.episodeIds })
			.from(episodeFiles)
			.where(inArray(episodeFiles.seriesId, seriesIds))
			.all();

		if (filesForSeries.length === 0) return new Set();

		// Build the set of episode IDs that already have a file
		const episodeIdsWithFile = new Set<string>();
		for (const row of filesForSeries) {
			if (row.episodeIds) {
				for (const id of row.episodeIds) {
					episodeIdsWithFile.add(id);
				}
			}
		}

		const staleEpisodeIds = new Set(episodeIds.filter((id) => episodeIdsWithFile.has(id)));

		if (staleEpisodeIds.size === 0) return new Set();

		await db
			.update(episodes)
			.set({ hasFile: true })
			.where(inArray(episodes.id, Array.from(staleEpisodeIds)));

		logger.warn(
			{ episodeIds: Array.from(staleEpisodeIds) },
			'[MonitoringSearch] Repaired stale hasFile flag: episodes had episodeFiles rows but hasFile=false. Skipping search for these episodes.'
		);

		return staleEpisodeIds;
	}

	/**
	 * Pre-load episode counts for all seasons of given series IDs in a single query.
	 * Call this at the start of a search operation to avoid N+1 queries.
	 * Only counts aired episodes for accurate completion percentage calculation.
	 */
	private async preloadSeasonEpisodeCounts(seriesIds: string[]): Promise<void> {
		if (seriesIds.length === 0) return;

		// Clear old cache entries for these series
		for (const seriesId of seriesIds) {
			// Remove any cached entries for this series
			for (const key of this.seasonEpisodeCountCache.keys()) {
				if (key.startsWith(`${seriesId}-`)) {
					this.seasonEpisodeCountCache.delete(key);
				}
			}
		}

		const today = todayDateString();
		const isAired = (ep: { airDate: string | null }) =>
			Boolean(ep.airDate && ep.airDate !== '' && ep.airDate <= today);

		// Single query to get all aired episode counts grouped by series and season
		const allCounts = await db
			.select({
				seriesId: episodes.seriesId,
				seasonNumber: episodes.seasonNumber,
				airDate: episodes.airDate
			})
			.from(episodes)
			.where(inArray(episodes.seriesId, seriesIds));

		// Count aired episodes per series/season combination
		const countMap = new Map<string, number>();
		for (const row of allCounts) {
			if (!isAired(row)) continue;
			const key = `${row.seriesId}-${row.seasonNumber}`;
			countMap.set(key, (countMap.get(key) || 0) + 1);
		}

		// Store in cache
		for (const [key, count] of countMap) {
			this.seasonEpisodeCountCache.set(key, count);
		}

		logger.debug(
			{
				seriesCount: seriesIds.length,
				seasonCount: countMap.size
			},
			'[MonitoringSearch] Preloaded season episode counts'
		);
	}

	/**
	 * Clear the season episode count cache.
	 * Call this after a search operation completes.
	 */
	private clearSeasonEpisodeCountCache(): void {
		this.seasonEpisodeCountCache.clear();
	}

	/**
	 * Get the episode count for a specific season.
	 * Uses cache if available, otherwise falls back to database query.
	 * Only counts aired episodes for accurate completion percentage calculation.
	 * Used for season pack size validation (per-episode size calculation)
	 */
	private async getSeasonEpisodeCount(seriesId: string, seasonNumber: number): Promise<number> {
		const cacheKey = `${seriesId}-${seasonNumber}`;

		// Check cache first
		const cached = this.seasonEpisodeCountCache.get(cacheKey);
		if (cached !== undefined) {
			return cached;
		}

		const today = todayDateString();
		const isAired = (ep: { airDate: string | null }) =>
			Boolean(ep.airDate && ep.airDate !== '' && ep.airDate <= today);

		// Fallback to database query (for cases where cache wasn't preloaded)
		const seasonEpisodes = await db.query.episodes.findMany({
			where: and(eq(episodes.seriesId, seriesId), eq(episodes.seasonNumber, seasonNumber)),
			columns: { id: true, airDate: true }
		});

		const count = seasonEpisodes.filter(isAired).length;

		// Cache for future calls in this operation
		this.seasonEpisodeCountCache.set(cacheKey, count);

		return count;
	}

	private async getAiredSeasonEpisodeIds(
		seriesId: string,
		seasonNumber: number
	): Promise<string[]> {
		const today = todayDateString();
		const isAired = (ep: { airDate: string | null }) =>
			Boolean(ep.airDate && ep.airDate !== '' && ep.airDate <= today);

		const seasonEpisodes = await db.query.episodes.findMany({
			where: and(eq(episodes.seriesId, seriesId), eq(episodes.seasonNumber, seasonNumber)),
			columns: { id: true, airDate: true }
		});

		return seasonEpisodes.filter(isAired).map((ep) => ep.id);
	}

	/**
	 * Search for missing movies
	 * @param signal - Optional AbortSignal for cancellation support
	 */
	async searchMissingMovies(
		signal?: AbortSignal,
		options: MissingSearchOptions = {}
	): Promise<SearchResults> {
		logger.info('[MonitoringSearch] Starting missing movies search');

		const results: ItemSearchResult[] = [];
		const ignoreCooldown = options.ignoreCooldown ?? false;
		const cooldownHours = options.cooldownHours;

		try {
			// Check for cancellation
			if (signal?.aborted) {
				logger.info('[MonitoringSearch] Missing movies search cancelled');
				throw new TaskCancelledException('search');
			}

			// Query monitored movies without files
			const missingMovies = await db.query.movies.findMany({
				where: and(eq(movies.monitored, true), eq(movies.hasFile, false)),
				with: {
					scoringProfile: true
				}
			});

			logger.info({ count: missingMovies.length }, '[MonitoringSearch] Found missing movies');

			// Repair any stale hasFile flags before searching (hasFile=false but file row exists)
			const staleMovieIds = await this.repairStaleMovieHasFile(missingMovies.map((m) => m.id));

			// Filter through specifications
			const missingSpec = new MovieMissingContentSpecification();
			const monitoredSpec = new MovieMonitoredSpecification();
			const readOnlySpec = new MovieReadOnlyFolderSpecification();
			const availabilitySpec = new MovieAvailabilitySpecification();
			const cooldownSpec = new MovieSearchCooldownSpecification(cooldownHours);

			for (const movie of missingMovies) {
				// Check for cancellation before processing each movie
				if (signal?.aborted) {
					logger.info('[MonitoringSearch] Missing movies search cancelled during processing');
					throw new TaskCancelledException('search');
				}

				// Skip movies whose hasFile flag was stale (already repaired above)
				if (staleMovieIds.has(movie.id)) continue;
				const context: MovieContext = {
					movie,
					profile: movie.scoringProfile ?? undefined
				};

				// Check monitored
				const monitoredResult = await monitoredSpec.isSatisfied(context);
				if (!monitoredResult.accepted) {
					results.push({
						itemId: movie.id,
						itemType: 'movie',
						title: movie.title,
						searched: false,
						releasesFound: 0,
						grabbed: false,
						skipped: true,
						skipReason: monitoredResult.reason
					});
					continue;
				}

				// Skip movies in read-only folders (imports would fail anyway)
				const readOnlyResult = await readOnlySpec.isSatisfied(context);
				if (!readOnlyResult.accepted) {
					results.push({
						itemId: movie.id,
						itemType: 'movie',
						title: movie.title,
						searched: false,
						releasesFound: 0,
						grabbed: false,
						skipped: true,
						skipReason: readOnlyResult.reason
					});
					continue;
				}

				// Check availability (must meet minimum availability threshold)
				const availabilityResult = await availabilitySpec.isSatisfied(context);
				if (!availabilityResult.accepted) {
					results.push({
						itemId: movie.id,
						itemType: 'movie',
						title: movie.title,
						searched: false,
						releasesFound: 0,
						grabbed: false,
						skipped: true,
						skipReason: availabilityResult.reason
					});
					continue;
				}

				// Check search cooldown (prevent hammering indexers), unless manually bypassed
				if (!ignoreCooldown) {
					const cooldownResult = await cooldownSpec.isSatisfied(context);
					if (!cooldownResult.accepted) {
						results.push({
							itemId: movie.id,
							itemType: 'movie',
							title: movie.title,
							searched: false,
							releasesFound: 0,
							grabbed: false,
							skipped: true,
							skipReason: cooldownResult.reason
						});
						continue;
					}
				}

				// Check missing
				const missingResult = await missingSpec.isSatisfied(context);
				if (!missingResult.accepted) {
					results.push({
						itemId: movie.id,
						itemType: 'movie',
						title: movie.title,
						searched: false,
						releasesFound: 0,
						grabbed: false,
						skipped: true,
						skipReason: missingResult.reason
					});
					continue;
				}

				// Update lastSearchTime before searching
				await db
					.update(movies)
					.set({ lastSearchTime: new Date().toISOString() })
					.where(eq(movies.id, movie.id));

				// Search and grab
				const searchResult = await this.searchAndGrabMovie(movie);
				results.push(searchResult);

				// Rate limiting - small delay between searches
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		} catch (error) {
			logger.error({ err: error }, '[MonitoringSearch] Missing movies search failed');
		}

		// Multi-quality: fill any desired resolution buckets that have no file yet.
		try {
			const bucketResults = await this.searchMissingMovieQualityBuckets(signal, {
				ignoreCooldown,
				cooldownHours
			});
			results.push(...bucketResults);
		} catch (error) {
			logger.error({ err: error }, '[MonitoringSearch] Multi-quality bucket search failed');
		}

		return this.aggregateResults(results);
	}

	/**
	 * For movies in multi-quality mode, search for and grab releases that fill
	 * desired resolution buckets which currently have no file. A single title-based
	 * search is run per movie; candidates are then filtered to each unfilled bucket.
	 */
	private async searchMissingMovieQualityBuckets(
		signal?: AbortSignal,
		options: MissingSearchOptions = {}
	): Promise<ItemSearchResult[]> {
		const { ignoreCooldown = false, cooldownHours } = options;
		const results: ItemSearchResult[] = [];

		// Monitored movies that have declared desired qualities (multi-quality candidates)
		const candidates = await db.query.movies.findMany({
			where: and(eq(movies.monitored, true), isNotNull(movies.desiredQualities)),
			with: { scoringProfile: true }
		});

		if (candidates.length === 0) return results;

		const cooldownSpec = new MovieSearchCooldownSpecification(cooldownHours);

		for (const movie of candidates) {
			if (signal?.aborted) {
				throw new TaskCancelledException('search');
			}

			const { effective, multiQuality } = await resolveMovieMultiQuality(
				movie.desiredQualities,
				movie.scoringProfileId
			);
			if (!multiQuality) continue;

			// Respect cooldown (per movie)
			if (!ignoreCooldown) {
				const cooldownResult = await cooldownSpec.isSatisfied({
					movie,
					profile: movie.scoringProfile ?? undefined
				});
				if (!cooldownResult.accepted) continue;
			}

			// Skip if there's already an active download for this movie
			if (await this.isMovieAlreadyDownloading(movie.id)) continue;

			const files = await db.query.movieFiles.findMany({
				where: eq(movieFiles.movieId, movie.id)
			});
			const filled = getFilledResolutions(files);
			const unfilled = effective.filter((r) => !filled.includes(r));
			if (unfilled.length === 0) continue;

			// Update lastSearchTime
			await db
				.update(movies)
				.set({ lastSearchTime: new Date().toISOString() })
				.where(eq(movies.id, movie.id));

			// One title-based search, then grab per unfilled bucket
			const [indexerManager, globalIncludeAdult] = await Promise.all([
				getIndexerManager(),
				this.getGlobalIncludeAdult()
			]);
			const searchTitles = await getMovieSearchTitles(movie.id);
			const criteria: SearchCriteria = {
				searchType: 'movie',
				query: movie.title,
				tmdbId: movie.tmdbId,
				imdbId: movie.imdbId ?? undefined,
				year: movie.year ?? undefined,
				searchTitles,
				isAdult: globalIncludeAdult && (movie.adult ?? false) ? true : undefined
			};
			const searchResult = await indexerManager.searchEnhanced(criteria, {
				searchSource: 'automatic',
				enrichment: {
					scoringProfileId: movie.scoringProfileId ?? undefined,
					filterRejected: true,
					minScore: AUTO_GRAB_MIN_SCORE
				}
			});

			if (searchResult.releases.length === 0) continue;

			const blocklistSpec = new ReleaseBlocklistSpecification({ movieId: movie.id });
			const filledSoFar = new Set<Resolution>(filled);

			for (const targetResolution of unfilled) {
				// Find the best-scoring release matching this bucket that isn't blocklisted
				let bestRelease: (typeof searchResult.releases)[number] | undefined;
				for (const release of searchResult.releases) {
					if (release.parsed.resolution !== targetResolution) continue;
					const bc: ReleaseCandidate = {
						title: release.title,
						score: release.totalScore ?? 0,
						infoHash: release.infoHash,
						indexerId: release.indexerId
					};
					const bl = await blocklistSpec.isSatisfied(bc);
					if (!bl.accepted) continue;
					if (!bestRelease || (release.totalScore ?? 0) > (bestRelease.totalScore ?? 0)) {
						bestRelease = release;
					}
				}
				if (!bestRelease) continue;

				const grabResult = await this.grabRelease(bestRelease, {
					mediaType: 'movie',
					movieId: movie.id,
					isAutomatic: true
				});
				if (grabResult.success) {
					filledSoFar.add(targetResolution);
					results.push({
						itemId: movie.id,
						itemType: 'movie',
						title: movie.title,
						searched: true,
						releasesFound: searchResult.releases.length,
						grabbed: true,
						grabbedRelease: grabResult.releaseName,
						queueItemId: grabResult.queueItemId
					});
				}
			}

			// Small delay between movies
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		return results;
	}

	/**
	 * For movies in multi-quality mode, search for within-tier upgrades across
	 * each filled resolution bucket. A single title-based search is run; the best
	 * same-resolution candidate per bucket is offered to the grab pipeline, which
	 * only grabs when it is a genuine within-bucket upgrade.
	 */
	private async searchMovieQualityBucketUpgrades(
		movie: typeof movies.$inferSelect & {
			scoringProfile?: typeof scoringProfiles.$inferSelect | null;
		},
		existingFiles: (typeof movieFiles.$inferSelect)[],
		effective: Resolution[],
		options: { signal?: AbortSignal; ignoreCooldown?: boolean; cooldownHours?: number }
	): Promise<ItemSearchResult[]> {
		const { signal } = options;
		const results: ItemSearchResult[] = [];

		if (signal?.aborted) throw new TaskCancelledException('search');
		if (await this.isMovieAlreadyDownloading(movie.id)) return results;

		const filled = getFilledResolutions(existingFiles);
		// Only buckets that are both desired and currently filled are upgrade targets
		const upgradeTargets = effective.filter((r) => filled.includes(r));
		if (upgradeTargets.length === 0) return results;

		const [indexerManager, globalIncludeAdult] = await Promise.all([
			getIndexerManager(),
			this.getGlobalIncludeAdult()
		]);
		const searchTitles = await getMovieSearchTitles(movie.id);
		const criteria: SearchCriteria = {
			searchType: 'movie',
			query: movie.title,
			tmdbId: movie.tmdbId,
			imdbId: movie.imdbId ?? undefined,
			year: movie.year ?? undefined,
			searchTitles,
			isAdult: globalIncludeAdult && (movie.adult ?? false) ? true : undefined
		};
		const searchResult = await indexerManager.searchEnhanced(criteria, {
			searchSource: 'automatic',
			enrichment: {
				scoringProfileId: movie.scoringProfileId ?? undefined,
				filterRejected: true,
				minScore: AUTO_GRAB_MIN_SCORE
			}
		});

		if (searchResult.releases.length === 0) return results;

		const blocklistSpec = new ReleaseBlocklistSpecification({ movieId: movie.id });

		for (const targetResolution of upgradeTargets) {
			if (signal?.aborted) throw new TaskCancelledException('search');

			// Best-scoring non-blocklisted release matching this bucket
			let bestRelease: (typeof searchResult.releases)[number] | undefined;
			for (const release of searchResult.releases) {
				if (release.parsed.resolution !== targetResolution) continue;
				const bc: ReleaseCandidate = {
					title: release.title,
					score: release.totalScore ?? 0,
					infoHash: release.infoHash,
					indexerId: release.indexerId
				};
				const bl = await blocklistSpec.isSatisfied(bc);
				if (!bl.accepted) continue;
				if (!bestRelease || (release.totalScore ?? 0) > (bestRelease.totalScore ?? 0)) {
					bestRelease = release;
				}
			}
			if (!bestRelease) continue;

			// isUpgrade bypasses occupancy for the filled bucket; the grab pipeline's
			// UpgradeStage performs the within-bucket comparison and only grabs if better.
			const grabResult = await this.grabRelease(bestRelease, {
				mediaType: 'movie',
				movieId: movie.id,
				isAutomatic: true,
				isUpgrade: true
			});
			if (grabResult.success) {
				results.push({
					itemId: movie.id,
					itemType: 'movie',
					title: movie.title,
					searched: true,
					releasesFound: searchResult.releases.length,
					grabbed: true,
					grabbedRelease: grabResult.releaseName,
					queueItemId: grabResult.queueItemId
				});
			}
		}

		return results;
	}

	/**
	 * Search for missing episodes in a series or all series
	 * Uses cascading search strategy: series packs -> season packs -> individual episodes
	 * @param signal - Optional AbortSignal for cancellation support
	 */
	async searchMissingEpisodes(
		signal?: AbortSignal,
		options: MissingSearchOptions = {}
	): Promise<SearchResults> {
		logger.info('[MonitoringSearch] Starting missing episodes search with cascading strategy');

		const results: ItemSearchResult[] = [];
		const ignoreCooldown = options.ignoreCooldown ?? false;
		const cooldownHours = options.cooldownHours;

		try {
			// Check for cancellation
			if (signal?.aborted) {
				logger.info('[MonitoringSearch] Missing episodes search cancelled');
				throw new TaskCancelledException('search');
			}

			// Query monitored episodes without files
			const query = and(
				eq(episodes.monitored, true),
				eq(episodes.hasFile, false),
				lte(episodes.airDate, todayDateString()) // Only aired episodes
			);

			const missingEpisodes = await db.query.episodes.findMany({
				where: query,
				with: {
					series: {
						with: {
							scoringProfile: true
						}
					},
					season: true
				}
			});

			logger.info({ count: missingEpisodes.length }, '[MonitoringSearch] Found missing episodes');

			// Repair any stale hasFile flags before searching (hasFile=false but episodeFiles row exists)
			const uniqueSeriesIds = [...new Set(missingEpisodes.map((e) => e.seriesId))];
			const staleEpisodeIds = await this.repairStaleEpisodeHasFile(
				missingEpisodes.map((e) => e.id),
				uniqueSeriesIds
			);

			// Filter through specifications first
			const missingSpec = new EpisodeMissingContentSpecification();
			const monitoredSpec = new EpisodeMonitoredSpecification();
			const readOnlySpec = new EpisodeReadOnlyFolderSpecification();
			const cooldownSpec = new EpisodeSearchCooldownSpecification(cooldownHours);

			// Filter and group episodes by series and season
			const episodesBySeriesAndSeason = new Map<string, Map<number, typeof missingEpisodes>>();
			const seriesDataMap = new Map<string, (typeof missingEpisodes)[0]['series']>();

			for (const episode of missingEpisodes) {
				// Check for cancellation before processing each episode
				if (signal?.aborted) {
					logger.info('[MonitoringSearch] Missing episodes search cancelled during processing');
					throw new TaskCancelledException('search');
				}

				// Skip episodes whose hasFile flag was stale (already repaired above)
				if (staleEpisodeIds.has(episode.id)) continue;

				if (!episode.series) continue;

				const context: EpisodeContext = {
					series: episode.series,
					episode,
					profile: episode.series.scoringProfile ?? undefined
				};

				// Check monitored (cascading)
				const monitoredResult = await monitoredSpec.isSatisfied(context);
				if (!monitoredResult.accepted) {
					results.push({
						itemId: episode.id,
						itemType: 'episode',
						title: `${episode.series.title} S${episode.seasonNumber.toString().padStart(2, '0')}E${episode.episodeNumber.toString().padStart(2, '0')}`,
						searched: false,
						releasesFound: 0,
						grabbed: false,
						skipped: true,
						skipReason: monitoredResult.reason
					});
					continue;
				}

				// Skip episodes in read-only folders (imports would fail anyway)
				const readOnlyResult = await readOnlySpec.isSatisfied(context);
				if (!readOnlyResult.accepted) {
					results.push({
						itemId: episode.id,
						itemType: 'episode',
						title: `${episode.series.title} S${episode.seasonNumber.toString().padStart(2, '0')}E${episode.episodeNumber.toString().padStart(2, '0')}`,
						searched: false,
						releasesFound: 0,
						grabbed: false,
						skipped: true,
						skipReason: readOnlyResult.reason
					});
					continue;
				}

				// Check search cooldown (prevent hammering indexers), unless manually bypassed
				if (!ignoreCooldown) {
					const cooldownResult = await cooldownSpec.isSatisfied(context);
					if (!cooldownResult.accepted) {
						results.push({
							itemId: episode.id,
							itemType: 'episode',
							title: `${episode.series.title} S${episode.seasonNumber.toString().padStart(2, '0')}E${episode.episodeNumber.toString().padStart(2, '0')}`,
							searched: false,
							releasesFound: 0,
							grabbed: false,
							skipped: true,
							skipReason: cooldownResult.reason
						});
						continue;
					}
				}

				// Check missing
				const missingResult = await missingSpec.isSatisfied(context);
				if (!missingResult.accepted) {
					results.push({
						itemId: episode.id,
						itemType: 'episode',
						title: `${episode.series.title} S${episode.seasonNumber.toString().padStart(2, '0')}E${episode.episodeNumber.toString().padStart(2, '0')}`,
						searched: false,
						releasesFound: 0,
						grabbed: false,
						skipped: true,
						skipReason: missingResult.reason
					});
					continue;
				}

				// Group by series
				if (!episodesBySeriesAndSeason.has(episode.seriesId)) {
					episodesBySeriesAndSeason.set(episode.seriesId, new Map());
					seriesDataMap.set(episode.seriesId, episode.series);
				}

				// Group by season within series
				const seasonMap = episodesBySeriesAndSeason.get(episode.seriesId)!;
				if (!seasonMap.has(episode.seasonNumber)) {
					seasonMap.set(episode.seasonNumber, []);
				}
				seasonMap.get(episode.seasonNumber)!.push(episode);
			}

			// Preload all season episode counts in a single query to avoid N+1
			const allSeriesIds = Array.from(episodesBySeriesAndSeason.keys());
			await this.preloadSeasonEpisodeCounts(allSeriesIds);
			const useRuTrackerEpisodePointerPolicy =
				await this.shouldApplyRuTrackerEpisodePointerPolicy();

			// Process each series with cascading strategy
			for (const [currentSeriesId, seasonMap] of episodesBySeriesAndSeason) {
				// Check for cancellation before each series
				if (signal?.aborted) {
					logger.info('[MonitoringSearch] Missing episodes search cancelled between series');
					throw new TaskCancelledException('search');
				}

				const seriesData = seriesDataMap.get(currentSeriesId);
				if (!seriesData) continue;

				const seriesResults = await this.searchSeriesWithCascadingStrategy(
					seriesData,
					seasonMap,
					signal,
					useRuTrackerEpisodePointerPolicy
				);
				results.push(...seriesResults);
			}
		} catch (error) {
			logger.error({ err: error }, '[MonitoringSearch] Missing episodes search failed');
		} finally {
			// Clear the cache after search completes
			this.clearSeasonEpisodeCountCache();
		}

		return this.aggregateResults(results);
	}

	/**
	 * Search for a series using cascading strategy: season packs first, then individual episodes
	 * This prioritizes efficient downloads that get multiple episodes at once
	 * @param signal - Optional AbortSignal for cancellation support
	 */
	private async searchSeriesWithCascadingStrategy(
		seriesData: NonNullable<
			typeof series.$inferSelect & { scoringProfile?: typeof scoringProfiles.$inferSelect | null }
		>,
		seasonMap: Map<number, Array<typeof episodes.$inferSelect>>,
		signal?: AbortSignal,
		useRuTrackerEpisodePointerPolicy: boolean = false
	): Promise<ItemSearchResult[]> {
		const results: ItemSearchResult[] = [];
		const grabbedEpisodeIds = new Set<string>();

		logger.info(
			{
				seriesId: seriesData.id,
				title: seriesData.title,
				seasons: Array.from(seasonMap.keys()),
				totalMissingEpisodes: Array.from(seasonMap.values()).reduce(
					(sum, eps) => sum + eps.length,
					0
				)
			},
			'[MonitoringSearch] Processing series with cascading strategy'
		);

		// Get total episode counts for each season to calculate missing percentage
		const seasonEpisodeCounts = new Map<number, number>();
		for (const seasonNumber of seasonMap.keys()) {
			const count = await this.getSeasonEpisodeCount(seriesData.id, seasonNumber);
			seasonEpisodeCounts.set(seasonNumber, count);
		}

		// Strategy 1: Try season pack search for seasons with many missing episodes.
		// RuTracker-specific completeness restrictions are enforced later per release candidate.
		for (const [seasonNumber, missingEpisodes] of seasonMap) {
			// Check for cancellation before each season
			if (signal?.aborted) {
				throw new TaskCancelledException('search');
			}

			const totalEpisodes = seasonEpisodeCounts.get(seasonNumber) ?? missingEpisodes.length;
			const missingPercent = (missingEpisodes.length / totalEpisodes) * 100;
			const isEntireSeasonMissing = totalEpisodes > 0 && missingEpisodes.length >= totalEpisodes;

			// When RuTracker/Kinozal is the only automatic TV source, avoid season-pack
			// requests unless the full season is missing. Partial seasons should use
			// episode-pointer flow.
			if (useRuTrackerEpisodePointerPolicy && !isEntireSeasonMissing) {
				logger.debug(
					{
						seriesTitle: seriesData.title,
						season: seasonNumber,
						missingEpisodes: missingEpisodes.length,
						totalEpisodes,
						missingPercent: missingPercent.toFixed(1)
					},
					'[MonitoringSearch] Skipping season pack search - pointer policy (partial season)'
				);
				continue;
			}

			// Skip if less than 50% missing - not worth a pack
			if (missingPercent < 50) {
				logger.debug(
					{
						seriesTitle: seriesData.title,
						season: seasonNumber,
						missingEpisodes: missingEpisodes.length,
						totalEpisodes,
						missingPercent: missingPercent.toFixed(1)
					},
					'[MonitoringSearch] Skipping season pack search - not enough missing'
				);
				continue;
			}

			// Check if episodes are already downloading
			const episodeIds = missingEpisodes.map((e) => e.id);
			const alreadyDownloading = await this.areEpisodesAlreadyDownloading(episodeIds);
			if (alreadyDownloading) {
				logger.debug(
					{
						seriesTitle: seriesData.title,
						season: seasonNumber
					},
					'[MonitoringSearch] Some episodes already downloading, skipping season pack'
				);
				continue;
			}

			logger.info(
				{
					seriesTitle: seriesData.title,
					season: seasonNumber,
					missingEpisodes: missingEpisodes.length,
					totalEpisodes,
					missingPercent: missingPercent.toFixed(1)
				},
				'[MonitoringSearch] Trying season pack search'
			);

			// Try season pack search
			const packResult = await this.searchAndGrabSeasonPack(
				seriesData,
				seasonNumber,
				missingEpisodes
			);

			if (packResult.grabbed) {
				// Mark all episodes in this season as handled
				for (const ep of missingEpisodes) {
					grabbedEpisodeIds.add(ep.id);
				}
				results.push(packResult);

				logger.info(
					{
						seriesTitle: seriesData.title,
						season: seasonNumber,
						releaseName: packResult.grabbedRelease
					},
					'[MonitoringSearch] Season pack grabbed successfully'
				);
			} else {
				// Log that we'll try individual episodes instead
				logger.debug(
					{
						seriesTitle: seriesData.title,
						season: seasonNumber,
						releasesFound: packResult.releasesFound
					},
					'[MonitoringSearch] No suitable season pack found, will try individual episodes'
				);
			}

			// Rate limiting between season searches
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		// Strategy 2: Search for remaining individual episodes, oldest-searched first.
		// The per-series cap means a series with more missing episodes than the
		// cap can't be fully covered in one run; ordering by lastSearchTime (never
		// searched = treated as oldest) ensures each run advances through a different
		// slice of the backlog instead of always hitting the same cap on the same
		// low-numbered episodes and never reaching the rest.
		const pendingEpisodes: Array<{
			seasonNumber: number;
			episode: typeof episodes.$inferSelect;
		}> = [];
		for (const [seasonNumber, missingEpisodes] of seasonMap) {
			for (const episode of missingEpisodes) {
				if (grabbedEpisodeIds.has(episode.id)) continue;
				pendingEpisodes.push({ seasonNumber, episode });
			}
		}
		pendingEpisodes.sort((a, b) => {
			const aTime = a.episode.lastSearchTime ? new Date(a.episode.lastSearchTime).getTime() : 0;
			const bTime = b.episode.lastSearchTime ? new Date(b.episode.lastSearchTime).getTime() : 0;
			return aTime - bTime;
		});

		let individualSearchCount = 0;
		for (const { seasonNumber, episode } of pendingEpisodes) {
			// Check for cancellation before each episode
			if (signal?.aborted) {
				throw new TaskCancelledException('search');
			}

			// Skip if already grabbed via a pack (strategy 1, or a sibling episode
			// grabbing a pack earlier in this same loop)
			if (grabbedEpisodeIds.has(episode.id)) {
				continue;
			}

			if (individualSearchCount >= this.MAX_INDIVIDUAL_EPISODE_SEARCHES_PER_SERIES) {
				logger.warn(
					{
						seriesTitle: seriesData.title,
						season: seasonNumber,
						limit: this.MAX_INDIVIDUAL_EPISODE_SEARCHES_PER_SERIES
					},
					'[MonitoringSearch] Hit per-series individual episode search cap, remaining episodes will be picked up on a later search'
				);
				results.push({
					itemId: episode.id,
					itemType: 'episode',
					title: `${seriesData.title} S${seasonNumber.toString().padStart(2, '0')}E${episode.episodeNumber.toString().padStart(2, '0')}`,
					searched: false,
					releasesFound: 0,
					grabbed: false,
					skipped: true,
					skipReason: 'Per-series individual episode search cap reached for this run'
				});
				continue;
			}
			individualSearchCount++;

			// Update lastSearchTime before searching
			await db
				.update(episodes)
				.set({ lastSearchTime: new Date().toISOString() })
				.where(eq(episodes.id, episode.id));

			// Search and grab individual episode
			// Note: searchAndGrabEpisode now includes packs in results due to filterBySeasonEpisode change
			// Pack bonus scoring will naturally prioritize packs if they're of similar quality
			const searchResult = await this.searchAndGrabEpisode(seriesData, episode);

			// If we grabbed a pack, mark all episodes in that season as handled.
			// Episode pointers intentionally look like packs in title shape, but only grab one episode.
			if (searchResult.grabbed) {
				grabbedEpisodeIds.add(episode.id);
			}
			if (searchResult.grabbed && searchResult.grabbedRelease) {
				const isEpisodePointer = Boolean(parseEpisodePointerFromTitle(searchResult.grabbedRelease));
				const parsed = parser.parse(searchResult.grabbedRelease);
				if (!isEpisodePointer && parsed.episode?.isSeasonPack) {
					// Mark all episodes in this season as handled
					for (const ep of seasonMap.get(seasonNumber) ?? []) {
						grabbedEpisodeIds.add(ep.id);
					}
					logger.info(
						{
							seriesTitle: seriesData.title,
							season: seasonNumber,
							releaseName: searchResult.grabbedRelease
						},
						'[MonitoringSearch] Season pack grabbed via episode search'
					);
				}
			}

			results.push(searchResult);

			// Rate limiting
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		return results;
	}

	/**
	 * Search for and grab a season pack for a specific season
	 */
	private async searchAndGrabSeasonPack(
		seriesData: typeof series.$inferSelect & {
			scoringProfile?: typeof scoringProfiles.$inferSelect | null;
		},
		seasonNumber: number,
		missingEpisodes: Array<typeof episodes.$inferSelect>
	): Promise<ItemSearchResult> {
		const title = `${seriesData.title} Season ${seasonNumber}`;
		const episodeIds = missingEpisodes.map((e) => e.id);

		try {
			const [indexerManager, globalIncludeAdult] = await Promise.all([
				getIndexerManager(),
				this.getGlobalIncludeAdult()
			]);

			// Get episode count for the target season (for season pack size validation)
			const seasonEpisodeCount = await this.getSeasonEpisodeCount(seriesData.id, seasonNumber);

			// Get all search titles (primary + original + alternates)
			const searchTitles = await getSeriesSearchTitles(seriesData.id);

			// Build search criteria - season only (no episode number) to get packs
			const criteria: SearchCriteria = {
				searchType: 'tv',
				query: seriesData.title,
				tmdbId: seriesData.tmdbId,
				tvdbId: seriesData.tvdbId ?? undefined,
				imdbId: seriesData.imdbId ?? undefined,
				season: seasonNumber,
				searchTitles,
				isAnime: seriesData.seriesType === 'anime' ? true : undefined,
				isAdult: globalIncludeAdult && (seriesData.adult ?? false) ? true : undefined
				// Note: No episode number - this will return season packs
			};

			// Perform enriched search (automatic - background monitoring)
			const searchResult = await indexerManager.searchEnhanced(criteria, {
				searchSource: 'automatic',
				enrichment: {
					scoringProfileId: seriesData.scoringProfileId ?? undefined,
					filterRejected: true,
					minScore: AUTO_GRAB_MIN_SCORE,
					seasonEpisodeCount
				}
			});

			if (searchResult.releases.length === 0) {
				return {
					itemId: episodeIds[0], // Use first episode as representative
					itemType: 'episode',
					title,
					searched: true,
					releasesFound: 0,
					grabbed: false
				};
			}

			// Filter to only season packs (the enricher should already prioritize these via pack bonus)
			const seasonPacks = searchResult.releases.filter((release) => {
				const isSeasonPack =
					release.parsed.episode?.isSeasonPack ?? release.episodeMatch?.isSeasonPack ?? false;
				const packSeasons = release.parsed.episode?.seasons ??
					release.episodeMatch?.seasons ?? [
						release.parsed.episode?.season ?? release.episodeMatch?.season
					];
				return isSeasonPack && packSeasons?.includes(seasonNumber);
			});

			if (seasonPacks.length === 0) {
				return {
					itemId: episodeIds[0],
					itemType: 'episode',
					title,
					searched: true,
					releasesFound: searchResult.releases.length,
					grabbed: false
				};
			}

			// Find best non-blocklisted season pack
			const blocklistSpec = new ReleaseBlocklistSpecification({ seriesId: seriesData.id });
			let grabResult: {
				success: boolean;
				releaseName?: string;
				queueItemId?: string;
				addedToQueue?: boolean;
				error?: string;
				rejectionType?: string;
			} | null = null;

			// Load scoring profile for explicit validation
			let profile: ScoringProfile | undefined;
			if (seriesData.scoringProfileId) {
				profile = (await qualityFilter.getProfile(seriesData.scoringProfileId)) ?? undefined;
			}
			if (!profile) {
				profile = await qualityFilter.getDefaultScoringProfile();
			}

			const isEntireSeasonMissing =
				seasonEpisodeCount > 0 && missingEpisodes.length >= seasonEpisodeCount;

			for (const release of seasonPacks) {
				if (isRuTrackerIndexerName(release.indexerName) && !isEntireSeasonMissing) {
					logger.debug(
						{
							seriesId: seriesData.id,
							season: seasonNumber,
							title: release.title,
							missingEpisodes: missingEpisodes.length,
							seasonEpisodeCount
						},
						'[MonitoringSearch] Skipping pointer-indexer season pack for partial-missing season'
					);
					continue;
				}

				const releaseCandidate: ReleaseCandidate = {
					title: release.title,
					score: release.totalScore ?? 0,
					size: release.size,
					infoHash: release.infoHash,
					indexerId: release.indexerId
				};

				// Check blocklist
				const blocklistResult = await blocklistSpec.isSatisfied(releaseCandidate);
				if (!blocklistResult.accepted) {
					logger.debug(
						{
							title: release.title,
							reason: blocklistResult.reason
						},
						'[MonitoringSearch] Season pack blocklisted, trying next'
					);
					continue;
				}

				// Found a valid, non-blocklisted season pack — grab it
				grabResult = await this.grabRelease(release, {
					mediaType: 'tv',
					seriesId: seriesData.id,
					episodeIds,
					seasonNumber,
					isAutomatic: true
				});

				if (grabResult.success) {
					break; // Successfully grabbed
				}
			}

			return {
				itemId: episodeIds[0],
				itemType: 'episode',
				title,
				searched: true,
				releasesFound: seasonPacks.length,
				grabbed: grabResult?.success ?? false,
				grabbedRelease: grabResult?.releaseName,
				queueItemId: grabResult?.queueItemId,
				error: grabResult?.error,
				rejectionType: grabResult?.rejectionType
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return {
				itemId: episodeIds[0],
				itemType: 'episode',
				title,
				searched: true,
				releasesFound: 0,
				grabbed: false,
				error: message
			};
		}
	}

	/**
	 * Search for upgrades (movies/episodes with files below cutoff or all items)
	 * @param options.cutoffUnmetOnly - If true, only search items below cutoff. If false, search all items.
	 * @param options.signal - Optional AbortSignal for cancellation support
	 * @param options.dryRun - If true, don't grab - just log what would happen
	 */
	async searchForUpgrades(options: UpgradeSearchOptions = {}): Promise<SearchResults> {
		const cutoffUnmetOnly = options.cutoffUnmetOnly ?? true; // Default to legacy behavior
		const signal = options.signal;
		const dryRun = options.dryRun ?? false;
		const ignoreCooldown = options.ignoreCooldown ?? false;
		const cooldownHours = options.cooldownHours;
		logger.info(
			{
				...options,
				cutoffUnmetOnly,
				dryRun,
				ignoreCooldown,
				cooldownHours
			},
			'[MonitoringSearch] Starting upgrade search'
		);

		const results: ItemSearchResult[] = [];
		const upgradeDetails: UpgradeDecisionDetail[] = [];
		const maxItems = options.maxItems;

		try {
			// Check for cancellation
			if (signal?.aborted) {
				logger.info('[MonitoringSearch] Upgrade search cancelled');
				throw new TaskCancelledException('search');
			}

			// Search for movie upgrades
			if (!options.seriesIds) {
				const { items: movieItems, details: movieDetails } = await this.searchMovieUpgrades(
					options.movieIds,
					maxItems,
					cutoffUnmetOnly,
					signal,
					dryRun,
					ignoreCooldown,
					cooldownHours
				);
				results.push(...movieItems);
				if (movieDetails) {
					upgradeDetails.push(...movieDetails);
				}
			}

			// Check for cancellation between movie and episode search
			if (signal?.aborted) {
				logger.info('[MonitoringSearch] Upgrade search cancelled after movies');
				throw new TaskCancelledException('search');
			}

			// Search for episode upgrades
			if (!options.movieIds) {
				const { items: episodeItems, details: episodeDetails } = await this.searchEpisodeUpgrades(
					options.seriesIds,
					maxItems,
					cutoffUnmetOnly,
					signal,
					dryRun,
					ignoreCooldown,
					cooldownHours
				);
				results.push(...episodeItems);
				if (episodeDetails) {
					upgradeDetails.push(...episodeDetails);
				}
			}
		} catch (error) {
			if (TaskCancelledException.isTaskCancelled(error)) {
				throw error;
			}
			logger.error({ err: error }, '[MonitoringSearch] Upgrade search failed');
		}

		const aggregated = this.aggregateResults(results);
		if (dryRun && upgradeDetails.length > 0) {
			aggregated.upgradeDetails = upgradeDetails;
		}
		return aggregated;
	}

	/**
	 * Resolve the scoring profile to use for a media item's upgrade/cutoff
	 * evaluation. Explicit profiles are loaded via the quality filter; when no
	 * profile is assigned (or the assigned one no longer exists) the default
	 * profile is used. Without this, contexts for items with a NULL
	 * scoringProfileId would carry no profile and every release would be
	 * rejected with NO_PROFILE (issue #492).
	 */
	private async resolveScoringProfileForContext(
		profileId: string | null,
		relation: typeof scoringProfiles.$inferSelect | null | undefined
	): Promise<typeof scoringProfiles.$inferSelect | undefined> {
		if (relation) return relation;
		if (profileId) {
			const profile = await qualityFilter.getProfile(profileId);
			if (profile) return profile as unknown as typeof scoringProfiles.$inferSelect;
		}
		return (await qualityFilter.getDefaultScoringProfile()) as unknown as typeof scoringProfiles.$inferSelect;
	}

	/**
	 * Search for movie upgrades
	 * @param cutoffUnmetOnly - If true, only search items below cutoff. If false, search all items with files.
	 * @param signal - Optional AbortSignal for cancellation support
	 * @param dryRun - If true, don't grab - just log what would happen
	 */
	private async searchMovieUpgrades(
		movieIds?: string[],
		maxItems?: number,
		cutoffUnmetOnly: boolean = true,
		signal?: AbortSignal,
		dryRun: boolean = false,
		ignoreCooldown: boolean = false,
		cooldownHours?: number
	): Promise<{ items: ItemSearchResult[]; details?: UpgradeDecisionDetail[] }> {
		const results: ItemSearchResult[] = [];
		const details: UpgradeDecisionDetail[] = [];

		try {
			// Check for cancellation
			if (signal?.aborted) {
				throw new TaskCancelledException('search');
			}

			// Query monitored movies WITH files
			const query =
				movieIds && movieIds.length > 0
					? and(eq(movies.monitored, true), eq(movies.hasFile, true))
					: and(eq(movies.monitored, true), eq(movies.hasFile, true));

			const moviesWithFiles = await db.query.movies.findMany({
				where: query,
				with: {
					scoringProfile: true
				},
				...(maxItems && { limit: maxItems })
			});

			logger.info(
				{
					count: moviesWithFiles.length,
					cutoffUnmetOnly,
					dryRun,
					ignoreCooldown,
					cooldownHours
				},
				'[MonitoringSearch] Found movies with files for upgrade check'
			);

			// Get existing files
			const cutoffSpec = new MovieCutoffUnmetSpecification();
			const monitoredSpec = new MovieMonitoredSpecification();
			const readOnlySpec = new MovieReadOnlyFolderSpecification();
			const cooldownSpec = new MovieSearchCooldownSpecification(cooldownHours);

			for (const movie of moviesWithFiles) {
				// Check for cancellation before each movie
				if (signal?.aborted) {
					throw new TaskCancelledException('search');
				}

				// Get existing files and pick the best one
				const existingFiles = await db.query.movieFiles.findMany({
					where: eq(movieFiles.movieId, movie.id)
				});

				if (existingFiles.length === 0) continue;

				// Multi-quality movies: evaluate each filled bucket for within-tier
				// upgrades instead of a single best-file baseline. The dry-run preview
				// still uses the best-file path below for simplicity.
				if (!dryRun) {
					const multiCtx = await resolveMovieMultiQuality(
						movie.desiredQualities,
						movie.scoringProfileId
					);
					if (multiCtx.multiQuality) {
						const bucketResults = await this.searchMovieQualityBucketUpgrades(
							movie,
							existingFiles,
							multiCtx.effective,
							{ signal, ignoreCooldown, cooldownHours }
						);
						results.push(...bucketResults);
						continue;
					}
				}

				const existingFile = this.selectBestExistingFile(existingFiles);

				const context: MovieContext = {
					movie,
					existingFile,
					profile: await this.resolveScoringProfileForContext(
						movie.scoringProfileId,
						movie.scoringProfile
					)
				};

				// Check monitored
				const monitoredResult = await monitoredSpec.isSatisfied(context);
				if (!monitoredResult.accepted) {
					results.push({
						itemId: movie.id,
						itemType: 'movie',
						title: movie.title,
						searched: false,
						releasesFound: 0,
						grabbed: false,
						skipped: true,
						skipReason: monitoredResult.reason
					});
					continue;
				}

				// Skip movies in read-only folders (imports would fail anyway)
				const readOnlyResult = await readOnlySpec.isSatisfied(context);
				if (!readOnlyResult.accepted) {
					results.push({
						itemId: movie.id,
						itemType: 'movie',
						title: movie.title,
						searched: false,
						releasesFound: 0,
						grabbed: false,
						skipped: true,
						skipReason: readOnlyResult.reason
					});
					continue;
				}

				// Check search cooldown (prevent hammering indexers) - skip in dry-run mode
				if (!dryRun && !ignoreCooldown) {
					const cooldownResult = await cooldownSpec.isSatisfied(context);
					if (!cooldownResult.accepted) {
						results.push({
							itemId: movie.id,
							itemType: 'movie',
							title: movie.title,
							searched: false,
							releasesFound: 0,
							grabbed: false,
							skipped: true,
							skipReason: cooldownResult.reason
						});
						continue;
					}
				}

				// Check if cutoff is unmet (only when cutoffUnmetOnly is true).
				// A language shortfall keeps the movie upgrade-searchable even
				// with quality cutoff met: the audio preference (phase B
				// ranking) can still find a better-language release.
				if (cutoffUnmetOnly && !movie.languageShortfall) {
					const cutoffResult = await cutoffSpec.isSatisfied(context);
					if (!cutoffResult.accepted) {
						results.push({
							itemId: movie.id,
							itemType: 'movie',
							title: movie.title,
							searched: false,
							releasesFound: 0,
							grabbed: false,
							skipped: true,
							skipReason: cutoffResult.reason
						});
						continue;
					}
				}

				// Update lastSearchTime before searching (skip in dry-run mode)
				if (!dryRun) {
					await db
						.update(movies)
						.set({ lastSearchTime: new Date().toISOString() })
						.where(eq(movies.id, movie.id));
				}

				// Search for better releases
				const { result: searchResult, detail } = await this.searchAndUpgradeMovie(
					movie,
					existingFile,
					dryRun
				);
				results.push(searchResult);
				if (detail) {
					details.push(detail);
				}

				// Rate limiting
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		} catch (error) {
			logger.error({ err: error }, '[MonitoringSearch] Movie upgrade search failed');
		}

		return { items: results, details: dryRun ? details : undefined };
	}

	/**
	 * Search for episode upgrades
	 * @param cutoffUnmetOnly - If true, only search items below cutoff. If false, search all items with files.
	 * @param signal - Optional AbortSignal for cancellation support
	 * @param dryRun - If true, don't grab - just log what would happen
	 */
	private async searchEpisodeUpgrades(
		seriesIds?: string[],
		maxItems?: number,
		cutoffUnmetOnly: boolean = true,
		signal?: AbortSignal,
		dryRun: boolean = false,
		ignoreCooldown: boolean = false,
		cooldownHours?: number
	): Promise<{ items: ItemSearchResult[]; details?: UpgradeDecisionDetail[] }> {
		const results: ItemSearchResult[] = [];
		const details: UpgradeDecisionDetail[] = [];

		try {
			// Check for cancellation
			if (signal?.aborted) {
				throw new TaskCancelledException('search');
			}

			// Query monitored episodes WITH files
			const query =
				seriesIds && seriesIds.length > 0
					? and(
							eq(episodes.monitored, true),
							eq(episodes.hasFile, true),
							inArray(episodes.seriesId, seriesIds)
						)
					: and(eq(episodes.monitored, true), eq(episodes.hasFile, true));

			const episodesWithFiles = await db.query.episodes.findMany({
				where: query,
				with: {
					series: {
						with: {
							scoringProfile: true
						}
					},
					season: true
				},
				...(maxItems && { limit: maxItems })
			});

			logger.info(
				{
					count: episodesWithFiles.length,
					cutoffUnmetOnly,
					dryRun,
					ignoreCooldown,
					cooldownHours
				},
				'[MonitoringSearch] Found episodes with files for upgrade check'
			);

			// Preload season episode counts to avoid N+1 queries
			const uniqueSeriesIds = [...new Set(episodesWithFiles.map((e) => e.seriesId))];
			await this.preloadSeasonEpisodeCounts(uniqueSeriesIds);

			const cutoffSpec = new EpisodeCutoffUnmetSpecification();
			const monitoredSpec = new EpisodeMonitoredSpecification();
			const readOnlySpec = new EpisodeReadOnlyFolderSpecification();
			const cooldownSpec = new EpisodeSearchCooldownSpecification(cooldownHours);

			for (const episode of episodesWithFiles) {
				// Check for cancellation before each episode
				if (signal?.aborted) {
					throw new TaskCancelledException('search');
				}

				if (!episode.series) continue;

				// Get existing files for this specific episode and pick the best one
				const allSeriesFiles = await db.query.episodeFiles.findMany({
					where: eq(episodeFiles.seriesId, episode.seriesId)
				});
				const existingFiles = allSeriesFiles.filter((f) => f.episodeIds?.includes(episode.id));

				if (existingFiles.length === 0) continue;

				const existingFile = this.selectBestExistingFile(existingFiles);

				const context: EpisodeContext = {
					series: episode.series,
					episode,
					existingFile,
					profile: await this.resolveScoringProfileForContext(
						episode.series.scoringProfileId,
						episode.series.scoringProfile
					)
				};

				// Check monitored
				const monitoredResult = await monitoredSpec.isSatisfied(context);
				if (!monitoredResult.accepted) {
					continue; // Skip silently
				}

				// Skip episodes in read-only folders (imports would fail anyway)
				const readOnlyResult = await readOnlySpec.isSatisfied(context);
				if (!readOnlyResult.accepted) {
					continue; // Skip silently - can't upgrade in read-only folder
				}

				// Check search cooldown (prevent hammering indexers) - skip in dry-run mode
				if (!dryRun && !ignoreCooldown) {
					const cooldownResult = await cooldownSpec.isSatisfied(context);
					if (!cooldownResult.accepted) {
						continue; // Skip silently - recently searched
					}
				}

				// Check if cutoff is unmet (only when cutoffUnmetOnly is true)
				if (cutoffUnmetOnly) {
					const cutoffResult = await cutoffSpec.isSatisfied(context);
					if (!cutoffResult.accepted) {
						continue; // Skip silently - already at cutoff
					}
				}

				// Update lastSearchTime before searching (skip in dry-run mode)
				if (!dryRun) {
					await db
						.update(episodes)
						.set({ lastSearchTime: new Date().toISOString() })
						.where(eq(episodes.id, episode.id));
				}

				// Search for better releases
				const { result: searchResult, detail } = await this.searchAndUpgradeEpisode(
					episode.series,
					episode,
					existingFile,
					dryRun
				);
				results.push(searchResult);
				if (detail) {
					details.push(detail);
				}

				// Rate limiting
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		} catch (error) {
			logger.error({ err: error }, '[MonitoringSearch] Episode upgrade search failed');
		} finally {
			// Clear the cache after search completes
			this.clearSeasonEpisodeCountCache();
		}

		return { items: results, details: dryRun ? details : undefined };
	}

	/**
	 * Search and grab an upgrade for a movie
	 * @param dryRun - If true, don't grab - just log and return what would happen
	 */
	private async searchAndUpgradeMovie(
		movie: typeof movies.$inferSelect & {
			scoringProfile?: typeof scoringProfiles.$inferSelect | null;
		},
		existingFile: typeof movieFiles.$inferSelect,
		dryRun: boolean = false
	): Promise<{ result: ItemSearchResult; detail?: UpgradeDecisionDetail }> {
		// Get existing file name for scoring
		const existingFileName = existingFile.sceneName || existingFile.relativePath;

		// Load scoring profile for scoring
		let profile: ScoringProfile | undefined;
		if (movie.scoringProfileId) {
			profile = (await qualityFilter.getProfile(movie.scoringProfileId)) ?? undefined;
		}
		if (!profile) {
			profile = await qualityFilter.getDefaultScoringProfile();
		}

		// Score the existing file upfront for dry-run reporting
		let existingScore = 0;
		let existingBreakdown: Record<string, number> = {};
		if (profile) {
			const existingScoreResult = scoreRelease(existingFileName, profile, undefined, undefined, {
				mediaType: 'movie'
			});
			existingScore = existingScoreResult.totalScore;
			existingBreakdown = Object.fromEntries(
				Object.entries(existingScoreResult.breakdown).map(([k, v]) => [k, v.score])
			);
		}

		try {
			const [indexerManager, globalIncludeAdult] = await Promise.all([
				getIndexerManager(),
				this.getGlobalIncludeAdult()
			]);

			// Get all search titles (primary + original + alternates)
			const searchTitles = await getMovieSearchTitles(movie.id);

			// Build search criteria
			const criteria: SearchCriteria = {
				searchType: 'movie',
				query: movie.title,
				tmdbId: movie.tmdbId,
				imdbId: movie.imdbId ?? undefined,
				year: movie.year ?? undefined,
				searchTitles,
				isAdult: globalIncludeAdult && (movie.adult ?? false) ? true : undefined
			};

			// Perform enriched search (automatic - background monitoring)
			const searchResult = await indexerManager.searchEnhanced(criteria, {
				searchSource: 'automatic',
				enrichment: {
					scoringProfileId: movie.scoringProfileId ?? undefined,
					filterRejected: true,
					minScore: AUTO_GRAB_MIN_SCORE
				}
			});

			if (searchResult.releases.length === 0) {
				const result: ItemSearchResult = {
					itemId: movie.id,
					itemType: 'movie',
					title: movie.title,
					searched: true,
					releasesFound: 0,
					grabbed: false
				};
				const detail: UpgradeDecisionDetail | undefined = dryRun
					? {
							itemId: movie.id,
							itemType: 'movie',
							title: movie.title,
							existingFile: {
								name: existingFileName,
								score: existingScore,
								breakdown: existingBreakdown
							},
							bestCandidate: null,
							candidatesChecked: 0,
							wouldGrab: false,
							reason: 'No releases found'
						}
					: undefined;
				return { result, detail };
			}

			// Check each release to see if it's an upgrade
			const upgradeSpec = new MovieUpgradeableSpecification();
			const blocklistSpec = new ReleaseBlocklistSpecification({ movieId: movie.id });
			const context: MovieContext = {
				movie,
				existingFile,
				profile: (profile ?? movie.scoringProfile ?? undefined) as MovieContext['profile']
			};

			// Track best candidate for dry-run reporting
			let bestCandidate: {
				name: string;
				score: number;
				improvement: number;
				breakdown?: Record<string, number>;
			} | null = null;
			let candidatesChecked = 0;
			let wouldGrabReason = 'No candidates passed checks';

			for (const release of searchResult.releases) {
				candidatesChecked++;

				const releaseCandidate: ReleaseCandidate = {
					title: release.title,
					score: release.totalScore ?? 0,
					size: release.size,
					quality: {
						resolution: release.parsed.resolution,
						source: release.parsed.source,
						codec: release.parsed.codec,
						hdr: release.parsed.hdr ?? undefined
					},
					infoHash: release.infoHash,
					indexerId: release.indexerId,
					protocol: release.protocol
				};

				// Check blocklist first
				const blocklistResult = await blocklistSpec.isSatisfied(releaseCandidate);
				if (!blocklistResult.accepted) {
					if (dryRun) {
						logger.info(
							{
								movie: movie.title,
								release: release.title,
								reason: blocklistResult.reason
							},
							'[DryRun] Release blocklisted'
						);
					} else {
						logger.debug(
							{
								title: release.title,
								reason: blocklistResult.reason
							},
							'[MonitoringSearch] Release blocklisted'
						);
					}
					continue;
				}

				// Reject TV episodes when searching for movies
				// This prevents mismatches like "Doom.Patrol.S03E06.1917.Patrol" being grabbed for movie "1917"
				const episodeInfo = release.parsed.episode;
				if (episodeInfo && (episodeInfo.season !== undefined || episodeInfo.episodes?.length)) {
					if (dryRun) {
						logger.info(
							{
								movie: movie.title,
								release: release.title,
								season: episodeInfo.season,
								episodes: episodeInfo.episodes
							},
							'[DryRun] Release rejected - TV episode, not a movie'
						);
					} else {
						logger.debug(
							{
								movieId: movie.id,
								title: release.title,
								season: episodeInfo.season,
								episodes: episodeInfo.episodes
							},
							'[MonitoringSearch] Release rejected - TV episode, not a movie'
						);
					}
					continue;
				}

				// Get comparison details for dry-run
				if (dryRun && profile) {
					const comparison = isUpgrade(existingFileName, release.title, profile, {
						minimumImprovement: movie.scoringProfile?.minScoreIncrement || 0,
						allowSidegrade: false,
						candidateSizeBytes: release.size
					});

					const candidateBreakdown = Object.fromEntries(
						Object.entries(comparison.candidate.breakdown).map(([k, v]) => [k, v.score])
					);

					logger.info(
						{
							movie: movie.title,
							existingFile: existingFileName,
							existingScore: comparison.existing.totalScore,
							candidate: release.title,
							candidateScore: comparison.candidate.totalScore,
							improvement: comparison.improvement,
							minRequired: movie.scoringProfile?.minScoreIncrement || 0,
							isUpgrade: comparison.isUpgrade,
							verdict: comparison.isUpgrade ? 'WOULD GRAB' : 'REJECTED'
						},
						'[DryRun] Upgrade comparison'
					);

					// Track best candidate (even if not accepted)
					if (!bestCandidate || comparison.candidate.totalScore > bestCandidate.score) {
						bestCandidate = {
							name: release.title,
							score: comparison.candidate.totalScore,
							improvement: comparison.improvement,
							breakdown: candidateBreakdown
						};
						if (comparison.isUpgrade) {
							wouldGrabReason = 'Upgrade accepted';
						} else if (comparison.improvement <= 0) {
							wouldGrabReason = `Score not better (improvement: ${comparison.improvement})`;
						} else {
							wouldGrabReason = `Improvement ${comparison.improvement} below minimum ${movie.scoringProfile?.minScoreIncrement || 0}`;
						}
					}
				}

				const upgradeResult = await upgradeSpec.isSatisfied(context, releaseCandidate);
				if (upgradeResult.accepted) {
					if (dryRun) {
						// In dry-run mode, don't actually grab - just report what would happen
						logger.info(
							{
								movie: movie.title,
								release: release.title,
								existingFile: existingFileName,
								existingScore,
								candidateScore: release.totalScore ?? 0
							},
							'[DryRun] Would grab upgrade'
						);

						const result: ItemSearchResult = {
							itemId: movie.id,
							itemType: 'movie',
							title: movie.title,
							searched: true,
							releasesFound: searchResult.releases.length,
							grabbed: false, // Didn't actually grab
							grabbedRelease: release.title // What would have been grabbed
						};
						const detail: UpgradeDecisionDetail = {
							itemId: movie.id,
							itemType: 'movie',
							title: movie.title,
							existingFile: {
								name: existingFileName,
								score: existingScore,
								breakdown: existingBreakdown
							},
							bestCandidate: bestCandidate ?? {
								name: release.title,
								score: release.totalScore ?? 0,
								improvement: (release.totalScore ?? 0) - existingScore
							},
							candidatesChecked,
							wouldGrab: true,
							reason: 'Upgrade accepted - would grab'
						};
						return { result, detail };
					}

					// This is an upgrade! Grab it
					const grabResult = await this.grabRelease(release, {
						mediaType: 'movie',
						movieId: movie.id,
						isAutomatic: true,
						isUpgrade: true
					});

					return {
						result: {
							itemId: movie.id,
							itemType: 'movie',
							title: movie.title,
							searched: true,
							releasesFound: searchResult.releases.length,
							grabbed: grabResult.success,
							grabbedRelease: grabResult.releaseName,
							queueItemId: grabResult.queueItemId,
							error: grabResult.error,
							rejectionType: grabResult.rejectionType
						}
					};
				}
			}

			// No upgrades found
			const result: ItemSearchResult = {
				itemId: movie.id,
				itemType: 'movie',
				title: movie.title,
				searched: true,
				releasesFound: searchResult.releases.length,
				grabbed: false
			};
			const detail: UpgradeDecisionDetail | undefined = dryRun
				? {
						itemId: movie.id,
						itemType: 'movie',
						title: movie.title,
						existingFile: {
							name: existingFileName,
							score: existingScore,
							breakdown: existingBreakdown
						},
						bestCandidate,
						candidatesChecked,
						wouldGrab: false,
						reason: wouldGrabReason
					}
				: undefined;
			return { result, detail };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			const result: ItemSearchResult = {
				itemId: movie.id,
				itemType: 'movie',
				title: movie.title,
				searched: true,
				releasesFound: 0,
				grabbed: false,
				error: message
			};
			const detail: UpgradeDecisionDetail | undefined = dryRun
				? {
						itemId: movie.id,
						itemType: 'movie',
						title: movie.title,
						existingFile: {
							name: existingFileName,
							score: existingScore,
							breakdown: existingBreakdown
						},
						bestCandidate: null,
						candidatesChecked: 0,
						wouldGrab: false,
						reason: `Error: ${message}`
					}
				: undefined;
			return { result, detail };
		}
	}

	/**
	 * Search and grab an upgrade for an episode
	 * @param dryRun - If true, don't grab - just log and return what would happen
	 */
	private async searchAndUpgradeEpisode(
		seriesData: typeof series.$inferSelect & {
			scoringProfile?: typeof scoringProfiles.$inferSelect | null;
		},
		episode: typeof episodes.$inferSelect,
		existingFile: typeof episodeFiles.$inferSelect,
		dryRun: boolean = false
	): Promise<{ result: ItemSearchResult; detail?: UpgradeDecisionDetail }> {
		const title = `${seriesData.title} S${episode.seasonNumber.toString().padStart(2, '0')}E${episode.episodeNumber.toString().padStart(2, '0')}`;

		// Get existing file name for scoring
		const existingFileName = existingFile.sceneName || existingFile.relativePath;

		// Load scoring profile for scoring
		let profile: ScoringProfile | undefined;
		if (seriesData.scoringProfileId) {
			profile = (await qualityFilter.getProfile(seriesData.scoringProfileId)) ?? undefined;
		}
		if (!profile) {
			profile = await qualityFilter.getDefaultScoringProfile();
		}

		// Score the existing file upfront for dry-run reporting
		let existingScore = 0;
		let existingBreakdown: Record<string, number> = {};
		if (profile) {
			const existingScoreResult = scoreRelease(existingFileName, profile, undefined, undefined, {
				mediaType: 'tv'
			});
			existingScore = existingScoreResult.totalScore;
			existingBreakdown = Object.fromEntries(
				Object.entries(existingScoreResult.breakdown).map(([k, v]) => [k, v.score])
			);
		}

		try {
			const [indexerManager, globalIncludeAdult] = await Promise.all([
				getIndexerManager(),
				this.getGlobalIncludeAdult()
			]);

			// Get episode count for the target season (for season pack size validation)
			const seasonEpisodeCount = await this.getSeasonEpisodeCount(
				seriesData.id,
				episode.seasonNumber
			);

			// Get all search titles (primary + original + alternates)
			const searchTitles = await getSeriesSearchTitles(seriesData.id);

			// Build search criteria
			const criteria: SearchCriteria = {
				searchType: 'tv',
				query: seriesData.title,
				tmdbId: seriesData.tmdbId,
				tvdbId: seriesData.tvdbId ?? undefined,
				imdbId: seriesData.imdbId ?? undefined,
				season: episode.seasonNumber,
				episode: episode.episodeNumber,
				searchTitles,
				isAnime: seriesData.seriesType === 'anime' ? true : undefined,
				isAdult: globalIncludeAdult && (seriesData.adult ?? false) ? true : undefined
			};

			// Perform enriched search (automatic - background monitoring)
			// Pass seasonEpisodeCount for proper season pack size validation during enrichment
			const searchResult = await indexerManager.searchEnhanced(criteria, {
				searchSource: 'automatic',
				enrichment: {
					scoringProfileId: seriesData.scoringProfileId ?? undefined,
					filterRejected: true,
					minScore: AUTO_GRAB_MIN_SCORE,
					seasonEpisodeCount
				}
			});

			if (searchResult.releases.length === 0) {
				const result: ItemSearchResult = {
					itemId: episode.id,
					itemType: 'episode',
					title,
					searched: true,
					releasesFound: 0,
					grabbed: false
				};
				const detail: UpgradeDecisionDetail | undefined = dryRun
					? {
							itemId: episode.id,
							itemType: 'episode',
							title,
							existingFile: {
								name: existingFileName,
								score: existingScore,
								breakdown: existingBreakdown
							},
							bestCandidate: null,
							candidatesChecked: 0,
							wouldGrab: false,
							reason: 'No releases found'
						}
					: undefined;
				return { result, detail };
			}

			// Check each release to see if it's an upgrade
			const upgradeSpec = new EpisodeUpgradeableSpecification();
			const blocklistSpec = new ReleaseBlocklistSpecification({ seriesId: seriesData.id });
			const context: EpisodeContext = {
				series: seriesData,
				episode,
				existingFile,
				profile: (profile ?? seriesData.scoringProfile ?? undefined) as EpisodeContext['profile']
			};

			// Track best candidate for dry-run reporting
			let bestCandidate: {
				name: string;
				score: number;
				improvement: number;
				breakdown?: Record<string, number>;
			} | null = null;
			let candidatesChecked = 0;
			let wouldGrabReason = 'No candidates passed checks';

			for (const release of searchResult.releases) {
				candidatesChecked++;

				const releaseCandidate: ReleaseCandidate = {
					title: release.title,
					score: release.totalScore ?? 0,
					size: release.size,
					quality: {
						resolution: release.parsed.resolution,
						source: release.parsed.source,
						codec: release.parsed.codec,
						hdr: release.parsed.hdr ?? undefined
					},
					infoHash: release.infoHash,
					indexerId: release.indexerId,
					protocol: release.protocol
				};

				// Check blocklist first
				const blocklistResult = await blocklistSpec.isSatisfied(releaseCandidate);
				if (!blocklistResult.accepted) {
					if (dryRun) {
						logger.info(
							{
								episode: title,
								release: release.title,
								reason: blocklistResult.reason
							},
							'[DryRun] Release blocklisted'
						);
					} else {
						logger.debug(
							{
								title: release.title,
								reason: blocklistResult.reason
							},
							'[MonitoringSearch] Release blocklisted'
						);
					}
					continue;
				}

				// Get comparison details for dry-run
				if (dryRun && profile) {
					const comparison = isUpgrade(existingFileName, release.title, profile, {
						minimumImprovement: seriesData.scoringProfile?.minScoreIncrement || 0,
						allowSidegrade: false,
						candidateSizeBytes: release.size
					});

					const candidateBreakdown = Object.fromEntries(
						Object.entries(comparison.candidate.breakdown).map(([k, v]) => [k, v.score])
					);

					logger.info(
						{
							episode: title,
							existingFile: existingFileName,
							existingScore: comparison.existing.totalScore,
							candidate: release.title,
							candidateScore: comparison.candidate.totalScore,
							improvement: comparison.improvement,
							minRequired: seriesData.scoringProfile?.minScoreIncrement || 0,
							isUpgrade: comparison.isUpgrade,
							verdict: comparison.isUpgrade ? 'WOULD GRAB' : 'REJECTED'
						},
						'[DryRun] Upgrade comparison'
					);

					// Track best candidate (even if not accepted)
					if (!bestCandidate || comparison.candidate.totalScore > bestCandidate.score) {
						bestCandidate = {
							name: release.title,
							score: comparison.candidate.totalScore,
							improvement: comparison.improvement,
							breakdown: candidateBreakdown
						};
						if (comparison.isUpgrade) {
							wouldGrabReason = 'Upgrade accepted';
						} else if (comparison.improvement <= 0) {
							wouldGrabReason = `Score not better (improvement: ${comparison.improvement})`;
						} else {
							wouldGrabReason = `Improvement ${comparison.improvement} below minimum ${seriesData.scoringProfile?.minScoreIncrement || 0}`;
						}
					}
				}

				const upgradeResult = await upgradeSpec.isSatisfied(context, releaseCandidate);
				if (upgradeResult.accepted) {
					if (dryRun) {
						// In dry-run mode, don't actually grab - just report what would happen
						logger.info(
							{
								episode: title,
								release: release.title,
								existingFile: existingFileName,
								existingScore,
								candidateScore: release.totalScore ?? 0
							},
							'[DryRun] Would grab upgrade'
						);

						const result: ItemSearchResult = {
							itemId: episode.id,
							itemType: 'episode',
							title,
							searched: true,
							releasesFound: searchResult.releases.length,
							grabbed: false, // Didn't actually grab
							grabbedRelease: release.title // What would have been grabbed
						};
						const detail: UpgradeDecisionDetail = {
							itemId: episode.id,
							itemType: 'episode',
							title,
							existingFile: {
								name: existingFileName,
								score: existingScore,
								breakdown: existingBreakdown
							},
							bestCandidate: bestCandidate ?? {
								name: release.title,
								score: release.totalScore ?? 0,
								improvement: (release.totalScore ?? 0) - existingScore
							},
							candidatesChecked,
							wouldGrab: true,
							reason: 'Upgrade accepted - would grab'
						};
						return { result, detail };
					}

					// This is an upgrade! Grab it
					const grabResult = await this.grabRelease(release, {
						mediaType: 'tv',
						seriesId: seriesData.id,
						episodeIds: [episode.id],
						seasonNumber: episode.seasonNumber,
						isAutomatic: true,
						isUpgrade: true
					});

					return {
						result: {
							itemId: episode.id,
							itemType: 'episode',
							title,
							searched: true,
							releasesFound: searchResult.releases.length,
							grabbed: grabResult.success,
							grabbedRelease: grabResult.releaseName,
							queueItemId: grabResult.queueItemId,
							error: grabResult.error,
							rejectionType: grabResult.rejectionType
						}
					};
				}
			}

			// No upgrades found
			const result: ItemSearchResult = {
				itemId: episode.id,
				itemType: 'episode',
				title,
				searched: true,
				releasesFound: searchResult.releases.length,
				grabbed: false
			};
			const detail: UpgradeDecisionDetail | undefined = dryRun
				? {
						itemId: episode.id,
						itemType: 'episode',
						title,
						existingFile: {
							name: existingFileName,
							score: existingScore,
							breakdown: existingBreakdown
						},
						bestCandidate,
						candidatesChecked,
						wouldGrab: false,
						reason: wouldGrabReason
					}
				: undefined;
			return { result, detail };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			const result: ItemSearchResult = {
				itemId: episode.id,
				itemType: 'episode',
				title,
				searched: true,
				releasesFound: 0,
				grabbed: false,
				error: message
			};
			const detail: UpgradeDecisionDetail | undefined = dryRun
				? {
						itemId: episode.id,
						itemType: 'episode',
						title,
						existingFile: {
							name: existingFileName,
							score: existingScore,
							breakdown: existingBreakdown
						},
						bestCandidate: null,
						candidatesChecked: 0,
						wouldGrab: false,
						reason: `Error: ${message}`
					}
				: undefined;
			return { result, detail };
		}
	}

	/**
	 * Search for newly aired episodes
	 * @param intervalHours - How far back to look for new episodes
	 * @param signal - Optional AbortSignal for cancellation support
	 */
	async searchNewEpisodes(intervalHours: number, signal?: AbortSignal): Promise<SearchResults> {
		logger.info({ intervalHours }, '[MonitoringSearch] Starting new episode search');

		const results: ItemSearchResult[] = [];

		try {
			// Check for cancellation
			if (signal?.aborted) {
				logger.info('[MonitoringSearch] New episode search cancelled');
				throw new TaskCancelledException('search');
			}

			// Calculate cutoff date. This pre-filter must be at least as wide as
			// NewEpisodeSpecification's own lookback window (NEW_EPISODE_LOOKBACK_HOURS),
			// which is fixed and independent of intervalHours (the task's scheduling
			// cadence) - otherwise this query could exclude episodes the spec would
			// have accepted.
			const cutoffDate = new Date();
			cutoffDate.setHours(cutoffDate.getHours() - NEW_EPISODE_LOOKBACK_HOURS);

			// Query recently aired episodes without files
			// airDate is stored date-only ("YYYY-MM-DD") while the cutoff is a full
			// ISO datetime — a lexicographic gte() against the datetime excludes
			// episodes aired ON the cutoff date (e.g. everything today after 01:00
			// UTC for an hourly interval). Compare against the cutoff's DATE so the
			// full lookback window is covered; slight over-inclusion is safe (the
			// per-episode flow filters already-grabbed/failed episodes downstream).
			const cutoffDateOnly = cutoffDate.toISOString().slice(0, 10);
			const recentEpisodes = await db.query.episodes.findMany({
				where: and(
					eq(episodes.monitored, true),
					eq(episodes.hasFile, false),
					lte(episodes.airDate, new Date().toISOString().slice(0, 10)),
					gte(episodes.airDate, cutoffDateOnly)
				),
				with: {
					series: {
						with: {
							scoringProfile: true
						}
					},
					season: true
				}
			});

			logger.info(
				{
					count: recentEpisodes.length
				},
				'[MonitoringSearch] Found recently aired episodes'
			);

			// Preload season episode counts to avoid N+1 queries
			const uniqueSeriesIds = [...new Set(recentEpisodes.map((e) => e.seriesId))];
			await this.preloadSeasonEpisodeCounts(uniqueSeriesIds);

			// Filter through specifications
			const newEpisodeSpec = new NewEpisodeSpecification({});
			const monitoredSpec = new EpisodeMonitoredSpecification();
			const readOnlySpec = new EpisodeReadOnlyFolderSpecification();
			// Cooldown is keyed off the task's own scheduling interval (how often this
			// task runs), not the fixed air-date lookback window - without it, a
			// frequently-scheduled task would re-query the indexer for the same
			// not-yet-found episode on every single run for up to 48h.
			const cooldownSpec = new EpisodeSearchCooldownSpecification(intervalHours);

			for (const episode of recentEpisodes) {
				// Check for cancellation before each episode
				if (signal?.aborted) {
					throw new TaskCancelledException('search');
				}

				if (!episode.series) continue;

				const context: EpisodeContext = {
					series: episode.series,
					episode,
					profile: episode.series.scoringProfile ?? undefined
				};

				// Check monitored
				const monitoredResult = await monitoredSpec.isSatisfied(context);
				if (!monitoredResult.accepted) {
					results.push({
						itemId: episode.id,
						itemType: 'episode',
						title: `${episode.series.title} S${episode.seasonNumber.toString().padStart(2, '0')}E${episode.episodeNumber.toString().padStart(2, '0')}`,
						searched: false,
						releasesFound: 0,
						grabbed: false,
						skipped: true,
						skipReason: monitoredResult.reason
					});
					continue;
				}

				// Skip episodes in read-only folders (imports would fail anyway)
				const readOnlyResult = await readOnlySpec.isSatisfied(context);
				if (!readOnlyResult.accepted) {
					results.push({
						itemId: episode.id,
						itemType: 'episode',
						title: `${episode.series.title} S${episode.seasonNumber.toString().padStart(2, '0')}E${episode.episodeNumber.toString().padStart(2, '0')}`,
						searched: false,
						releasesFound: 0,
						grabbed: false,
						skipped: true,
						skipReason: readOnlyResult.reason
					});
					continue;
				}

				// Check if newly aired
				const newEpisodeResult = await newEpisodeSpec.isSatisfied(context);
				if (!newEpisodeResult.accepted) {
					continue; // Skip silently if not in time window
				}

				// Check search cooldown (prevent hammering indexers for the same
				// not-yet-found episode across frequent runs within the lookback window)
				const cooldownResult = await cooldownSpec.isSatisfied(context);
				if (!cooldownResult.accepted) {
					continue; // Skip silently - will be retried once cooldown passes
				}

				// Update lastSearchTime before searching
				await db
					.update(episodes)
					.set({ lastSearchTime: new Date().toISOString() })
					.where(eq(episodes.id, episode.id));

				// Search and grab
				const searchResult = await this.searchAndGrabEpisode(episode.series, episode);
				results.push(searchResult);

				// Rate limiting
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		} catch (error) {
			logger.error({ err: error }, '[MonitoringSearch] New episodes search failed');
		} finally {
			// Clear the cache after search completes
			this.clearSeasonEpisodeCountCache();
		}

		return this.aggregateResults(results);
	}

	/**
	 * Search and grab the best release for a movie
	 */
	private async searchAndGrabMovie(
		movie: typeof movies.$inferSelect & {
			scoringProfile?: typeof scoringProfiles.$inferSelect | null;
		}
	): Promise<ItemSearchResult> {
		try {
			// Check if movie already has an active download
			const alreadyDownloading = await this.isMovieAlreadyDownloading(movie.id);
			if (alreadyDownloading) {
				logger.debug(
					{
						movieId: movie.id,
						title: movie.title
					},
					'[MonitoringSearch] Movie already downloading, skipping'
				);
				return {
					itemId: movie.id,
					itemType: 'movie',
					title: movie.title,
					searched: false,
					releasesFound: 0,
					grabbed: false,
					skipped: true,
					skipReason: 'already_downloading'
				};
			}

			const [indexerManager, globalIncludeAdult] = await Promise.all([
				getIndexerManager(),
				this.getGlobalIncludeAdult()
			]);

			// Get all search titles (primary + original + alternates)
			const searchTitles = await getMovieSearchTitles(movie.id);

			// Build search criteria
			const criteria: SearchCriteria = {
				searchType: 'movie',
				query: movie.title,
				tmdbId: movie.tmdbId,
				imdbId: movie.imdbId ?? undefined,
				year: movie.year ?? undefined,
				searchTitles,
				isAdult: globalIncludeAdult && (movie.adult ?? false) ? true : undefined
			};

			// Perform enriched search (automatic - background monitoring)
			const searchResult = await indexerManager.searchEnhanced(criteria, {
				searchSource: 'automatic',
				enrichment: {
					scoringProfileId: movie.scoringProfileId ?? undefined,
					filterRejected: true,
					minScore: AUTO_GRAB_MIN_SCORE
				}
			});

			if (searchResult.releases.length === 0) {
				return {
					itemId: movie.id,
					itemType: 'movie',
					title: movie.title,
					searched: true,
					releasesFound: 0,
					grabbed: false
				};
			}

			// Find best non-blocklisted release that meets scoring requirements
			const blocklistSpec = new ReleaseBlocklistSpecification({ movieId: movie.id });
			let grabResult: {
				success: boolean;
				releaseName?: string;
				queueItemId?: string;
				addedToQueue?: boolean;
				error?: string;
				rejectionType?: string;
			} | null = null;

			// Load scoring profile for explicit validation
			let _profile: ScoringProfile | undefined;
			if (movie.scoringProfile) {
				_profile = (await qualityFilter.getProfile(movie.scoringProfile.id)) ?? undefined;
			}

			for (const release of searchResult.releases) {
				const releaseCandidate: ReleaseCandidate = {
					title: release.title,
					score: release.totalScore ?? 0,
					size: release.size,
					infoHash: release.infoHash,
					indexerId: release.indexerId
				};

				// Check blocklist
				const blocklistResult = await blocklistSpec.isSatisfied(releaseCandidate);
				if (!blocklistResult.accepted) {
					logger.debug(
						{
							title: release.title,
							reason: blocklistResult.reason
						},
						'[MonitoringSearch] Release blocklisted, trying next'
					);
					continue;
				}

				// Reject TV episodes when searching for movies
				// This prevents mismatches like "Doom.Patrol.S03E06.1917.Patrol" being grabbed for movie "1917"
				const episodeInfo = release.parsed.episode;
				if (episodeInfo && (episodeInfo.season !== undefined || episodeInfo.episodes?.length)) {
					logger.debug(
						{
							movieId: movie.id,
							title: release.title,
							season: episodeInfo.season,
							episodes: episodeInfo.episodes
						},
						'[MonitoringSearch] Release rejected - TV episode, not a movie'
					);
					continue;
				}

				// Found a valid release, try to grab it
				grabResult = await this.grabRelease(release, {
					mediaType: 'movie',
					movieId: movie.id,
					isAutomatic: true
				});

				if (grabResult.success) {
					break; // Successfully grabbed
				}
			}

			return {
				itemId: movie.id,
				itemType: 'movie',
				title: movie.title,
				searched: true,
				releasesFound: searchResult.releases.length,
				grabbed: (grabResult?.success ?? false) && grabResult?.addedToQueue !== false,
				grabbedRelease: grabResult?.releaseName,
				queueItemId: grabResult?.queueItemId,
				error: grabResult?.error,
				rejectionType: grabResult?.rejectionType
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return {
				itemId: movie.id,
				itemType: 'movie',
				title: movie.title,
				searched: true,
				releasesFound: 0,
				grabbed: false,
				error: message
			};
		}
	}

	/**
	 * Search and grab the best release for an episode
	 */
	private async searchAndGrabEpisode(
		seriesData: typeof series.$inferSelect,
		episode: typeof episodes.$inferSelect
	): Promise<ItemSearchResult> {
		const title = `${seriesData.title} S${episode.seasonNumber.toString().padStart(2, '0')}E${episode.episodeNumber.toString().padStart(2, '0')}`;

		try {
			// Check if episode already has an active download
			const alreadyDownloading = await this.areEpisodesAlreadyDownloading([episode.id]);
			if (alreadyDownloading) {
				logger.debug(
					{
						episodeId: episode.id,
						title
					},
					'[MonitoringSearch] Episode already downloading, skipping'
				);
				return {
					itemId: episode.id,
					itemType: 'episode',
					title,
					searched: false,
					releasesFound: 0,
					grabbed: false,
					skipped: true,
					skipReason: 'already_downloading'
				};
			}

			const [indexerManager, globalIncludeAdult] = await Promise.all([
				getIndexerManager(),
				this.getGlobalIncludeAdult()
			]);

			// Get episode count for the target season (for season pack size validation)
			const seasonEpisodeCount = await this.getSeasonEpisodeCount(
				seriesData.id,
				episode.seasonNumber
			);

			// Get all search titles (primary + original + alternates)
			const searchTitles = await getSeriesSearchTitles(seriesData.id);

			// Build search criteria
			const criteria: SearchCriteria = {
				searchType: 'tv',
				query: seriesData.title,
				tmdbId: seriesData.tmdbId,
				tvdbId: seriesData.tvdbId ?? undefined,
				imdbId: seriesData.imdbId ?? undefined,
				season: episode.seasonNumber,
				episode: episode.episodeNumber,
				searchTitles,
				isAnime: seriesData.seriesType === 'anime' ? true : undefined,
				isAdult: globalIncludeAdult && (seriesData.adult ?? false) ? true : undefined
			};

			// Perform enriched search (automatic - background monitoring)
			// Pass seasonEpisodeCount for proper season pack size validation during enrichment
			const searchResult = await indexerManager.searchEnhanced(criteria, {
				searchSource: 'automatic',
				enrichment: {
					scoringProfileId: seriesData.scoringProfileId ?? undefined,
					filterRejected: true,
					minScore: AUTO_GRAB_MIN_SCORE,
					seasonEpisodeCount
				}
			});

			if (searchResult.releases.length === 0) {
				return {
					itemId: episode.id,
					itemType: 'episode',
					title,
					searched: true,
					releasesFound: 0,
					grabbed: false
				};
			}

			// Find best non-blocklisted release that meets scoring requirements
			const blocklistSpec = new ReleaseBlocklistSpecification({ seriesId: seriesData.id });
			let grabResult: {
				success: boolean;
				releaseName?: string;
				queueItemId?: string;
				addedToQueue?: boolean;
				error?: string;
				rejectionType?: string;
			} | null = null;

			// Load scoring profile for explicit validation
			let profile: ScoringProfile | undefined;
			if (seriesData.scoringProfileId) {
				profile = (await qualityFilter.getProfile(seriesData.scoringProfileId)) ?? undefined;
			}
			if (!profile) {
				profile = await qualityFilter.getDefaultScoringProfile();
			}

			for (const release of searchResult.releases) {
				const parsedEpisode = release.parsed.episode ?? release.episodeMatch;
				const isSeasonPack = parsedEpisode?.isSeasonPack ?? false;
				const isEpisodePointer = this.isEpisodePointerRelease(release);

				// Pointer-indexer episode-targeted missing-content search should not grab
				// full season packs.
				// Allow virtual episode pointers because they resolve to per-episode file selection.
				if (isRuTrackerIndexerName(release.indexerName) && isSeasonPack && !isEpisodePointer) {
					logger.debug(
						{
							seriesId: seriesData.id,
							episodeId: episode.id,
							title: release.title
						},
						'[MonitoringSearch] Skipping pointer-indexer season pack in episode-targeted search'
					);
					continue;
				}

				const releaseCandidate: ReleaseCandidate = {
					title: release.title,
					score: release.totalScore ?? 0,
					size: release.size,
					infoHash: release.infoHash,
					indexerId: release.indexerId
				};

				// Check blocklist
				const blocklistResult = await blocklistSpec.isSatisfied(releaseCandidate);
				if (!blocklistResult.accepted) {
					logger.debug(
						{
							title: release.title,
							reason: blocklistResult.reason
						},
						'[MonitoringSearch] Release blocklisted, trying next'
					);
					continue;
				}

				const targetEpisodeIds =
					isSeasonPack && !isEpisodePointer
						? await this.getAiredSeasonEpisodeIds(seriesData.id, episode.seasonNumber)
						: [episode.id];

				// Found a valid release, try to grab it
				grabResult = await this.grabRelease(release, {
					mediaType: 'tv',
					seriesId: seriesData.id,
					episodeIds: targetEpisodeIds.length > 0 ? targetEpisodeIds : [episode.id],
					seasonNumber: episode.seasonNumber,
					isAutomatic: true
				});

				if (grabResult.success) {
					break; // Successfully grabbed
				}
			}

			return {
				itemId: episode.id,
				itemType: 'episode',
				title,
				searched: true,
				releasesFound: searchResult.releases.length,
				grabbed: (grabResult?.success ?? false) && grabResult?.addedToQueue !== false,
				grabbedRelease: grabResult?.releaseName,
				queueItemId: grabResult?.queueItemId,
				error: grabResult?.error,
				rejectionType: grabResult?.rejectionType
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return {
				itemId: episode.id,
				itemType: 'episode',
				title,
				searched: true,
				releasesFound: 0,
				grabbed: false,
				error: message
			};
		}
	}

	private isEpisodePointerRelease(release: Pick<EnhancedReleaseResult, 'guid' | 'title'>): boolean {
		return Boolean(
			parseEpisodePointerFromGuid(release.guid) ?? parseEpisodePointerFromTitle(release.title)
		);
	}

	private async shouldApplyRuTrackerEpisodePointerPolicy(): Promise<boolean> {
		try {
			const indexerManager = await getIndexerManager();
			const maybeGetIndexers = (indexerManager as { getIndexers?: () => Promise<unknown[]> })
				.getIndexers;
			if (typeof maybeGetIndexers !== 'function') {
				return false;
			}

			const configuredIndexers = await maybeGetIndexers.call(indexerManager);
			const automaticTvIndexers = configuredIndexers.filter((indexer) => {
				const config = indexer as {
					enabled?: boolean;
					enableAutomaticSearch?: boolean;
					capabilities?: { tvSearch?: { available?: boolean }; search?: { available?: boolean } };
				};
				return Boolean(
					config.enabled &&
					config.enableAutomaticSearch &&
					(config.capabilities?.tvSearch?.available ?? config.capabilities?.search?.available)
				);
			});

			if (automaticTvIndexers.length === 0) {
				return false;
			}

			const hasRuTracker = automaticTvIndexers.some((indexer) => {
				const config = indexer as { name?: string; baseUrl?: string };
				return isRuTrackerIndexerName(config.name) || isRuTrackerHost(config.baseUrl);
			});
			const hasNonRuTracker = automaticTvIndexers.some((indexer) => {
				const config = indexer as { name?: string; baseUrl?: string };
				return !(isRuTrackerIndexerName(config.name) || isRuTrackerHost(config.baseUrl));
			});

			return hasRuTracker && !hasNonRuTracker;
		} catch {
			return false;
		}
	}

	/**
	 * Grab a release and add to download queue.
	 * Delegates to GrabService for proper protocol-specific handling.
	 */
	private async grabRelease(
		release: EnhancedReleaseResult,
		options: {
			mediaType: 'movie' | 'tv';
			movieId?: string;
			seriesId?: string;
			episodeIds?: string[];
			seasonNumber?: number;
			isAutomatic?: boolean;
			isUpgrade?: boolean;
		}
	): Promise<{
		success: boolean;
		releaseName?: string;
		error?: string;
		rejectionType?: string;
		queueItemId?: string;
		addedToQueue?: boolean;
	}> {
		const { grabService } = await import('#lib/server/downloads/GrabService.js');

		let target;
		if (options.movieId) {
			target = { type: 'movie' as const, movieId: options.movieId };
		} else if (options.seasonNumber && options.seriesId) {
			target = {
				type: 'season' as const,
				seriesId: options.seriesId,
				seasonNumber: options.seasonNumber,
				episodeIds: options.episodeIds ?? []
			};
		} else if (options.episodeIds && options.episodeIds.length > 0 && options.seriesId) {
			target = {
				type: 'episode' as const,
				episodeId: options.episodeIds[0],
				seriesId: options.seriesId
			};
		} else {
			target = {
				type: 'series' as const,
				seriesId: options.seriesId!,
				episodeIds: options.episodeIds ?? []
			};
		}

		const result = await grabService.grab({
			release: {
				title: release.title,
				infoHash: release.infoHash,
				magnetUrl: release.magnetUrl,
				downloadUrl: release.downloadUrl,
				indexerId: release.indexerId,
				indexerName: release.indexerName,
				size: release.size,
				protocol: release.protocol as 'torrent' | 'usenet' | 'streaming' | undefined
			},
			target,
			options: {
				force: false,
				skipBlocklist: false,
				allowSidegrade: false,
				isAutomatic: options.isAutomatic ?? true,
				isUpgrade: options.isUpgrade
			}
		});

		return {
			success: result.success,
			releaseName: result.success ? release.title : undefined,
			error: result.error ?? (result.success ? undefined : result.decision?.reason),
			rejectionType: result.success ? undefined : result.decision?.rejectionType,
			queueItemId: result.download?.queueId,
			addedToQueue: result.download?.addedToQueue
		};
	}

	/**
	 * Aggregate search results into summary
	 */
	private aggregateResults(items: ItemSearchResult[]): SearchResults {
		const rejectionBreakdown: Record<string, number> = {};
		for (const item of items) {
			if (item.rejectionType) {
				rejectionBreakdown[item.rejectionType] = (rejectionBreakdown[item.rejectionType] ?? 0) + 1;
			}
		}

		const summary = {
			searched: items.filter((i) => i.searched).length,
			found: items.filter((i) => i.releasesFound > 0).length,
			grabbed: items.filter((i) => i.grabbed).length,
			skipped: items.filter((i) => i.skipped).length,
			errors: items.filter((i) => i.error).length,
			rejectionBreakdown:
				Object.keys(rejectionBreakdown).length > 0 ? rejectionBreakdown : undefined
		};

		return { items, summary };
	}
}

// Export singleton instance
export const monitoringSearchService = new MonitoringSearchService();
