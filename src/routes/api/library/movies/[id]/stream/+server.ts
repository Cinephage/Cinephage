import { createSSEStream } from '#lib/server/sse.js';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { importService } from '#lib/server/downloadClients/import/index.js';
import { eventBuffer } from '#lib/server/sse/EventBuffer.js';
import { db } from '#lib/server/db/index.js';
import {
	movies,
	movieFiles,
	rootFolders,
	downloadQueue,
	subtitles
} from '#lib/server/db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import type { RequestHandler } from '@sveltejs/kit';
import type { LibraryMovie, MovieFile } from '#lib/types/library.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { tmdb } from '#lib/server/tmdb.js';
import { ACTIVE_DOWNLOAD_STATUSES } from '#lib/types/queue.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryMovieStreamApi', logDomain: 'scans' });

interface QueueItem {
	id: string;
	title: string;
	status: string;
	progress?: string;
}

interface FileImportedEvent {
	mediaType: 'movie';
	movieId: string;
	file: {
		id: string;
		relativePath: string;
		size: number;
		dateAdded: string;
		sceneName?: string;
		releaseGroup?: string;
		quality: MovieFile['quality'];
		mediaInfo: MovieFile['mediaInfo'];
		edition?: string;
	};
	wasUpgrade: boolean;
	replacedFileIds?: string[];
}

interface FileDeletedEvent {
	mediaType: 'movie';
	movieId: string;
	fileId: string;
}

/**
 * Get movie data for SSE initial state
 */
