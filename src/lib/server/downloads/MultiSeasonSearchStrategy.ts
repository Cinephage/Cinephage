/**
 * MultiSeasonSearchStrategy
 *
 * Implements the multi-season-first search strategy with SSE streaming support.
 *
 * Search Flow:
 * 1. Phase 1: Try complete series packs (if ≥60% of series missing)
 * 2. Phase 2: Try multi-season packs (e.g., S01-S03 if 50%+ missing in that range)
 * 3. Phase 3: Try single season packs (existing CascadingSearchStrategy logic)
 * 4. Phase 4: Search individual episodes for remaining content
 *
 * Provides progress callbacks for real-time SSE streaming to the frontend.
 */

import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { todayDateString } from '#lib/utils/format.js';
import { grabService } from './GrabService.js';
import { createChildLogger } from '#lib/logging/index.js';
import { db } from '#lib/server/db/index.js';
import { episodes } from '#lib/server/db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import type { SearchCriteria } from '#lib/server/indexers/types/index.js';

const logger = createChildLogger({ module: 'MultiSeasonSearchStrategy', logDomain: 'downloads' });
import { isSeasonPack } from '#lib/server/indexers/types/release.js';
import { getSeriesSearchTitles } from '#lib/server/services/AlternateTitleService.js';

// Re-export types from CascadingSearchStrategy for consistency
export interface EpisodeToSearch {
	id: string;
	seriesId: string;
	seasonNumber: number;
	episodeNumber: number;
	hasFile: boolean | null;
	monitored: boolean | null;
}

export interface SeriesData {
	id: string;
	title: string;
	tmdbId: number;
	tvdbId?: number | null;
	imdbId?: string | null;
	scoringProfileId?: string | null;
}

export interface EpisodeSearchResult {
	episodeId: string;
	episodeLabel: string;
	searched: boolean;
	found: boolean;
	grabbed: boolean;
	releaseName?: string;
	queueItemId?: string;
	error?: string;
	wasPackGrab?: boolean;
	packSeason?: number;
}

export interface SeasonPackGrab {
	seasonNumber: number;
	releaseName: string;
	episodesCovered: string[];
	isMultiSeason?: boolean;
	coveredSeasons?: number[];
}

export interface MultiSeasonPackGrab {
	releaseName: string;
	episodesCovered: string[];
	coveredSeasons: number[];
	packType: 'complete_series' | 'multi_season';
}

export type SearchPhase =
	| 'initializing'
	| 'complete_series_search'
	| 'multi_season_search'
	| 'single_season_search'
	| 'individual_episode_search'
	| 'complete';

export interface SearchProgressUpdate {
	phase: SearchPhase;
	message: string;
	percentComplete: number;
	currentItem?: string;
	details?: {
		releaseName?: string;
		releaseType?: 'complete_series' | 'multi_season' | 'single_season' | 'episode';
		seasons?: number[];
		episodeCount?: number;
		score?: number;
		decision?: 'accepted' | 'rejected' | 'pending';
		rejectionReason?: string;
		coveragePercent?: number;
	};
}

export interface MultiSeasonSearchOptions {
	seriesData: SeriesData;
	episodes: EpisodeToSearch[];
	scoringProfileId?: string;
	searchSource: 'interactive' | 'automatic';
	minScore?: number;
	onProgress?: (update: SearchProgressUpdate) => void;
	/** Threshold for complete series packs (default: 60%) */
	completeSeriesThreshold?: number;
	/** Threshold for multi-season packs (default: 50%) */
	multiSeasonThreshold?: number;
	/** Threshold for single season packs (default: 50%) */
	singleSeasonThreshold?: number;
}

export interface MultiSeasonSearchResult {
	results: EpisodeSearchResult[];
	seasonPacks: SeasonPackGrab[];
	multiSeasonPacks: MultiSeasonPackGrab[];
	summary: {
		searched: number;
		found: number;
		grabbed: number;
		completeSeriesPacksGrabbed: number;
		multiSeasonPacksGrabbed: number;
		singleSeasonPacksGrabbed: number;
		individualEpisodesGrabbed: number;
	};
	grabbedEpisodeIds: Set<string>;
}

/**
 * Service for multi-season aware episode searches
 */
