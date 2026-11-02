import { createSSEStream } from '#lib/server/sse.js';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { importService } from '#lib/server/downloadClients/import/index.js';
import { eventBuffer } from '#lib/server/sse/EventBuffer.js';
import { db } from '#lib/server/db/index.js';
import {
	series,
	seasons,
	episodes,
	episodeFiles,
	rootFolders,
	downloadQueue,
	subtitles
} from '#lib/server/db/schema.js';
import { eq, asc, inArray, and } from 'drizzle-orm';
import type { RequestHandler } from '@sveltejs/kit';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { ACTIVE_DOWNLOAD_STATUSES } from '#lib/types/queue.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibrarySeriesStreamApi', logDomain: 'scans' });

// Local type definitions
interface EpisodeFileInfo {
	id: string;
	relativePath: string;
	size: number | null;
	dateAdded: string | null;
	sceneName: string | null;
	releaseGroup: string | null;
	releaseType: string | null;
	quality: {
		resolution?: string;
		source?: string;
		codec?: string;
		hdr?: string;
	} | null;
	mediaInfo: {
		containerFormat?: string;
		videoCodec?: string;
		videoProfile?: string;
		videoBitrate?: number;
		videoBitDepth?: number;
		videoHdrFormat?: string;
		width?: number;
		height?: number;
		audioCodec?: string;
		audioChannels?: number;
		audioLanguages?: string[];
		subtitleLanguages?: string[];
	} | null;
	languages: string[] | null;
}

interface SubtitleInfo {
	id: string;
	language: string;
	isForced?: boolean;
	isHearingImpaired?: boolean;
	format?: string;
	matchScore?: number | null;
	providerId?: string | null;
	dateAdded?: string | null;
	wasSynced?: boolean;
	syncOffset?: number | null;
}

interface SeasonWithEpisodes {
	id: string;
	seasonNumber: number;
	name: string | null;
	overview: string | null;
	posterPath: string | null;
	airDate: string | null;
	monitored: boolean | null;
	episodeCount: number | null;
	episodeFileCount: number | null;
	episodes: Array<{
		id: string;
		tmdbId: number | null;
		tvdbId: number | null;
		seasonNumber: number;
		episodeNumber: number;
		absoluteEpisodeNumber: number | null;
		title: string | null;
		overview: string | null;
		airDate: string | null;
		runtime: number | null;
		monitored: boolean | null;
		hasFile: boolean | null;
		file: EpisodeFileInfo | null;
		subtitles?: SubtitleInfo[];
	}>;
}

interface QueueItem {
	id: string;
	title: string;
	status: string;
	progress?: string;
	episodeIds?: string[];
	seasonNumber?: number;
}

interface FileImportedEvent {
	mediaType: 'episode';
	seriesId: string;
	episodeIds: string[];
	seasonNumber: number;
	file: {
		id: string;
		relativePath: string;
		size: number;
		dateAdded: string;
		sceneName?: string;
		releaseGroup?: string;
		releaseType?: string;
		quality: EpisodeFileInfo['quality'];
		mediaInfo: EpisodeFileInfo['mediaInfo'];
		languages?: string[];
	};
	wasUpgrade: boolean;
	replacedFileIds?: string[];
}

interface FileDeletedEvent {
	mediaType: 'episode';
	seriesId: string;
	fileId: string;
	episodeIds: string[];
}

/**
 * Get series data with seasons and episodes for SSE initial state
 */