async function getMovieData(movieId: string): Promise<LibraryMovie | null> {
	const [movie] = await db
		.select({
			id: movies.id,
			tmdbId: movies.tmdbId,
			imdbId: movies.imdbId,
			title: movies.title,
			originalTitle: movies.originalTitle,
			year: movies.year,
			overview: movies.overview,
			posterPath: movies.posterPath,
			backdropPath: movies.backdropPath,
			runtime: movies.runtime,
			genres: movies.genres,
			path: movies.path,
			rootFolderId: movies.rootFolderId,
			rootFolderPath: rootFolders.path,
			scoringProfileId: movies.scoringProfileId,
			monitored: movies.monitored,
			minimumAvailability: movies.minimumAvailability,
			wantsSubtitles: movies.wantsSubtitles,
			added: movies.added,
			hasFile: movies.hasFile
		})
		.from(movies)
		.leftJoin(rootFolders, eq(movies.rootFolderId, rootFolders.id))
		.where(eq(movies.id, movieId));

	if (!movie) return null;

	const [files, movieSubtitles, releaseInfo] = await Promise.all([
		db.select().from(movieFiles).where(eq(movieFiles.movieId, movieId)),
		db
			.select({
				id: subtitles.id,
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
			.where(eq(subtitles.movieId, movieId)),
		tmdb.getMovieReleaseInfo(movie.tmdbId).catch((err) => {
			logger.warn(
				{
					movieId,
					tmdbId: movie.tmdbId,
					error: err instanceof Error ? err.message : String(err)
				},
				'[MovieStream] Failed to fetch TMDB release info'
			);
			return null;
		})
	]);

	return {
		...movie,
		tmdbStatus: releaseInfo?.status ?? null,
		releaseDate: releaseInfo?.release_date ?? null,
		added: movie.added ?? new Date().toISOString(),
		files: files.map((f) => ({
			id: f.id,
			relativePath: f.relativePath,
			size: f.size,
			dateAdded: f.dateAdded,
			quality: f.quality as MovieFile['quality'],
			mediaInfo: f.mediaInfo as MovieFile['mediaInfo'],
			releaseGroup: f.releaseGroup,
			edition: f.edition
		})),
		subtitles: movieSubtitles.map((s) => ({
			id: s.id,
			language: s.language,
			isForced: s.isForced ?? undefined,
			isHearingImpaired: s.isHearingImpaired ?? undefined,
			format: s.format ?? undefined,
			matchScore: s.matchScore,
			providerId: s.providerId,
			dateAdded: s.dateAdded,
			wasSynced: s.wasSynced ?? undefined,
			syncOffset: s.syncOffset
		}))
	};
}

/**
 * Get active queue item for movie
 */
async function getQueueItem(movieId: string): Promise<QueueItem | null> {
	const [queueItem] = await db
		.select({
			id: downloadQueue.id,
			title: downloadQueue.title,
			status: downloadQueue.status,
			progress: downloadQueue.progress
		})
		.from(downloadQueue)
		.where(
			and(
				eq(downloadQueue.movieId, movieId),
				inArray(downloadQueue.status, [...ACTIVE_DOWNLOAD_STATUSES])
			)
		);

	if (!queueItem) return null;

	return {
		id: queueItem.id,
		title: queueItem.title,
		status: queueItem.status ?? 'queued',
		progress: queueItem.progress ?? undefined
	};
}

/**
 * Server-Sent Events endpoint for real-time movie detail updates
 *
 * Events emitted:
 * - queue:sync - Current queue state after connect
 * - media:updated - Refetched movie state after metadata changes
 * - queue:added - New download added for this movie
 * - queue:updated - Queue item progress/status change
 * - file:added - New file imported
 * - file:removed - File deleted
 * - search:started - Movie search began
 * - search:completed - Movie search finished
 */
export const GET: RequestHandler = async ({ params }) => {
	const movieId = params.id;

	if (!movieId) {
		return new Response('Movie ID is required', { status: 400 });
	}

	return createSSEStream((send) => {
		const sendQueueSync = async () => {
			try {
				const queueItem = await getQueueItem(movieId);
				send('queue:sync', { queueItem });
				return queueItem;
			} catch (error) {
				logger.error({ err: error, movieId }, '[MovieStream] Failed to fetch queue sync');
				return null;
			}
		};

		const sendMovieUpdate = async () => {
			try {
				const [movie, queueItem] = await Promise.all([
					getMovieData(movieId),
					getQueueItem(movieId)
				]);

				if (movie) {
					send('media:updated', { movie, queueItem });
				}
			} catch (error) {
				logger.error({ err: error, movieId }, '[MovieStream] Failed to fetch movie update');
			}
		};

		// Sync queue state and replay buffered file events after connection is established.
		void sendQueueSync().then(() => {
			// Replay recent buffered events (handles race condition where events fired before connection)
			const recentEvents = eventBuffer.getRecentMovieEvents(movieId);
			logger.debug(
				{
					movieId,
					count: recentEvents.length
				},
				'[MovieStream] Replaying buffered events'
			);
			for (const event of recentEvents) {
				send('file:added', {
					file: event.file,
					wasUpgrade: event.wasUpgrade,
					replacedFileIds: event.replacedFileIds
				});
			}
		});

		// Handle new queue items added for this movie
		const onQueueAdded = (item: unknown) => {
			const typedItem = item as QueueItem & { movieId?: string };
			if (typedItem.movieId === movieId) {
				logger.debug(
					{
						movieId,
						queueItemId: typedItem.id
					},
					'[MovieStream] Queue item added for movie'
				);
				send('queue:added', {
					id: typedItem.id,
					title: typedItem.title,
					status: typedItem.status,
					progress: typedItem.progress ? parseFloat(typedItem.progress) : null
				});
			}
		};

		// Handle queue updates for this movie
		const onQueueUpdated = (item: unknown) => {
			const typedItem = item as QueueItem & { movieId?: string };
			if (typedItem.movieId === movieId) {
				send('queue:updated', {
					id: typedItem.id,
					title: typedItem.title,
					status: typedItem.status,
					progress: typedItem.progress ? parseFloat(typedItem.progress) : null
				});
			}
		};

		const onQueueRemoved = (id: string) => {
			send('queue:removed', { id });
		};

		// Handle file imports for this movie
		const onFileImported = (data: unknown) => {
			const typedData = data as FileImportedEvent;
			if (typedData.mediaType === 'movie' && typedData.movieId === movieId) {
				logger.debug(
					{
						movieId,
						fileId: typedData.file.id
					},
					'[MovieStream] File imported for movie'
				);
				send('file:added', {
					file: typedData.file,
					wasUpgrade: typedData.wasUpgrade,
					replacedFileIds: typedData.replacedFileIds
				});

				// If files were replaced, send deletion events
				if (typedData.replacedFileIds) {
					for (const replacedId of typedData.replacedFileIds) {
						send('file:removed', { fileId: replacedId });
					}
				}
			}
		};

		// Handle file deletions for this movie
		const onFileDeleted = (data: unknown) => {
			const typedData = data as FileDeletedEvent;
			if (typedData.mediaType === 'movie' && typedData.movieId === movieId) {
				send('file:removed', { fileId: typedData.fileId });
			}
		};

		// Handle metadata/subtitle/settings updates for this movie
		const onMovieUpdated = (event: { movieId: string }) => {
			if (event.movieId === movieId) {
				void sendMovieUpdate();
			}
		};

		// Handle search status updates
		const onMovieSearchStarted = (event: { movieId: string }) => {
			if (event.movieId === movieId) {
				send('search:started', { movieId });
			}
		};

		const onMovieSearchCompleted = (event: { movieId: string }) => {
			if (event.movieId === movieId) {
				send('search:completed', { movieId });
			}
		};

		// Register handlers
		downloadMonitor.on('queue:added', onQueueAdded);
		downloadMonitor.on('queue:updated', onQueueUpdated);
		downloadMonitor.on('queue:imported', onQueueUpdated);
		downloadMonitor.on('queue:removed', onQueueRemoved);
		importService.on('file:imported', onFileImported);
		importService.on('file:deleted', onFileDeleted);
		libraryMediaEvents.onMovieUpdated(onMovieUpdated);
		libraryMediaEvents.onMovieSearchStarted(onMovieSearchStarted);
		libraryMediaEvents.onMovieSearchCompleted(onMovieSearchCompleted);

		// Return cleanup function
		return () => {
			downloadMonitor.off('queue:added', onQueueAdded);
			downloadMonitor.off('queue:updated', onQueueUpdated);
			downloadMonitor.off('queue:imported', onQueueUpdated);
			downloadMonitor.off('queue:removed', onQueueRemoved);
			importService.off('file:imported', onFileImported);
			importService.off('file:deleted', onFileDeleted);
			libraryMediaEvents.offMovieUpdated(onMovieUpdated);
			libraryMediaEvents.offMovieSearchStarted(onMovieSearchStarted);
			libraryMediaEvents.offMovieSearchCompleted(onMovieSearchCompleted);
		};
	});
};