export class MultiSeasonSearchStrategy {
	private readonly DEFAULT_COMPLETE_SERIES_THRESHOLD = 60;
	private readonly DEFAULT_MULTI_SEASON_THRESHOLD = 50;
	private readonly DEFAULT_SINGLE_SEASON_THRESHOLD = 50;
	private readonly RATE_LIMIT_MS = 500;

	/**
	 * Main entry point: Search with multi-season priority
	 */
	async searchWithMultiSeasonPriority(
		options: MultiSeasonSearchOptions
	): Promise<MultiSeasonSearchResult> {
		const {
			seriesData,
			episodes: episodesToSearch,
			scoringProfileId,
			searchSource,
			minScore = 0,
			onProgress,
			completeSeriesThreshold = this.DEFAULT_COMPLETE_SERIES_THRESHOLD,
			multiSeasonThreshold = this.DEFAULT_MULTI_SEASON_THRESHOLD,
			singleSeasonThreshold = this.DEFAULT_SINGLE_SEASON_THRESHOLD
		} = options;

		logger.info(
			{
				seriesId: seriesData.id,
				title: seriesData.title,
				episodeCount: episodesToSearch.length
			},
			'[MultiSeasonSearch] Starting multi-season priority search'
		);

		// Group episodes by season
		const episodesBySeason = this.groupEpisodesBySeason(episodesToSearch);
		const seasonNumbers = Array.from(episodesBySeason.keys()).sort((a, b) => a - b);

		// Get total episode counts
		const seasonTotalCounts = await this.getSeasonTotalCounts(seriesData.id, seasonNumbers);
		const totalEpisodesInSeries = Array.from(seasonTotalCounts.values()).reduce((a, b) => a + b, 0);
		const totalMissingEpisodes = episodesToSearch.length;

		// Calculate series-wide missing percentage
		const seriesMissingPercent = (totalMissingEpisodes / totalEpisodesInSeries) * 100;

		this.reportProgress(onProgress, {
			phase: 'initializing',
			message: `Analyzing ${totalMissingEpisodes} missing episodes across ${seasonNumbers.length} seasons...`,
			percentComplete: 5,
			details: {
				episodeCount: totalMissingEpisodes,
				coveragePercent: seriesMissingPercent
			}
		});

		// Initialize results
		const results: EpisodeSearchResult[] = [];
		const seasonPacks: SeasonPackGrab[] = [];
		const multiSeasonPacks: MultiSeasonPackGrab[] = [];
		const grabbedEpisodeIds = new Set<string>();

		// Phase 1: Try complete series packs
		if (seriesMissingPercent >= completeSeriesThreshold) {
			this.reportProgress(onProgress, {
				phase: 'complete_series_search',
				message: `Trying complete series packs (${seriesMissingPercent.toFixed(1)}% missing)...`,
				percentComplete: 10
			});

			const completeSeriesResult = await this.searchAndGrabCompleteSeries({
				seriesData,
				allEpisodes: episodesToSearch,
				totalEpisodesInSeries,
				seasonNumbers,
				scoringProfileId,
				searchSource,
				minScore,
				onProgress
			});

			if (completeSeriesResult.grabbed) {
				// Complete series pack grabbed! All episodes covered
				for (const epId of completeSeriesResult.episodesCovered) {
					grabbedEpisodeIds.add(epId);
				}

				multiSeasonPacks.push({
					releaseName: completeSeriesResult.releaseName || 'Unknown',
					episodesCovered: completeSeriesResult.episodesCovered,
					coveredSeasons: seasonNumbers,
					packType: 'complete_series'
				});

				// Mark all episodes as grabbed
				for (const ep of episodesToSearch) {
					results.push({
						episodeId: ep.id,
						episodeLabel: this.formatEpisodeLabel(ep.seasonNumber, ep.episodeNumber),
						searched: true,
						found: true,
						grabbed: true,
						releaseName: completeSeriesResult.releaseName,
						queueItemId: completeSeriesResult.queueItemId,
						wasPackGrab: true
					});
				}

				this.reportProgress(onProgress, {
					phase: 'complete',
					message: `✓ Grabbed complete series pack: ${completeSeriesResult.releaseName}`,
					percentComplete: 100,
					details: {
						releaseName: completeSeriesResult.releaseName,
						releaseType: 'complete_series',
						episodeCount: completeSeriesResult.episodesCovered.length,
						decision: 'accepted'
					}
				});

				return {
					results,
					seasonPacks,
					multiSeasonPacks,
					summary: {
						searched: episodesToSearch.length,
						found: episodesToSearch.length,
						grabbed: episodesToSearch.length,
						completeSeriesPacksGrabbed: 1,
						multiSeasonPacksGrabbed: 0,
						singleSeasonPacksGrabbed: 0,
						individualEpisodesGrabbed: 0
					},
					grabbedEpisodeIds
				};
			}
		}

		// Phase 2: Try multi-season packs for ranges with high missing %
		this.reportProgress(onProgress, {
			phase: 'multi_season_search',
			message: 'Trying multi-season packs...',
			percentComplete: 25
		});

		const multiSeasonRanges = this.findMultiSeasonRanges(
			episodesBySeason,
			seasonTotalCounts,
			multiSeasonThreshold
		);

		for (const range of multiSeasonRanges) {
			const rangeEpisodes = episodesToSearch.filter(
				(ep) => ep.seasonNumber >= range.startSeason && ep.seasonNumber <= range.endSeason
			);

			this.reportProgress(onProgress, {
				phase: 'multi_season_search',
				message: `Searching for S${range.startSeason.toString().padStart(2, '0')}-S${range.endSeason.toString().padStart(2, '0')} pack...`,
				percentComplete: 30,
				details: {
					seasons: range.seasons,
					episodeCount: rangeEpisodes.length,
					coveragePercent: range.missingPercent
				}
			});

			const rangeResult = await this.searchAndGrabMultiSeasonPack({
				seriesData,
				startSeason: range.startSeason,
				endSeason: range.endSeason,
				episodes: rangeEpisodes,
				scoringProfileId,
				searchSource,
				minScore,
				onProgress
			});

			if (rangeResult.grabbed) {
				for (const epId of rangeResult.episodesCovered) {
					grabbedEpisodeIds.add(epId);
				}

				multiSeasonPacks.push({
					releaseName: rangeResult.releaseName || 'Unknown',
					episodesCovered: rangeResult.episodesCovered,
					coveredSeasons: range.seasons,
					packType: 'multi_season'
				});

				// Add results for grabbed episodes
				for (const ep of rangeEpisodes) {
					if (rangeResult.episodesCovered.includes(ep.id)) {
						results.push({
							episodeId: ep.id,
							episodeLabel: this.formatEpisodeLabel(ep.seasonNumber, ep.episodeNumber),
							searched: true,
							found: true,
							grabbed: true,
							releaseName: rangeResult.releaseName,
							queueItemId: rangeResult.queueItemId,
							wasPackGrab: true
						});
					}
				}

				this.reportProgress(onProgress, {
					phase: 'multi_season_search',
					message: `✓ Grabbed multi-season pack: ${rangeResult.releaseName}`,
					percentComplete: 40,
					details: {
						releaseName: rangeResult.releaseName,
						releaseType: 'multi_season',
						seasons: range.seasons,
						episodeCount: rangeResult.episodesCovered.length,
						decision: 'accepted'
					}
				});
			}

			await this.delay(this.RATE_LIMIT_MS);
		}

		// Phase 3: Try single season packs for remaining seasons
		this.reportProgress(onProgress, {
			phase: 'single_season_search',
			message: 'Searching individual seasons...',
			percentComplete: 50
		});

		for (const [seasonNumber, seasonEpisodes] of episodesBySeason) {
			// Skip if already grabbed via multi-season pack
			if (seasonEpisodes.every((ep) => grabbedEpisodeIds.has(ep.id))) {
				continue;
			}

			const totalInSeason = seasonTotalCounts.get(seasonNumber) ?? seasonEpisodes.length;
			const missingInSeason = seasonEpisodes.filter((ep) => !grabbedEpisodeIds.has(ep.id)).length;
			const missingPercent = (missingInSeason / totalInSeason) * 100;

			if (missingPercent < singleSeasonThreshold) {
				logger.debug(
					{
						season: seasonNumber,
						missingPercent: missingPercent.toFixed(1)
					},
					'[MultiSeasonSearch] Skipping single season pack - not enough missing'
				);
				continue;
			}

			this.reportProgress(onProgress, {
				phase: 'single_season_search',
				message: `Searching Season ${seasonNumber}...`,
				percentComplete: 50 + (seasonNumber / seasonNumbers.length) * 20,
				details: {
					seasons: [seasonNumber],
					episodeCount: missingInSeason,
					coveragePercent: missingPercent
				}
			});

			const remainingEpisodes = seasonEpisodes.filter((ep) => !grabbedEpisodeIds.has(ep.id));
			const packResult = await this.searchAndGrabSingleSeasonPack({
				seriesData,
				seasonNumber,
				episodes: remainingEpisodes,
				totalEpisodes: totalInSeason,
				scoringProfileId,
				searchSource,
				minScore,
				onProgress
			});

			if (packResult.grabbed) {
				for (const epId of packResult.episodesCovered) {
					grabbedEpisodeIds.add(epId);
				}

				seasonPacks.push({
					seasonNumber,
					releaseName: packResult.releaseName || 'Unknown',
					episodesCovered: packResult.episodesCovered
				});

				for (const ep of seasonEpisodes) {
					if (packResult.episodesCovered.includes(ep.id)) {
						results.push({
							episodeId: ep.id,
							episodeLabel: this.formatEpisodeLabel(ep.seasonNumber, ep.episodeNumber),
							searched: true,
							found: true,
							grabbed: true,
							releaseName: packResult.releaseName,
							queueItemId: packResult.queueItemId,
							wasPackGrab: true,
							packSeason: seasonNumber
						});
					}
				}

				this.reportProgress(onProgress, {
					phase: 'single_season_search',
					message: `✓ Grabbed Season ${seasonNumber} pack`,
					percentComplete: 50 + (seasonNumber / seasonNumbers.length) * 20,
					details: {
						releaseName: packResult.releaseName,
						releaseType: 'single_season',
						seasons: [seasonNumber],
						decision: 'accepted'
					}
				});
			}

			await this.delay(this.RATE_LIMIT_MS);
		}

		// Phase 4: Search remaining episodes individually
		const remainingEpisodes = episodesToSearch.filter((ep) => !grabbedEpisodeIds.has(ep.id));
		const totalRemaining = remainingEpisodes.length;

		if (totalRemaining > 0) {
			this.reportProgress(onProgress, {
				phase: 'individual_episode_search',
				message: `Searching ${totalRemaining} remaining episodes individually...`,
				percentComplete: 75
			});

			for (let i = 0; i < remainingEpisodes.length; i++) {
				const episode = remainingEpisodes[i];
				const episodeLabel = this.formatEpisodeLabel(episode.seasonNumber, episode.episodeNumber);

				this.reportProgress(onProgress, {
					phase: 'individual_episode_search',
					message: `Searching ${episodeLabel}...`,
					percentComplete: 75 + (i / totalRemaining) * 20,
					currentItem: episodeLabel
				});

				// Import and use CascadingSearchStrategy for individual episode search
				const { getCascadingSearchStrategy } = await import('./CascadingSearchStrategy.js');
				const cascadingStrategy = getCascadingSearchStrategy();

				const episodeResult = await cascadingStrategy.searchEpisodes({
					seriesData,
					episodes: [episode],
					scoringProfileId,
					searchSource,
					minScore
				});

				if (episodeResult.results.length > 0) {
					const result = episodeResult.results[0];
					results.push(result);

					if (result.grabbed) {
						grabbedEpisodeIds.add(episode.id);

						// If grabbed via pack during episode search, mark all covered
						if (result.wasPackGrab && episodeResult.grabbedEpisodeIds) {
							for (const epId of episodeResult.grabbedEpisodeIds) {
								grabbedEpisodeIds.add(epId);
							}
						}
					}
				}

				await this.delay(this.RATE_LIMIT_MS);
			}
		}

		// Calculate final summary
		const grabbedCount = grabbedEpisodeIds.size;
		const completeSeriesPacks = multiSeasonPacks.filter(
			(p) => p.packType === 'complete_series'
		).length;
		const multiSeasonPackCount = multiSeasonPacks.filter(
			(p) => p.packType === 'multi_season'
		).length;
		const singleSeasonPackCount = seasonPacks.length;
		const individualCount =
			grabbedCount -
			multiSeasonPacks.reduce((sum, p) => sum + p.episodesCovered.length, 0) -
			seasonPacks.reduce((sum, p) => sum + p.episodesCovered.length, 0);

		this.reportProgress(onProgress, {
			phase: 'complete',
			message: `Search complete: ${grabbedCount}/${episodesToSearch.length} episodes grabbed`,
			percentComplete: 100
		});

		logger.info(
			{
				seriesId: seriesData.id,
				totalSearched: episodesToSearch.length,
				totalGrabbed: grabbedCount,
				completeSeriesPacks,
				multiSeasonPacks: multiSeasonPackCount,
				singleSeasonPacks: singleSeasonPackCount
			},
			'[MultiSeasonSearch] Search completed'
		);

		return {
			results,
			seasonPacks,
			multiSeasonPacks,
			summary: {
				searched: episodesToSearch.length,
				found: results.filter((r) => r.found).length,
				grabbed: grabbedCount,
				completeSeriesPacksGrabbed: completeSeriesPacks,
				multiSeasonPacksGrabbed: multiSeasonPackCount,
				singleSeasonPacksGrabbed: singleSeasonPackCount,
				individualEpisodesGrabbed: Math.max(0, individualCount)
			},
			grabbedEpisodeIds
		};
	}