async function getSeriesData(seriesId: string) {
	const [seriesData] = await db
		.select({
			id: series.id,
			tmdbId: series.tmdbId,
			tvdbId: series.tvdbId,
			imdbId: series.imdbId,
			title: series.title,
			originalTitle: series.originalTitle,
			year: series.year,
			overview: series.overview,
			posterPath: series.posterPath,
			backdropPath: series.backdropPath,
			status: series.status,
			network: series.network,
			genres: series.genres,
			path: series.path,
			rootFolderId: series.rootFolderId,
			rootFolderPath: rootFolders.path,
			scoringProfileId: series.scoringProfileId,
			monitored: series.monitored,
			seasonFolder: series.seasonFolder,
			seriesType: series.seriesType,
			wantsSubtitles: series.wantsSubtitles,
			added: series.added,
			episodeCount: series.episodeCount,
			episodeFileCount: series.episodeFileCount
		})
		.from(series)
		.leftJoin(rootFolders, eq(series.rootFolderId, rootFolders.id))
		.where(eq(series.id, seriesId));

	if (!seriesData) return null;

	const percentComplete =
		seriesData.episodeCount && seriesData.episodeCount > 0
			? Math.round(((seriesData.episodeFileCount || 0) / seriesData.episodeCount) * 100)
			: 0;

	// Fetch all seasons
	const allSeasons = await db
		.select()
		.from(seasons)
		.where(eq(seasons.seriesId, seriesId))
		.orderBy(asc(seasons.seasonNumber));

	// Fetch all episodes
	const allEpisodes = await db
		.select()
		.from(episodes)
		.where(eq(episodes.seriesId, seriesId))
		.orderBy(asc(episodes.seasonNumber), asc(episodes.episodeNumber));

	// Fetch all episode files
	const allFiles = await db.select().from(episodeFiles).where(eq(episodeFiles.seriesId, seriesId));

	// Create a map of episode ID to file
	const episodeIdToFile = new Map<string, EpisodeFileInfo>();
	for (const file of allFiles) {
		const episodeIds = file.episodeIds as string[] | null;
		if (episodeIds) {
			for (const epId of episodeIds) {
				episodeIdToFile.set(epId, {
					id: file.id,
					relativePath: file.relativePath,
					size: file.size,
					dateAdded: file.dateAdded,
					sceneName: file.sceneName,
					releaseGroup: file.releaseGroup,
					releaseType: file.releaseType,
					quality: file.quality as EpisodeFileInfo['quality'],
					mediaInfo: file.mediaInfo as EpisodeFileInfo['mediaInfo'],
					languages: file.languages as string[] | null
				});
			}
		}
	}

	// Fetch subtitles for all episodes
	const episodeIds = allEpisodes.map((ep) => ep.id);
	const allSubtitles =
		episodeIds.length > 0
			? await db
					.select({
						id: subtitles.id,
						episodeId: subtitles.episodeId,
						language: subtitles.language,
						isForced: subtitles.isForced,
						isHearingImpaired: subtitles.isHearingImpaired,
						format: subtitles.format,
						matchScore: subtitles.matchScore,
						providerId: subtitles.providerId,
						dateAdded: subtitles.dateAdded,
						wasSynced: subtitles.wasSynced,
						syncOffset: subtitles.syncOffset
					})
					.from(subtitles)
					.where(inArray(subtitles.episodeId, episodeIds))
			: [];

	// Create a map of episode ID to subtitles
	const episodeIdToSubtitles = new Map<string, SubtitleInfo[]>();
	for (const sub of allSubtitles) {
		if (sub.episodeId) {
			const existing = episodeIdToSubtitles.get(sub.episodeId) || [];
			existing.push({
				id: sub.id,
				language: sub.language,
				isForced: sub.isForced ?? undefined,
				isHearingImpaired: sub.isHearingImpaired ?? undefined,
				format: sub.format ?? undefined,
				matchScore: sub.matchScore,
				providerId: sub.providerId,
				dateAdded: sub.dateAdded,
				wasSynced: sub.wasSynced ?? undefined,
				syncOffset: sub.syncOffset
			});
			episodeIdToSubtitles.set(sub.episodeId, existing);
		}
	}

	// Build seasons with episodes
	const seasonsWithEpisodes: SeasonWithEpisodes[] = allSeasons.map((season) => {
		const seasonEpisodes = allEpisodes
			.filter((ep) => ep.seasonNumber === season.seasonNumber)
			.map((ep) => ({
				id: ep.id,
				tmdbId: ep.tmdbId,
				tvdbId: ep.tvdbId,
				seasonNumber: ep.seasonNumber,
				episodeNumber: ep.episodeNumber,
				absoluteEpisodeNumber: ep.absoluteEpisodeNumber,
				title: ep.title,
				overview: ep.overview,
				airDate: ep.airDate,
				runtime: ep.runtime,
				monitored: ep.monitored,
				hasFile: ep.hasFile,
				file: episodeIdToFile.get(ep.id) || null,
				subtitles: episodeIdToSubtitles.get(ep.id) || []
			}));

		return {
			id: season.id,
			seasonNumber: season.seasonNumber,
			name: season.name,
			overview: season.overview,
			posterPath: season.posterPath,
			airDate: season.airDate,
			monitored: season.monitored,
			episodeCount: season.episodeCount,
			episodeFileCount: season.episodeFileCount,
			episodes: seasonEpisodes
		};
	});

	return {
		series: {
			...seriesData,
			added: seriesData.added ?? new Date().toISOString(),
			percentComplete
		},
		seasons: seasonsWithEpisodes
	};
}

/**
 * Get active queue items for series
 */
async function getQueueItems(seriesId: string): Promise<QueueItem[]> {
	const results = await db
		.select({
			id: downloadQueue.id,
			title: downloadQueue.title,
			status: downloadQueue.status,
			progress: downloadQueue.progress,
			episodeIds: downloadQueue.episodeIds,
			seasonNumber: downloadQueue.seasonNumber
		})
		.from(downloadQueue)
		.where(
			and(
				eq(downloadQueue.seriesId, seriesId),
				inArray(downloadQueue.status, [...ACTIVE_DOWNLOAD_STATUSES])
			)
		);

	return results.map((q) => ({
		id: q.id,
		title: q.title,
		status: q.status ?? 'queued',
		progress: q.progress ?? undefined,
		episodeIds: q.episodeIds as string[] | undefined,
		seasonNumber: q.seasonNumber ?? undefined
	}));
}

