/**
 * Search On Add - Series search logic
 */

import { resolveAllowedIndexerIds } from '#lib/server/indexers/search/profile-indexer-filter.js';
import { grabService } from '#lib/server/downloads/GrabService.js';
import { db } from '#lib/server/db/index.js';
import { episodes } from '#lib/server/db/schema.js';
import { and, eq, ne } from 'drizzle-orm';
import type { SearchForSeriesParams, GrabResult } from './types.js';
import type { AltTitleRefresher } from './alt-titles.js';
import { preflightIndexerSearch, buildSearchCriteria, searchReleases } from './search-request.js';
import { toGrabRelease } from './grab-release.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SearchSeries', logDomain: 'scans' });

export async function searchForSeries(
	params: SearchForSeriesParams,
	altTitles: AltTitleRefresher
): Promise<GrabResult> {
	const {
		seriesId,
		tmdbId,
		tvdbId,
		imdbId,
		title,
		year,
		scoringProfileId,
		monitorType,
		bypassMonitoring = false
	} = params;

	logger.info(
		{
			seriesId,
			tmdbId,
			title,
			year,
			monitorType
		},
		'[SearchOnAdd] Starting series search'
	);

	if (monitorType === 'none') {
		logger.info({ seriesId }, '[SearchOnAdd] Monitor type is none, skipping search');
		return { success: true };
	}

	try {
		const searchSource: 'interactive' | 'automatic' = 'automatic';
		const gate = await preflightIndexerSearch({
			searchType: 'tv',
			searchSource,
			scoringProfileId,
			allowedIndexerIds: await resolveAllowedIndexerIds(scoringProfileId)
		});

		if (!gate.ok) {
			logger.info(
				{ seriesId, code: gate.code, message: gate.error },
				'[SearchOnAdd] Series search blocked by indexer availability'
			);
			return { success: false, error: gate.error };
		}

		const { indexerManager } = gate;

		const seriesSearchTitles = await altTitles.getSeriesSearchTitlesWithRefresh(seriesId, tmdbId);
		const criteria = buildSearchCriteria({
			searchType: 'tv',
			title,
			tmdbId,
			tvdbId,
			imdbId,
			searchTitles: seriesSearchTitles
		});

		const searchResult = await searchReleases(indexerManager, criteria, {
			searchSource,
			scoringProfileId
		});

		logger.info(
			{
				seriesId,
				totalResults: searchResult.releases.length,
				rejectedCount: searchResult.rejectedCount
			},
			'[SearchOnAdd] Series search completed'
		);

		if (searchResult.releases.length === 0) {
			logger.info({ seriesId, title }, '[SearchOnAdd] No suitable releases found for series');
			return { success: false, error: 'No suitable releases found' };
		}

		if (
			monitorType === 'future' ||
			monitorType === 'missing' ||
			monitorType === 'existing' ||
			monitorType === 'recent'
		) {
			logger.info(
				{
					seriesId,
					monitorType
				},
				'[SearchOnAdd] Monitor type defers to scheduler, not auto-grabbing'
			);
			return { success: true };
		}

		const episodeConditions = [
			eq(episodes.seriesId, seriesId),
			eq(episodes.hasFile, false),
			ne(episodes.seasonNumber, 0)
		];
		if (!bypassMonitoring) episodeConditions.push(eq(episodes.monitored, true));
		const episodeIds = (await db.query.episodes.findMany({ where: and(...episodeConditions) })).map(
			(episode) => episode.id
		);
		if (episodeIds.length === 0) {
			logger.info(
				{ seriesId },
				'[SearchOnAdd] Series pack search has no missing episodes to target'
			);
			return { success: false, error: 'Series has no missing episodes to search' };
		}

		for (const release of searchResult.releases) {
			const grabResult = await grabService.grab({
				release: toGrabRelease(release),
				target: {
					type: 'series' as const,
					seriesId,
					episodeIds
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
				reason: 'No releases pass evaluation'
			},
			'[SearchOnAdd] No acceptable releases found for series'
		);
		return { success: false, error: 'No releases found that meet upgrade requirements' };
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ seriesId, err: error }, '[SearchOnAdd] Series search failed');
		return { success: false, error: message };
	}
}