	// ============================================================================
	// Phase 1: Complete Series Packs
	// ============================================================================

	private async searchAndGrabCompleteSeries(options: {
		seriesData: SeriesData;
		allEpisodes: EpisodeToSearch[];
		totalEpisodesInSeries: number;
		seasonNumbers: number[];
		scoringProfileId?: string;
		searchSource: 'interactive' | 'automatic';
		minScore: number;
		onProgress?: (update: SearchProgressUpdate) => void;
	}): Promise<{
		grabbed: boolean;
		releaseName?: string;
		queueItemId?: string;
		episodesCovered: string[];
	}> {
		const { seriesData, allEpisodes, seasonNumbers, searchSource, minScore, onProgress } = options;
		const episodeIds = allEpisodes.map((e) => e.id);

		try {
			const indexerManager = await getIndexerManager();
			const searchTitles = await getSeriesSearchTitles(seriesData.id);

			// Search without season filter to get complete series packs
			const criteria: SearchCriteria = {
				searchType: 'tv',
				query: seriesData.title,
				tmdbId: seriesData.tmdbId,
				tvdbId: seriesData.tvdbId ?? undefined,
				imdbId: seriesData.imdbId ?? undefined,
				searchTitles
				// Note: No season filter - this returns complete series packs
			};

			this.reportProgress(onProgress, {
				phase: 'complete_series_search',
				message: 'Querying indexers for complete series packs...',
				percentComplete: 12
			});

			const searchResult = await indexerManager.searchEnhanced(criteria, {
				searchSource,
				enrichment: {
					scoringProfileId: options.scoringProfileId,
					filterRejected: true,
					minScore,
					seriesEpisodeCount: options.totalEpisodesInSeries
				}
			});

			if (searchResult.releases.length === 0) {
				this.reportProgress(onProgress, {
					phase: 'complete_series_search',
					message: 'No complete series packs found',
					percentComplete: 15,
					details: { decision: 'rejected', rejectionReason: 'No releases found' }
				});
				return { grabbed: false, episodesCovered: [] };
			}

			// Filter to complete series packs.
			// Use || (not ??) because isCompleteSeries is always a boolean (never undefined),
			// so ?? would never fall through to the seasons-length fallback.
			const completeSeriesPacks = searchResult.releases.filter((release) => {
				return (
					release.parsed.episode?.isCompleteSeries ||
					(release.parsed.episode?.isSeasonPack &&
						release.parsed.episode?.seasons?.length === seasonNumbers.length)
				);
			});

			if (completeSeriesPacks.length === 0) {
				this.reportProgress(onProgress, {
					phase: 'complete_series_search',
					message: `Found ${searchResult.releases.length} releases, but no complete series packs`,
					percentComplete: 15,
					details: { decision: 'rejected', rejectionReason: 'No complete series packs in results' }
				});
				return { grabbed: false, episodesCovered: [] };
			}

			this.reportProgress(onProgress, {
				phase: 'complete_series_search',
				message: `Found ${completeSeriesPacks.length} complete series packs, evaluating...`,
				percentComplete: 15
			});

			// Evaluate each complete series pack
			for (const release of completeSeriesPacks) {
				this.reportProgress(onProgress, {
					phase: 'complete_series_search',
					message: `Evaluating: ${release.title}`,
					percentComplete: 18,
					details: {
						releaseName: release.title,
						releaseType: 'complete_series',
						score: release.totalScore
					}
				});

				const grabResult = await grabService.grab({
					release: {
						title: release.title,
						infoHash: release.infoHash,
						magnetUrl: release.magnetUrl,
						downloadUrl: release.downloadUrl,
						indexerId: release.indexerId,
						indexerName: release.indexerName,
						size: release.size,
						protocol: release.protocol as 'torrent' | 'usenet' | 'streaming' | undefined,
						tmdbId: release.tmdbId,
						imdbId: release.imdbId,
						tvdbId: release.tvdbId
					},
					target: {
						type: 'series' as const,
						seriesId: seriesData.id,
						episodeIds
					},
					options: {
						force: false,
						skipBlocklist: false,
						allowSidegrade: false,
						isAutomatic: searchSource === 'automatic',
						isUpgrade: true
					}
				});

				if (grabResult.success) {
					return {
						grabbed: true,
						releaseName: release.title,
						queueItemId: grabResult.download?.queueId,
						episodesCovered: episodeIds
					};
				} else {
					this.reportProgress(onProgress, {
						phase: 'complete_series_search',
						message: `Rejected: ${release.title} - ${grabResult.decision.reason}`,
						percentComplete: 18,
						details: {
							releaseName: release.title,
							decision: 'rejected',
							rejectionReason: grabResult.decision.reason
						}
					});
				}
			}

			return { grabbed: false, episodesCovered: [] };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			logger.error(
				{
					seriesId: seriesData.id,
					error: message
				},
				'[MultiSeasonSearch] Complete series search failed'
			);
			return { grabbed: false, episodesCovered: [] };
		}
	}