/**
 * Server-Sent Events endpoint for real-time series detail updates
 *
 * Events emitted:
 * - queue:sync - Current queue state after connect
 * - media:updated - Refetched series state after metadata changes
 * - queue:added - New download added for this series
 * - queue:updated - Queue item progress/status change
 * - file:added - New episode file imported
 * - file:removed - Episode file deleted
 * - search:started - Series search began
 * - search:completed - Series search finished
 */
export const GET: RequestHandler = async ({ params }) => {
	const seriesId = params.id;

	if (!seriesId) {
		return new Response('Series ID is required', { status: 400 });
	}

	return createSSEStream((send) => {
		// Concurrency control for server-side refresh snapshots to prevent race conditions
		// where multiple calls complete out of order and overwrite with stale data.
		let isFetchingMediaUpdate = false;
		let pendingVersion = 0;
		let lastSentVersion = 0;
		let queueSyncTime = 0;

		const sendQueueSync = async () => {
			try {
				const queueItems = await getQueueItems(seriesId);
				send('queue:sync', { queueItems });
				return queueItems;
			} catch (error) {
				logger.error({ err: error, seriesId }, '[SeriesStream] Failed to fetch queue sync');
				return [];
			}
		};

		const sendMediaUpdate = async (version: number = Date.now()) => {
			// If already fetching, just mark that we need another refresh with this version
			if (isFetchingMediaUpdate) {
				pendingVersion = Math.max(pendingVersion, version);
				logger.debug(
					{
						seriesId,
						version,
						pendingVersion
					},
					'[SeriesStream] Queuing refresh request'
				);
				return;
			}

			isFetchingMediaUpdate = true;
			try {
				logger.info({ seriesId, version }, '[SeriesStream] Fetching media update');
				const [data, queueItems] = await Promise.all([
					getSeriesData(seriesId),
					getQueueItems(seriesId)
				]);

				// Only send if this is still the latest request (not superseded by another)
				if (version >= lastSentVersion && data) {
					logger.info(
						{
							seriesId,
							version,
							episodeCount: data.seasons?.reduce((sum, s) => sum + (s.episodeFileCount || 0), 0)
						},
						'[SeriesStream] Sending media:updated'
					);
					send('media:updated', { ...data, queueItems });
					lastSentVersion = version;
				} else {
					logger.debug(
						{
							seriesId,
							version,
							lastSentVersion
						},
						'[SeriesStream] Skipping stale media:updated'
					);
				}
			} catch (error) {
				logger.error(
					{ err: error, seriesId, version },
					'[SeriesStream] Failed to fetch media update'
				);
			} finally {
				isFetchingMediaUpdate = false;

				// If another request was queued during our execution, process it now
				if (pendingVersion > version) {
					logger.info({ seriesId, pendingVersion }, '[SeriesStream] Processing queued refresh');
					const nextVersion = pendingVersion;
					pendingVersion = 0;
					void sendMediaUpdate(nextVersion);
				}
			}
		};

		// Sync queue state and replay buffered file events after connection is established.
		void sendQueueSync().then(() => {
			queueSyncTime = Date.now();

			// Replay recent buffered events (handles race condition where events fired before connection)
			// Only replay events that happened BEFORE queue sync completed.
			const recentEvents = eventBuffer.getRecentSeriesEvents(seriesId);
			logger.info(
				{
					seriesId,
					count: recentEvents.length,
					bufferSize: recentEvents.length
				},
				'[SeriesStream] Replaying buffered events'
			);
			for (const event of recentEvents) {
				// Skip events that happened after we started (they'll come through the live listener)
				if (event.timestamp > queueSyncTime) {
					logger.debug(
						{
							seriesId,
							episodeIds: event.episodeIds,
							timestamp: event.timestamp,
							fetchTime: queueSyncTime
						},
						'[SeriesStream] Skipping future event in replay'
					);
					continue;
				}
				logger.info(
					{
						seriesId,
						seasonNumber: event.seasonNumber,
						episodeIds: event.episodeIds
					},
					'[SeriesStream] Replaying buffered event'
				);
				send('file:added', {
					file: event.file,
					episodeIds: event.episodeIds,
					seasonNumber: event.seasonNumber,
					wasUpgrade: event.wasUpgrade,
					replacedFileIds: event.replacedFileIds
				});
			}
		});

		// Handle new queue items added for this series
		const onQueueAdded = (item: unknown) => {
			const typedItem = item as QueueItem & { seriesId?: string };
			if (typedItem.seriesId === seriesId) {
				logger.debug(
					{
						seriesId,
						queueItemId: typedItem.id
					},
					'[SeriesStream] Queue item added for series'
				);
				send('queue:added', {
					id: typedItem.id,
					title: typedItem.title,
					status: typedItem.status,
					progress: typedItem.progress ? parseFloat(typedItem.progress) : null,
					episodeIds: typedItem.episodeIds,
					seasonNumber: typedItem.seasonNumber
				});
			}
		};

		// Handle queue updates for this series
		const onQueueUpdated = (item: unknown) => {
			const typedItem = item as QueueItem & { seriesId?: string };
			if (typedItem.seriesId === seriesId) {
				send('queue:updated', {
					id: typedItem.id,
					title: typedItem.title,
					status: typedItem.status,
					progress: typedItem.progress ? parseFloat(typedItem.progress) : null,
					episodeIds: typedItem.episodeIds,
					seasonNumber: typedItem.seasonNumber
				});
			}
		};

		const onQueueRemoved = (id: string) => {
			send('queue:removed', { id });
		};

		// Handle file imports for this series
		const onFileImported = (data: unknown) => {
			const typedData = data as FileImportedEvent;
			if (typedData.mediaType === 'episode' && typedData.seriesId === seriesId) {
				logger.info(
					{
						seriesId,
						fileId: typedData.file.id,
						seasonNumber: typedData.seasonNumber,
						episodeIds: typedData.episodeIds,
						episodeCount: typedData.episodeIds?.length
					},
					'[SeriesStream] File imported event received, sending to client'
				);
				send('file:added', {
					file: typedData.file,
					episodeIds: typedData.episodeIds,
					seasonNumber: typedData.seasonNumber,
					wasUpgrade: typedData.wasUpgrade,
					replacedFileIds: typedData.replacedFileIds
				});

				// If files were replaced, send deletion events
				if (typedData.replacedFileIds) {
					for (const replacedId of typedData.replacedFileIds) {
						logger.info(
							{
								seriesId,
								replacedFileId: replacedId
							},
							'[SeriesStream] Sending replaced file removal event'
						);
						send('file:removed', { fileId: replacedId });
					}
				}
			}
		};

		// Handle file deletions for this series
		const onFileDeleted = (data: unknown) => {
			const typedData = data as FileDeletedEvent;
			if (typedData.mediaType === 'episode' && typedData.seriesId === seriesId) {
				send('file:removed', {
					fileId: typedData.fileId,
					episodeIds: typedData.episodeIds
				});
			}
		};

		// Handle metadata/subtitle/settings updates for this series
		const onSeriesUpdated = (event: { seriesId: string }) => {
			if (event.seriesId === seriesId) {
				logger.info({ seriesId }, '[SeriesStream] Series update triggered, refreshing state');
				// Pass a new version to ensure this refresh takes precedence over any in-flight refresh.
				void sendMediaUpdate(Date.now());
			}
		};

		// Handle search status updates
		const onSeriesSearchStarted = (event: { seriesId: string }) => {
			if (event.seriesId === seriesId) {
				send('search:started', { seriesId });
			}
		};

		const onSeriesSearchCompleted = (event: { seriesId: string }) => {
			if (event.seriesId === seriesId) {
				send('search:completed', { seriesId });
			}
		};

		// Register handlers
		downloadMonitor.on('queue:added', onQueueAdded);
		downloadMonitor.on('queue:updated', onQueueUpdated);
		downloadMonitor.on('queue:imported', onQueueUpdated);
		downloadMonitor.on('queue:removed', onQueueRemoved);
		importService.on('file:imported', onFileImported);
		importService.on('file:deleted', onFileDeleted);
		libraryMediaEvents.onSeriesUpdated(onSeriesUpdated);
		libraryMediaEvents.onSeriesSearchStarted(onSeriesSearchStarted);
		libraryMediaEvents.onSeriesSearchCompleted(onSeriesSearchCompleted);

		// Return cleanup function
		return () => {
			downloadMonitor.off('queue:added', onQueueAdded);
			downloadMonitor.off('queue:updated', onQueueUpdated);
			downloadMonitor.off('queue:imported', onQueueUpdated);
			downloadMonitor.off('queue:removed', onQueueRemoved);
			importService.off('file:imported', onFileImported);
			importService.off('file:deleted', onFileDeleted);
			libraryMediaEvents.offSeriesUpdated(onSeriesUpdated);
			libraryMediaEvents.offSeriesSearchStarted(onSeriesSearchStarted);
			libraryMediaEvents.offSeriesSearchCompleted(onSeriesSearchCompleted);
		};
	});
};
