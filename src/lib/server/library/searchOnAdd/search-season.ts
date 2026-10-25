import { db } from '#lib/server/db/index.js';
import { series, episodes } from '#lib/server/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { evaluateIndexerSearchAvailability } from '#lib/server/indexers/search/availability.js';
import type { SearchCriteria } from '#lib/server/indexers/types/index.js';
import { grabService } from '#lib/server/downloads/GrabService.js';
import type { SearchForSeasonParams, GrabResult } from './types.js';
import type { AltTitleRefresher } from './alt-titles.js';
import { AUTO_GRAB_MIN_SCORE } from './search-utils.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SearchSeason', logDomain: 'scans' });

export async function searchForSeason(
	params: SearchForSeasonParams,
	altTitles: AltTitleRefresher
): Promise<GrabResult> {
	const { seriesId, seasonNumber, bypassMonitoring = false } = params;

	logger.info({ seriesId, seasonNumber }, '[SearchOnAdd] Starting season search');

	try {
		const seriesData = await db.query.series.findFirst({
			where: eq(series.id, seriesId)
		});

		if (!seriesData) {
			return { success: false, error: 'Series not found' };
		}

		if (!bypassMonitoring && !seriesData.monitored) {
			logger.info(
				{
					seriesId,
					seasonNumber
				},
				'[SearchOnAdd] Skipping season search for unmonitored series'
			);
			return { success: true };
		}

		const seasonEpisodes = await db.query.episodes.findMany({
			where: and(eq(episodes.seriesId, seriesId), eq(episodes.seasonNumber, seasonNumber))
		});

		const indexerManager = await getIndexerManager();
		const searchSource: 'interactive' | 'automatic' = 'automatic';
		const indexerAvailability = evaluateIndexerSearchAvailability(
			await indexerManager.getIndexers(),
			{
				searchType: 'tv',
				searchSource,
				scoringProfileId: seriesData.scoringProfileId ?? undefined,
				getDefinitionCapabilities: (definitionId) =>
					indexerManager.getDefinitionCapabilities(definitionId)
			}
		);

		if (!indexerAvailability.ok) {
			const errorMessage = indexerAvailability.message || 'No indexers are available';
			logger.info(
				{
					seriesId,
					seasonNumber,
					code: indexerAvailability.code,
					message: errorMessage
				},
				'[SearchOnAdd] Season search blocked by indexer availability'
			);
			return { success: false, error: errorMessage };
		}

		const seriesSearchTitles = await altTitles.getSeriesSearchTitlesWithRefresh(
			seriesData.id,
			seriesData.tmdbId
		);
		const criteria: SearchCriteria = {
			searchType: 'tv',
			query: seriesData.title,
			tmdbId: seriesData.tmdbId,
			tvdbId: seriesData.tvdbId ?? undefined,
			imdbId: seriesData.imdbId ?? undefined,
			season: seasonNumber,
			searchTitles: seriesSearchTitles.length > 0 ? seriesSearchTitles : [seriesData.title]
		};

		const searchResult = await indexerManager.searchEnhanced(criteria, {
			searchSource,
			enrichment: {
				scoringProfileId: seriesData.scoringProfileId ?? undefined,
				filterRejected: true,
				minScore: AUTO_GRAB_MIN_SCORE
			}
		});

		logger.info(
			{
				seriesId,
				seasonNumber,
				totalResults: searchResult.releases.length,
				rejectedCount: searchResult.rejectedCount
			},
			'[SearchOnAdd] Season search completed'
		);

		if (searchResult.releases.length === 0) {
			logger.info(
				{
					seriesId,
					seasonNumber,
					title: `${seriesData.title} Season ${seasonNumber}`
				},
				'[SearchOnAdd] No suitable releases found for season'
			);
			return { success: false, error: 'No suitable releases found' };
		}

		for (const release of searchResult.releases) {
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
					episodeIds: seasonEpisodes.map((e) => e.id)
				},
				options: {
					force: false,
					skipBlocklist: false,
					allowSidegrade: false,
					isAutomatic: true,
					isUpgrade: true
				}
			});

			if (grabResult.success) {
				return {
					success: grabResult.success,
					releaseName: grabResult.success ? release.title : undefined,
					queueItemId: grabResult.download?.queueId,
					error: grabResult.error ?? (grabResult.success ? undefined : grabResult.decision?.reason)
				};
			}
		}

		logger.info(
			{
				seriesId,
				seasonNumber,
				reason: 'No releases pass majority benefit rule'
			},
			'[SearchOnAdd] No acceptable releases found for season'
		);
		return { success: false, error: 'No releases found that would benefit majority of episodes' };
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error(
			{
				seriesId,
				seasonNumber,
				err: error
			},
			'[SearchOnAdd] Season search failed'
		);
		return { success: false, error: message };
	}
}