	// ============================================================================
	// Phase 2: Multi-Season Packs
	// ============================================================================

	private async searchAndGrabMultiSeasonPack(options: {
		seriesData: SeriesData;
		startSeason: number;
		endSeason: number;
		episodes: EpisodeToSearch[];
		scoringProfileId?: string;
		searchSource: 'interactive' | 'automatic';
		minScore: number;
		onProgress?: (update: SearchProgressUpdate) => void;
	}): Promise<{
		grabbed: boolean;
		releaseName?: string;
		queueItemId?: string;
		episodesCovered: string[];
	}> {
		const { seriesData, startSeason, endSeason, episodes, searchSource, minScore, onProgress } =
			options;
		const episodeIds = episodes.map((e) => e.id);

		try {
			const indexerManager = await getIndexerManager();
			const searchTitles = await getSeriesSearchTitles(seriesData.id);

			// Search without a season filter so filterBySeasonEpisode does not strip
			// multi-season packs before Phase 2's own range check sees them.
			// A season-scoped query causes the orchestrator to keep only single-season
			// packs, discarding exactly the releases we want here.
			const criteria: SearchCriteria = {
				searchType: 'tv',
				query: seriesData.title,
				tmdbId: seriesData.tmdbId,
				tvdbId: seriesData.tvdbId ?? undefined,
				imdbId: seriesData.imdbId ?? undefined,
				searchTitles
			};

			const searchResult = await indexerManager.searchEnhanced(criteria, {
				searchSource,
				enrichment: {
					scoringProfileId: options.scoringProfileId,
					filterRejected: true,
					minScore
				}
			});

			if (searchResult.releases.length === 0) {
				return { grabbed: false, episodesCovered: [] };
			}

			// Filter to multi-season packs covering our range
			const multiSeasonPacks = searchResult.releases.filter((release) => {
				const seasons = release.parsed.episode?.seasons;
				if (!seasons || seasons.length < 2) return false;

				// Check if pack covers our target range
				const packStart = Math.min(...seasons);
				const packEnd = Math.max(...seasons);
				return packStart <= startSeason && packEnd >= endSeason;
			});

			if (multiSeasonPacks.length === 0) {
				return { grabbed: false, episodesCovered: [] };
			}

			// Evaluate each pack
			for (const release of multiSeasonPacks) {
				this.reportProgress(onProgress, {
					phase: 'multi_season_search',
					message: `Evaluating: ${release.title}`,
					percentComplete: 35,
					details: {
						releaseName: release.title,
						releaseType: 'multi_season',
						seasons: release.parsed.episode?.seasons,
						score: release.totalScore
					}
				});

				const grabResult = await grabService.grab({
					release: {
						title: release.title,
						infoHash: release.infoHash,
						magnetUrl: release.magnetUrl,
						downloadUrl: release.downloadUrl,
						indexerId: release.indexerId,
						indexerName: release.indexerName,
						size: release.size,
						protocol: release.protocol as 'torrent' | 'usenet' | 'streaming' | undefined,
						tmdbId: release.tmdbId,
						imdbId: release.imdbId,
						tvdbId: release.tvdbId
					},
					target: {
						type: 'series' as const,
						seriesId: seriesData.id,
						episodeIds
					},
					options: {
						force: false,
						skipBlocklist: false,
						allowSidegrade: false,
						isAutomatic: searchSource === 'automatic',
						isUpgrade: true
					}
				});

				if (grabResult.success) {
					return {
						grabbed: true,
						releaseName: release.title,
						queueItemId: grabResult.download?.queueId,
						episodesCovered: episodeIds
					};
				}
			}

			return { grabbed: false, episodesCovered: [] };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			logger.error(
				{
					seriesId: seriesData.id,
					startSeason,
					endSeason,
					error: message
				},
				'[MultiSeasonSearch] Multi-season search failed'
			);
			return { grabbed: false, episodesCovered: [] };
		}
	}

