/**
 * Search On Add — missing episodes search
 */

import { todayDateString } from '#lib/utils/format.js';
import { db } from '#lib/server/db/index.js';
import { series, episodes } from '#lib/server/db/schema.js';
import { eq, and, ne } from 'drizzle-orm';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { evaluateIndexerSearchAvailability } from '#lib/server/indexers/search/availability.js';
import { type EpisodeToSearch } from '#lib/server/downloads/index.js';
import type {
	SearchForMissingEpisodesOptions,
	MultiSearchResult,
	AutoSearchItemResult
} from './types.js';
import type { AltTitleRefresher } from './alt-titles.js';
import type { SearchProgressUpdate } from '#lib/server/downloads/MultiSeasonSearchStrategy.js';
import { resolveAutoMissingSearchStrategy } from './search-utils.js';
import { searchForEpisode as searchForEpisodeImpl } from './search-episode.js';
import { searchForSeason as searchForSeasonImpl } from './search-season.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SearchMissing', logDomain: 'scans' });

export async function searchForMissingEpisodes(
	seriesId: string,
	onProgress: ((update: SearchProgressUpdate) => void) | undefined,
	options: SearchForMissingEpisodesOptions,
	altTitles: AltTitleRefresher,
	_searchEpisodeFn?: typeof searchForEpisodeImpl,
	_searchSeasonFn?: typeof searchForSeasonImpl
): Promise<MultiSearchResult> {
	const searchEpFn = _searchEpisodeFn ?? searchForEpisodeImpl;
	const searchSeFn = _searchSeasonFn ?? searchForSeasonImpl;
	const {
		bypassMonitoring = false,
		searchStrategy = 'pack-first',
		searchSource = 'automatic'
	} = options;

	logger.info(
		{
			seriesId,
			bypassMonitoring,
			searchStrategy
		},
		'[SearchOnAdd] Starting missing episodes search with multi-season strategy'
	);

	try {
		// Get series data first
		const seriesData = await db.query.series.findFirst({
			where: eq(series.id, seriesId)
		});

		if (!seriesData) {
			return {
				results: [],
				summary: { searched: 0, found: 0, grabbed: 0 },
				error: 'Series not found'
			};
		}

		const indexerManager = await getIndexerManager();
		const indexerConfigs = await indexerManager.getIndexers();
		const indexerAvailability = evaluateIndexerSearchAvailability(indexerConfigs, {
			searchType: 'tv',
			searchSource,
			scoringProfileId: seriesData.scoringProfileId ?? undefined,
			getDefinitionCapabilities: (definitionId) =>
				indexerManager.getDefinitionCapabilities(definitionId)
		});

		if (!indexerAvailability.ok) {
			const errorMessage = indexerAvailability.message || 'No indexers are available';
			logger.info(
				{
					seriesId,
					code: indexerAvailability.code,
					message: errorMessage
				},
				'[SearchOnAdd] Missing episodes search blocked by indexer availability'
			);
			return {
				results: [],
				summary: { searched: 0, found: 0, grabbed: 0 },
				error: errorMessage
			};
		}

		const effectiveSearchStrategy =
			searchStrategy === 'auto'
				? await resolveAutoMissingSearchStrategy(indexerConfigs, {
						searchSource,
						scoringProfileId: seriesData.scoringProfileId,
						getDefinitionCapabilities: (definitionId) =>
							indexerManager.getDefinitionCapabilities(definitionId)
					})
				: searchStrategy;

		// Find all missing episodes. Automatic/background searches only include monitored
		// episodes, while manual user-triggered searches can bypass monitoring.
		const now = todayDateString();
		const conditions = [
			eq(episodes.seriesId, seriesId),
			eq(episodes.hasFile, false),
			// Exclude specials (season 0) for missing-episode auto-search.
			// This matches series episode counts and prevents oversized "missing" totals.
			ne(episodes.seasonNumber, 0)
		];
		if (!bypassMonitoring) {
			conditions.push(eq(episodes.monitored, true));
		}

		const missingEpisodes = await db.query.episodes.findMany({
			where: and(...conditions)
		});

		// Filter to only aired episodes
		const airedMissingEpisodes = missingEpisodes.filter((ep) => {
			if (!ep.airDate) return false;
			return ep.airDate <= now;
		});

		logger.info(
			{
				seriesId,
				total: missingEpisodes.length,
				aired: airedMissingEpisodes.length,
				searchStrategy: effectiveSearchStrategy
			},
			'[SearchOnAdd] Found missing episodes'
		);

		if (airedMissingEpisodes.length === 0) {
			return {
				results: [],
				summary: { searched: 0, found: 0, grabbed: 0 }
			};
		}

		// Convert to EpisodeToSearch format
		const episodesToSearch: EpisodeToSearch[] = airedMissingEpisodes.map((ep) => ({
			id: ep.id,
			seriesId: ep.seriesId,
			seasonNumber: ep.seasonNumber,
			episodeNumber: ep.episodeNumber,
			hasFile: ep.hasFile,
			monitored: ep.monitored
		}));

		if (effectiveSearchStrategy === 'episode-only') {
			const sortedEpisodes = [...episodesToSearch].sort(
				(a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
			);
			const episodesBySeason = new Map<number, EpisodeToSearch[]>();
			for (const episode of sortedEpisodes) {
				const seasonEpisodes = episodesBySeason.get(episode.seasonNumber) ?? [];
				seasonEpisodes.push(episode);
				episodesBySeason.set(episode.seasonNumber, seasonEpisodes);
			}

			// Determine aired + eligible episode totals per season to decide whether
			// a season is fully missing and should use a season-pack grab.
			const eligibleSeasonConditions = [
				eq(episodes.seriesId, seriesId),
				ne(episodes.seasonNumber, 0)
			];
			if (!bypassMonitoring) {
				eligibleSeasonConditions.push(eq(episodes.monitored, true));
			}
			const eligibleSeasonEpisodes = await db.query.episodes.findMany({
				where: and(...eligibleSeasonConditions)
			});
			const eligibleAiredSeasonEpisodeCounts = new Map<number, number>();
			for (const seasonEpisode of eligibleSeasonEpisodes) {
				if (!seasonEpisode.airDate || seasonEpisode.airDate > now) {
					continue;
				}
				eligibleAiredSeasonEpisodeCounts.set(
					seasonEpisode.seasonNumber,
					(eligibleAiredSeasonEpisodeCounts.get(seasonEpisode.seasonNumber) ?? 0) + 1
				);
			}

			onProgress?.({
				phase: 'initializing',
				message: `Preparing ${sortedEpisodes.length} missing episodes for targeted search...`,
				percentComplete: 5,
				details: {
					releaseType: 'episode',
					episodeCount: sortedEpisodes.length
				}
			});

			const results: AutoSearchItemResult[] = [];
			const operationalErrors = new Set<string>();
			let foundCount = 0;
			let grabbedCount = 0;
			let individualEpisodesGrabbed = 0;
			let seasonPacksGrabbed = 0;
			const seasonPacks: NonNullable<MultiSearchResult['seasonPacks']> = [];
			let processedEpisodes = 0;

			const sortedSeasons = [...episodesBySeason.keys()].sort((a, b) => a - b);
			for (const seasonNumber of sortedSeasons) {
				const seasonEpisodes = episodesBySeason.get(seasonNumber) ?? [];
				if (seasonEpisodes.length === 0) {
					continue;
				}

				const eligibleAiredSeasonCount = eligibleAiredSeasonEpisodeCounts.get(seasonNumber) ?? 0;
				const isEntireSeasonMissing =
					eligibleAiredSeasonCount > 0 && seasonEpisodes.length === eligibleAiredSeasonCount;

				if (isEntireSeasonMissing) {
					onProgress?.({
						phase: 'single_season_search',
						message: `Searching season pack for Season ${seasonNumber}...`,
						percentComplete: Math.min(
							95,
							10 + Math.round((processedEpisodes / sortedEpisodes.length) * 80)
						),
						currentItem: `Season ${seasonNumber}`,
						details: {
							releaseType: 'single_season',
							decision: 'pending'
						}
					});

					const seasonSearchResult = await searchSeFn(
						{
							seriesId,
							seasonNumber,
							bypassMonitoring
						},
						altTitles
					);
					const seasonPackWasGrabbed = seasonSearchResult.success;
					if (
						!seasonPackWasGrabbed &&
						altTitles.shouldExposeOperationalError(seasonSearchResult.error)
					) {
						operationalErrors.add(seasonSearchResult.error as string);
					}

					if (seasonPackWasGrabbed) {
						seasonPacksGrabbed++;
						const seasonPackReleaseName = seasonSearchResult.releaseName;
						if (seasonPackReleaseName) {
							seasonPacks.push({
								seasonNumber,
								releaseName: seasonPackReleaseName,
								episodesCovered: seasonEpisodes.map((episode) => episode.id)
							});
						}

						for (const episode of seasonEpisodes) {
							const episodeLabel = `S${episode.seasonNumber.toString().padStart(2, '0')}E${episode.episodeNumber
								.toString()
								.padStart(2, '0')}`;
							foundCount++;
							grabbedCount++;
							results.push({
								itemId: episode.id,
								itemLabel: episodeLabel,
								found: true,
								grabbed: true,
								releaseName: seasonSearchResult.releaseName,
								wasPackGrab: true
							});
						}
						processedEpisodes += seasonEpisodes.length;
						continue;
					}
				}

				for (const episode of seasonEpisodes) {
					const episodeLabel = `S${episode.seasonNumber.toString().padStart(2, '0')}E${episode.episodeNumber
						.toString()
						.padStart(2, '0')}`;

					onProgress?.({
						phase: 'individual_episode_search',
						message: `Searching ${episodeLabel}...`,
						percentComplete: Math.min(
							95,
							10 + Math.round(((processedEpisodes + 1) / sortedEpisodes.length) * 80)
						),
						currentItem: episodeLabel,
						details: {
							releaseType: 'episode',
							decision: 'pending'
						}
					});

					const searchResult = await searchEpFn(
						{
							episodeId: episode.id,
							bypassMonitoring
						},
						altTitles
					);
					if (!searchResult.success && altTitles.shouldExposeOperationalError(searchResult.error)) {
						operationalErrors.add(searchResult.error as string);
					}

					const wasGrabbed = searchResult.success;
					const wasFound = wasGrabbed;

					if (wasFound) {
						foundCount++;
					}
					if (wasGrabbed) {
						grabbedCount++;
						individualEpisodesGrabbed++;
					}

					results.push({
						itemId: episode.id,
						itemLabel: episodeLabel,
						found: wasFound,
						grabbed: wasGrabbed,
						releaseName: searchResult.releaseName,
						error: wasGrabbed ? undefined : (searchResult.error ?? 'No suitable releases found')
					});
					processedEpisodes++;
				}
			}

			onProgress?.({
				phase: 'complete',
				message: `Search complete: ${grabbedCount}/${sortedEpisodes.length} episodes grabbed`,
				percentComplete: 100
			});

			logger.info(
				{
					seriesId,
					searched: sortedEpisodes.length,
					found: foundCount,
					grabbed: grabbedCount,
					seasonPacksGrabbed
				},
				'[SearchOnAdd] Missing episodes targeted search completed'
			);

			return {
				results,
				summary: {
					searched: sortedEpisodes.length,
					found: foundCount,
					grabbed: grabbedCount,
					seasonPacksGrabbed,
					individualEpisodesGrabbed
				},
				errors: operationalErrors.size > 0 ? [...operationalErrors] : undefined,
				seasonPacks: seasonPacks.length > 0 ? seasonPacks : undefined
			};
		}

		// Use multi-season search strategy
		const { getMultiSeasonSearchStrategy } =
			await import('#lib/server/downloads/MultiSeasonSearchStrategy.js');
		const multiSeasonStrategy = getMultiSeasonSearchStrategy();
		// Manual missing auto-grab should avoid re-downloading existing episodes.
		// Require 100% missing coverage before attempting any pack type.
		const packThreshold = bypassMonitoring ? 100 : undefined;

		const searchResult = await multiSeasonStrategy.searchWithMultiSeasonPriority({
			seriesData: {
				id: seriesData.id,
				title: seriesData.title,
				tmdbId: seriesData.tmdbId,
				tvdbId: seriesData.tvdbId,
				imdbId: seriesData.imdbId,
				scoringProfileId: seriesData.scoringProfileId
			},
			episodes: episodesToSearch,
			scoringProfileId: seriesData.scoringProfileId ?? undefined,
			searchSource,
			onProgress,
			completeSeriesThreshold: packThreshold,
			multiSeasonThreshold: packThreshold,
			singleSeasonThreshold: packThreshold
		});

		// Convert results to AutoSearchItemResult format
		const results: AutoSearchItemResult[] = searchResult.results.map((r) => ({
			itemId: r.episodeId,
			itemLabel: r.episodeLabel,
			found: r.found,
			grabbed: r.grabbed,
			releaseName: r.releaseName,
			error: r.error,
			wasPackGrab: r.wasPackGrab
		}));

		// Combine season packs and multi-season packs
		const allSeasonPacks = [
			...searchResult.seasonPacks.map((pack) => ({
				seasonNumber: pack.seasonNumber,
				releaseName: pack.releaseName,
				episodesCovered: pack.episodesCovered
			})),
			...searchResult.multiSeasonPacks.map((pack) => ({
				seasonNumber: pack.coveredSeasons[0], // Use first season as representative
				releaseName: pack.releaseName,
				episodesCovered: pack.episodesCovered
			}))
		];

		logger.info(
			{
				seriesId,
				searched: searchResult.summary.searched,
				found: searchResult.summary.found,
				grabbed: searchResult.summary.grabbed,
				completeSeriesPacks: searchResult.summary.completeSeriesPacksGrabbed,
				multiSeasonPacks: searchResult.summary.multiSeasonPacksGrabbed,
				singleSeasonPacks: searchResult.summary.singleSeasonPacksGrabbed,
				individualEpisodes: searchResult.summary.individualEpisodesGrabbed
			},
			'[SearchOnAdd] Missing episodes search completed'
		);

		return {
			results,
			summary: {
				searched: searchResult.summary.searched,
				found: searchResult.summary.found,
				grabbed: searchResult.summary.grabbed,
				seasonPacksGrabbed:
					searchResult.summary.singleSeasonPacksGrabbed +
					searchResult.summary.multiSeasonPacksGrabbed +
					searchResult.summary.completeSeriesPacksGrabbed,
				individualEpisodesGrabbed: searchResult.summary.individualEpisodesGrabbed
			},
			errors: searchResult.results
				.map((resultItem) => resultItem.error)
				.filter((error): error is string => altTitles.shouldExposeOperationalError(error)),
			seasonPacks: allSeasonPacks
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ seriesId, err: error }, '[SearchOnAdd] Missing episodes search failed');
		return {
			results: [],
			summary: { searched: 0, found: 0, grabbed: 0 },
			error: message
		};
	}
}
