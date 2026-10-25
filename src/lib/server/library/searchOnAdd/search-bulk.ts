import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { evaluateIndexerSearchAvailability } from '#lib/server/indexers/search/availability.js';
import { db } from '#lib/server/db/index.js';
import { episodes, series } from '#lib/server/db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import type { EpisodeToSearch } from '#lib/server/downloads/index.js';
import type { AutoSearchItemResult, MultiSearchResult } from './types.js';
import { AltTitleRefresher } from './alt-titles.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SearchBulk', logDomain: 'scans' });

export async function searchBulkEpisodes(
	episodeIds: string[],
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	onProgress: ((update: any) => void) | undefined,
	altTitles: AltTitleRefresher
): Promise<MultiSearchResult> {
	logger.info(
		{
			count: episodeIds.length
		},
		'[SearchOnAdd] Starting bulk episode search with multi-season strategy'
	);

	if (episodeIds.length === 0) {
		return {
			results: [],
			summary: { searched: 0, found: 0, grabbed: 0 }
		};
	}

	try {
		const indexerManager = await getIndexerManager();
		const indexerAvailability = evaluateIndexerSearchAvailability(
			await indexerManager.getIndexers(),
			{
				searchType: 'tv',
				searchSource: 'interactive',
				scoringProfileId: undefined,
				getDefinitionCapabilities: (definitionId) =>
					indexerManager.getDefinitionCapabilities(definitionId)
			}
		);

		if (!indexerAvailability.ok) {
			const errorMessage = indexerAvailability.message || 'No indexers are available';
			logger.info(
				{
					count: episodeIds.length,
					code: indexerAvailability.code,
					message: errorMessage
				},
				'[SearchOnAdd] Bulk episode search blocked by indexer availability'
			);
			return {
				results: [],
				summary: { searched: 0, found: 0, grabbed: 0 },
				error: errorMessage
			};
		}

		// Load all episodes
		const allEpisodes = await db.query.episodes.findMany({
			where: inArray(episodes.id, episodeIds)
		});

		if (allEpisodes.length === 0) {
			return {
				results: [],
				summary: { searched: 0, found: 0, grabbed: 0 }
			};
		}

		// Group episodes by series
		const episodesBySeries = new Map<string, typeof allEpisodes>();
		for (const ep of allEpisodes) {
			const existing = episodesBySeries.get(ep.seriesId) || [];
			existing.push(ep);
			episodesBySeries.set(ep.seriesId, existing);
		}

		const allResults: AutoSearchItemResult[] = [];
		const operationalErrors = new Set<string>();
		const allSeasonPacks: Array<{
			seasonNumber: number;
			releaseName: string;
			episodesCovered: string[];
		}> = [];
		let totalSearched = 0;
		let totalFound = 0;
		let totalGrabbed = 0;
		let totalCompleteSeriesPacks = 0;
		let totalMultiSeasonPacks = 0;
		let totalSingleSeasonPacks = 0;
		let totalIndividualGrabbed = 0;

		const { getMultiSeasonSearchStrategy } =
			await import('#lib/server/downloads/MultiSeasonSearchStrategy.js');
		const multiSeasonStrategy = getMultiSeasonSearchStrategy();

		// Process each series separately
		for (const [seriesId, seriesEpisodes] of episodesBySeries) {
			// Get series data
			const seriesData = await db.query.series.findFirst({
				where: eq(series.id, seriesId)
			});

			if (!seriesData) {
				// Add error results for episodes from unknown series
				for (const ep of seriesEpisodes) {
					allResults.push({
						itemId: ep.id,
						itemLabel: `S${ep.seasonNumber.toString().padStart(2, '0')}E${ep.episodeNumber.toString().padStart(2, '0')}`,
						found: false,
						grabbed: false,
						error: 'Series not found'
					});
				}
				continue;
			}

			// Convert to EpisodeToSearch format
			const episodesToSearch: EpisodeToSearch[] = seriesEpisodes.map((ep) => ({
				id: ep.id,
				seriesId: ep.seriesId,
				seasonNumber: ep.seasonNumber,
				episodeNumber: ep.episodeNumber,
				hasFile: ep.hasFile,
				monitored: ep.monitored
			}));

			// Use multi-season search for this series
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
				searchSource: 'interactive',
				onProgress
			});

			// Convert and aggregate results
			for (const r of searchResult.results) {
				if (altTitles.shouldExposeOperationalError(r.error)) {
					operationalErrors.add(r.error as string);
				}
				allResults.push({
					itemId: r.episodeId,
					itemLabel: r.episodeLabel,
					found: r.found,
					grabbed: r.grabbed,
					releaseName: r.releaseName,
					error: r.error,
					wasPackGrab: r.wasPackGrab
				});
			}

			// Add season packs
			allSeasonPacks.push(
				...searchResult.seasonPacks.map((pack) => ({
					seasonNumber: pack.seasonNumber,
					releaseName: pack.releaseName,
					episodesCovered: pack.episodesCovered
				})),
				...searchResult.multiSeasonPacks.map((pack) => ({
					seasonNumber: pack.coveredSeasons[0],
					releaseName: pack.releaseName,
					episodesCovered: pack.episodesCovered
				}))
			);

			totalSearched += searchResult.summary.searched;
			totalFound += searchResult.summary.found;
			totalGrabbed += searchResult.summary.grabbed;
			totalCompleteSeriesPacks += searchResult.summary.completeSeriesPacksGrabbed;
			totalMultiSeasonPacks += searchResult.summary.multiSeasonPacksGrabbed;
			totalSingleSeasonPacks += searchResult.summary.singleSeasonPacksGrabbed;
			totalIndividualGrabbed += searchResult.summary.individualEpisodesGrabbed;
		}

		logger.info(
			{
				searched: totalSearched,
				found: totalFound,
				grabbed: totalGrabbed,
				completeSeriesPacks: totalCompleteSeriesPacks,
				multiSeasonPacks: totalMultiSeasonPacks,
				singleSeasonPacks: totalSingleSeasonPacks,
				individualEpisodesGrabbed: totalIndividualGrabbed
			},
			'[SearchOnAdd] Bulk episode search completed'
		);

		return {
			results: allResults,
			summary: {
				searched: totalSearched,
				found: totalFound,
				grabbed: totalGrabbed,
				seasonPacksGrabbed:
					totalCompleteSeriesPacks + totalMultiSeasonPacks + totalSingleSeasonPacks,
				individualEpisodesGrabbed: totalIndividualGrabbed
			},
			errors: operationalErrors.size > 0 ? [...operationalErrors] : undefined,
			seasonPacks: allSeasonPacks.length > 0 ? allSeasonPacks : undefined
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ err: error }, '[SearchOnAdd] Bulk episode search failed');
		return {
			results: [],
			summary: { searched: 0, found: 0, grabbed: 0 },
			error: message
		};
	}
}