	// ============================================================================
	// Phase 3: Single Season Packs
	// ============================================================================

	private async searchAndGrabSingleSeasonPack(options: {
		seriesData: SeriesData;
		seasonNumber: number;
		episodes: EpisodeToSearch[];
		totalEpisodes: number;
		scoringProfileId?: string;
		searchSource: 'interactive' | 'automatic';
		minScore: number;
		onProgress?: (update: SearchProgressUpdate) => void;
	}): Promise<{
		grabbed: boolean;
		releaseName?: string;
		queueItemId?: string;
		episodesCovered: string[];
	}> {
		const { seriesData, seasonNumber, episodes, totalEpisodes, searchSource, minScore } = options;
		const episodeIds = episodes.map((e) => e.id);

		try {
			const indexerManager = await getIndexerManager();
			const searchTitles = await getSeriesSearchTitles(seriesData.id);

			const criteria: SearchCriteria = {
				searchType: 'tv',
				query: seriesData.title,
				tmdbId: seriesData.tmdbId,
				tvdbId: seriesData.tvdbId ?? undefined,
				imdbId: seriesData.imdbId ?? undefined,
				season: seasonNumber,
				searchTitles
			};

			const searchResult = await indexerManager.searchEnhanced(criteria, {
				searchSource,
				enrichment: {
					scoringProfileId: options.scoringProfileId,
					filterRejected: true,
					minScore,
					seasonEpisodeCount: totalEpisodes
				}
			});

			if (searchResult.releases.length === 0) {
				return { grabbed: false, episodesCovered: [] };
			}

			// Filter to single-season packs only
			const singleSeasonPacks = searchResult.releases.filter((release) => {
				const isPack = isSeasonPack(release);
				const seasons =
					release.parsed.episode?.seasons ??
					(release.episodeMatch?.season ? [release.episodeMatch.season] : []);
				return isPack && seasons.length === 1 && seasons[0] === seasonNumber;
			});

			if (singleSeasonPacks.length === 0) {
				return { grabbed: false, episodesCovered: [] };
			}

			// Evaluate each pack
			for (const release of singleSeasonPacks) {
				const grabResult = await grabService.grab({
					release: {
						title: release.title,
						infoHash: release.infoHash,
						magnetUrl: release.magnetUrl,
						downloadUrl: release.downloadUrl,
						indexerId: release.indexerId,
						indexerName: release.indexerName,
						size: release.size,
						protocol: release.protocol as 'torrent' | 'usenet' | 'streaming' | undefined,
						tmdbId: release.tmdbId,
						imdbId: release.imdbId,
						tvdbId: release.tvdbId
					},
					target: {
						type: 'season' as const,
						seriesId: seriesData.id,
						seasonNumber,
						episodeIds
					},
					options: {
						force: false,
						skipBlocklist: false,
						allowSidegrade: false,
						isAutomatic: searchSource === 'automatic',
						isUpgrade: true
					}
				});

				if (grabResult.success) {
					return {
						grabbed: true,
						releaseName: release.title,
						queueItemId: grabResult.download?.queueId,
						episodesCovered: episodeIds
					};
				}
			}

			return { grabbed: false, episodesCovered: [] };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			logger.error(
				{
					seriesId: seriesData.id,
					season: seasonNumber,
					error: message
				},
				'[MultiSeasonSearch] Single season search failed'
			);
			return { grabbed: false, episodesCovered: [] };
		}
	}

