import { db } from '#lib/server/db/index.js';
import { series, episodes } from '#lib/server/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { resolveAllowedIndexerIds } from '#lib/server/indexers/search/profile-indexer-filter.js';
import { grabService } from '#lib/server/downloads/GrabService.js';
import type { SearchForSeasonParams, GrabResult } from './types.js';
import type { AltTitleRefresher } from './alt-titles.js';
import { preflightIndexerSearch, buildSearchCriteria, searchReleases } from './search-request.js';
import { toGrabRelease } from './grab-release.js';
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

		const searchSource: 'interactive' | 'automatic' = 'automatic';
		const gate = await preflightIndexerSearch({
			searchType: 'tv',
			searchSource,
			scoringProfileId: seriesData.scoringProfileId,
			allowedIndexerIds: await resolveAllowedIndexerIds(seriesData.scoringProfileId)
		});

		if (!gate.ok) {
			logger.info(
				{ seriesId, seasonNumber, code: gate.code, message: gate.error },
				'[SearchOnAdd] Season search blocked by indexer availability'
			);
			return { success: false, error: gate.error };
		}

		const { indexerManager } = gate;

		const seriesSearchTitles = await altTitles.getSeriesSearchTitlesWithRefresh(
			seriesData.id,
			seriesData.tmdbId
		);
		const criteria = buildSearchCriteria({
			searchType: 'tv',
			title: seriesData.title,
			tmdbId: seriesData.tmdbId,
			tvdbId: seriesData.tvdbId,
			imdbId: seriesData.imdbId,
			season: seasonNumber,
			searchTitles: seriesSearchTitles
		});

		const searchResult = await searchReleases(indexerManager, criteria, {
			searchSource,
			scoringProfileId: seriesData.scoringProfileId
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
			return { success: false, error: 'No suitable releases found', indexersQueried: 0 };
		}

		const indexersQueried = new Set(searchResult.releases.map((r) => r.indexerId)).size;

		for (const release of searchResult.releases) {
			const grabResult = await grabService.grab({
				release: toGrabRelease(release),
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
					error: grabResult.error ?? (grabResult.success ? undefined : grabResult.decision?.reason),
					indexerId: release.indexerId,
					indexerName: release.indexerName,
					indexersQueried
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
		return {
			success: false,
			error: 'No releases found that would benefit majority of episodes',
			indexersQueried
		};
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
