/**
 * Search On Add - episode search
 */

import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { series, episodes, episodeFiles } from '#lib/server/db/schema.js';
import { resolveAllowedIndexerIds } from '#lib/server/indexers/search/profile-indexer-filter.js';
import { grabService } from '#lib/server/downloads/GrabService.js';
import type { SearchForEpisodeParams, GrabResult } from './types.js';
import type { AltTitleRefresher } from './alt-titles.js';
import { preflightIndexerSearch, buildSearchCriteria, searchReleases } from './search-request.js';
import { toGrabRelease } from './grab-release.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SearchEpisode', logDomain: 'scans' });

export async function searchForEpisode(
	params: SearchForEpisodeParams,
	altTitles: AltTitleRefresher
): Promise<GrabResult> {
	const { episodeId, bypassMonitoring = false } = params;

	logger.info({ episodeId }, '[SearchOnAdd] Starting episode search');

	try {
		// Look up episode and series data
		const episode = await db.query.episodes.findFirst({
			where: eq(episodes.id, episodeId)
		});

		if (!episode) {
			return { success: false, error: 'Episode not found' };
		}

		const seriesData = await db.query.series.findFirst({
			where: eq(series.id, episode.seriesId)
		});

		if (!seriesData) {
			return { success: false, error: 'Series not found' };
		}

		if (!bypassMonitoring && !seriesData.monitored) {
			logger.info(
				{
					episodeId,
					seriesId: seriesData.id
				},
				'[SearchOnAdd] Skipping episode search for unmonitored series'
			);
			return { success: true };
		}

		// Check if episode already has a file
		// Episode files use episodeIds array, so we need to check if our episode is in any file
		const allEpisodeFiles = await db.query.episodeFiles.findMany({
			where: eq(episodeFiles.seriesId, episode.seriesId)
		});
		const existingFile = allEpisodeFiles.find((f) => f.episodeIds?.includes(episodeId));

		const hasExistingFile = !!existingFile;
		logger.debug({ episodeId, hasExistingFile }, '[SearchOnAdd] Episode file status');

		const searchSource: 'interactive' | 'automatic' = 'automatic';
		const gate = await preflightIndexerSearch({
			searchType: 'tv',
			searchSource,
			scoringProfileId: seriesData.scoringProfileId,
			allowedIndexerIds: await resolveAllowedIndexerIds(seriesData.scoringProfileId)
		});

		if (!gate.ok) {
			logger.info(
				{ episodeId, code: gate.code, message: gate.error },
				'[SearchOnAdd] Episode search blocked by indexer availability'
			);
			return { success: false, error: gate.error };
		}

		const { indexerManager } = gate;

		// Build search criteria with season and episode number
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
			season: episode.seasonNumber,
			episode: episode.episodeNumber,
			searchTitles: seriesSearchTitles
		});

		// Perform enriched search to get scored releases (automatic - on add)
		const searchResult = await searchReleases(indexerManager, criteria, {
			searchSource,
			scoringProfileId: seriesData.scoringProfileId
		});

		logger.info(
			{
				episodeId,
				seasonNumber: episode.seasonNumber,
				episodeNumber: episode.episodeNumber,
				totalResults: searchResult.releases.length,
				rejectedCount: searchResult.rejectedCount
			},
			'[SearchOnAdd] Episode search completed'
		);

		if (searchResult.releases.length === 0) {
			logger.info(
				{
					episodeId,
					title: `${seriesData.title} S${episode.seasonNumber.toString().padStart(2, '0')}E${episode.episodeNumber.toString().padStart(2, '0')}`
				},
				'[SearchOnAdd] No suitable releases found for episode'
			);
			return { success: false, error: 'No suitable releases found', indexersQueried: 0 };
		}

		const indexersQueried = new Set(searchResult.releases.map((r) => r.indexerId)).size;

		// If episode has existing file, filter to only upgrades
		if (hasExistingFile) {
			logger.info(
				{
					episodeId
				},
				'[SearchOnAdd] Episode has existing file, checking for upgrades'
			);

			// Find the first release that qualifies as an upgrade
			for (const release of searchResult.releases) {
				const grabResult = await grabService.grab({
					release: toGrabRelease(release),
					target: {
						type: 'episode' as const,
						episodeId,
						seriesId: seriesData.id
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
						error:
							grabResult.error ?? (grabResult.success ? undefined : grabResult.decision?.reason),
						indexerId: release.indexerId,
						indexerName: release.indexerName,
						indexersQueried
					};
				}
			}

			logger.info(
				{
					episodeId
				},
				'[SearchOnAdd] No upgrades found for episode with existing file'
			);
			return {
				success: false,
				error: 'No upgrades found - existing file quality is sufficient',
				indexersQueried
			};
		}

		// No existing file - grab the top-ranked release
		const bestRelease = searchResult.releases[0];
		const grabResult = await grabService.grab({
			release: {
				title: bestRelease.title,
				infoHash: bestRelease.infoHash,
				magnetUrl: bestRelease.magnetUrl,
				downloadUrl: bestRelease.downloadUrl,
				indexerId: bestRelease.indexerId,
				indexerName: bestRelease.indexerName,
				size: bestRelease.size,
				protocol: bestRelease.protocol as 'torrent' | 'usenet' | 'streaming' | undefined
			},
			target: {
				type: 'episode' as const,
				episodeId,
				seriesId: seriesData.id
			},
			options: {
				force: false,
				skipBlocklist: false,
				allowSidegrade: false,
				isAutomatic: true,
				isUpgrade: false
			}
		});

		return {
			success: grabResult.success,
			releaseName: grabResult.success ? bestRelease.title : undefined,
			queueItemId: grabResult.download?.queueId,
			error: grabResult.error ?? (grabResult.success ? undefined : grabResult.decision?.reason),
			indexerId: grabResult.success ? bestRelease.indexerId : undefined,
			indexerName: grabResult.success ? bestRelease.indexerName : undefined,
			indexersQueried
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ episodeId, err: error }, '[SearchOnAdd] Episode search failed');
		return { success: false, error: message };
	}
}