	// ============================================================================
	// Helper Methods
	// ============================================================================

	/**
	 * Group episodes by season number
	 */
	private groupEpisodesBySeason(
		episodesToSearch: EpisodeToSearch[]
	): Map<number, EpisodeToSearch[]> {
		const grouped = new Map<number, EpisodeToSearch[]>();

		for (const episode of episodesToSearch) {
			const existing = grouped.get(episode.seasonNumber) || [];
			existing.push(episode);
			grouped.set(episode.seasonNumber, existing);
		}

		return grouped;
	}

	/**
	 * Get total episode counts for multiple seasons (aired episodes only)
	 */
	private async getSeasonTotalCounts(
		seriesId: string,
		seasonNumbers: number[]
	): Promise<Map<number, number>> {
		const counts = new Map<number, number>();

		if (seasonNumbers.length === 0) return counts;

		const today = todayDateString();
		const isAired = (ep: { airDate: string | null }) =>
			Boolean(ep.airDate && ep.airDate !== '' && ep.airDate <= today);

		const allEpisodes = await db.query.episodes.findMany({
			where: and(eq(episodes.seriesId, seriesId), inArray(episodes.seasonNumber, seasonNumbers)),
			columns: { seasonNumber: true, airDate: true }
		});

		for (const ep of allEpisodes) {
			if (!isAired(ep)) continue;
			counts.set(ep.seasonNumber, (counts.get(ep.seasonNumber) || 0) + 1);
		}

		return counts;
	}

	/**
	 * Find ranges of consecutive seasons with high missing percentages
	 */
	private findMultiSeasonRanges(
		episodesBySeason: Map<number, EpisodeToSearch[]>,
		seasonTotalCounts: Map<number, number>,
		threshold: number
	): Array<{
		startSeason: number;
		endSeason: number;
		seasons: number[];
		missingPercent: number;
	}> {
		const ranges: Array<{
			startSeason: number;
			endSeason: number;
			seasons: number[];
			missingPercent: number;
		}> = [];

		const sortedSeasons = Array.from(episodesBySeason.keys()).sort((a, b) => a - b);

		for (let i = 0; i < sortedSeasons.length; i++) {
			const startSeason = sortedSeasons[i];

			// Try to extend the range
			// eslint-disable-next-line no-useless-assignment
			let endSeason = startSeason;
			let totalMissing = 0;
			let totalEpisodes = 0;
			const rangeSeasons: number[] = [];

			for (let j = i; j < sortedSeasons.length; j++) {
				const season = sortedSeasons[j];

				// Check if consecutive
				if (j > i && season !== sortedSeasons[j - 1] + 1) {
					break; // Not consecutive
				}

				const seasonEpisodes = episodesBySeason.get(season) || [];
				const seasonTotal = seasonTotalCounts.get(season) ?? seasonEpisodes.length;

				totalMissing += seasonEpisodes.length;
				totalEpisodes += seasonTotal;
				rangeSeasons.push(season);
				endSeason = season;

				// Check if range meets threshold and has at least 2 seasons
				if (rangeSeasons.length >= 2) {
					const missingPercent = (totalMissing / totalEpisodes) * 100;
					if (missingPercent >= threshold) {
						ranges.push({
							startSeason,
							endSeason,
							seasons: [...rangeSeasons],
							missingPercent
						});
					}
				}
			}
		}

		// Sort by coverage (most episodes covered first)
		return ranges.sort((a, b) => {
			const aSize = a.seasons.length;
			const bSize = b.seasons.length;
			return bSize - aSize; // Descending by season count
		});
	}

	/**
	 * Format episode label (e.g., "S01E05")
	 */
	private formatEpisodeLabel(season: number, episode: number): string {
		return `S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`;
	}

	/**
	 * Report progress if callback is provided
	 */
	private reportProgress(
		onProgress: ((update: SearchProgressUpdate) => void) | undefined,
		update: SearchProgressUpdate
	): void {
		if (onProgress) {
			onProgress(update);
		}
	}

	/**
	 * Delay for rate limiting
	 */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

// Singleton instance
let strategyInstance: MultiSeasonSearchStrategy | null = null;

/**
 * Get the MultiSeasonSearchStrategy singleton
 */
export function getMultiSeasonSearchStrategy(): MultiSeasonSearchStrategy {
	if (!strategyInstance) {
		strategyInstance = new MultiSeasonSearchStrategy();
	}
	return strategyInstance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetMultiSeasonSearchStrategy(): void {
	strategyInstance = null;
}
