import { setImmediate } from 'node:timers';
import { createChildLogger } from '#lib/logging/index.js';
import { db } from '#lib/server/db/index.js';
import { movies, rootFolders, series, taskHistory } from '#lib/server/db/schema.js';
import { inArray, eq } from 'drizzle-orm';
import { getTaskHistoryService } from '#lib/server/tasks/TaskHistoryService.js';
import { activityStreamEvents } from '#lib/server/activity/ActivityStreamEvents.js';
import { libraryMediaEvents } from './LibraryMediaEvents.js';
import { moveDirectoryWithinRoots } from '#lib/server/filesystem/move-helpers.js';
import { getMediaBrowserNotifier } from '#lib/server/notifications/mediabrowser/index.js';
import { getLibraryEntityService } from './LibraryEntityService.js';
import { libraryOperationLock } from './library-operation-lock.js';
import { diskScanService } from './disk-scan.js';

const logger = createChildLogger({ module: 'MediaMoveService' });

type MoveMediaKind = 'movie' | 'series';

export interface EnqueueMediaMoveInput {
	mediaType: MoveMediaKind;
	mediaId: string;
	mediaTitle: string;
	relativePath: string;
	sourceRootFolderId: string;
	destinationRootFolderId: string;
}

interface ParsedMoveTaskId {
	mediaType: MoveMediaKind;
	mediaId: string;
}

function buildMoveTaskId(mediaType: MoveMediaKind, mediaId: string): string {
	return `media-move:${mediaType}:${mediaId}`;
}

export function parseMoveTaskId(taskId: string): ParsedMoveTaskId | null {
	if (!taskId.startsWith('media-move:')) return null;
	const parts = taskId.split(':');
	if (parts.length !== 3) return null;
	const mediaType = parts[1];
	const mediaId = parts[2];
	if ((mediaType !== 'movie' && mediaType !== 'series') || !mediaId) return null;
	return { mediaType, mediaId };
}

class MediaMoveService {
	private static instance: MediaMoveService | null = null;

	static getInstance(): MediaMoveService {
		if (!MediaMoveService.instance) {
			MediaMoveService.instance = new MediaMoveService();
		}
		return MediaMoveService.instance;
	}

	async enqueueMove(input: EnqueueMediaMoveInput): Promise<{ taskId: string; historyId: string }> {
		const taskHistoryService = getTaskHistoryService();
		const taskId = buildMoveTaskId(input.mediaType, input.mediaId);

		const historyId = await taskHistoryService.startTask(taskId);
		await db
			.update(taskHistory)
			.set({
				results: {
					kind: 'media_move',
					mediaType: input.mediaType,
					mediaId: input.mediaId,
					mediaTitle: input.mediaTitle,
					sourceRootFolderId: input.sourceRootFolderId,
					destinationRootFolderId: input.destinationRootFolderId
				}
			})
			.where(eq(taskHistory.id, historyId));
		this.emitActivityRefresh();

		setImmediate(() => {
			void this.executeMoveTask(taskId, historyId, input);
		});

		return { taskId, historyId };
	}

	private async executeMoveTask(
		taskId: string,
		historyId: string,
		input: EnqueueMediaMoveInput
	): Promise<void> {
		return libraryOperationLock.withLock('move', () =>
			this.executeMoveTaskLocked(taskId, historyId, input)
		);
	}

	private async executeMoveTaskLocked(
		taskId: string,
		historyId: string,
		input: EnqueueMediaMoveInput
	): Promise<void> {
		const taskHistoryService = getTaskHistoryService();
		try {
			if (diskScanService.scanning) {
				throw new Error(
					'A library scan is in progress; the move was not started. Retry after the scan completes.'
				);
			}

			const folders = await db
				.select({
					id: rootFolders.id,
					path: rootFolders.path,
					readOnly: rootFolders.readOnly
				})
				.from(rootFolders)
				.where(inArray(rootFolders.id, [input.sourceRootFolderId, input.destinationRootFolderId]));

			const sourceRoot = folders.find((folder) => folder.id === input.sourceRootFolderId);
			const destinationRoot = folders.find((folder) => folder.id === input.destinationRootFolderId);

			if (!sourceRoot?.path || !destinationRoot?.path) {
				throw new Error('Source or destination root folder path is missing');
			}
			if (destinationRoot.readOnly) {
				throw new Error('Cannot move media to read-only root folder');
			}

			const moved = await moveDirectoryWithinRoots(
				sourceRoot.path,
				input.relativePath,
				destinationRoot.path
			);
			const destinationLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
				input.destinationRootFolderId,
				input.mediaType === 'movie' ? 'movie' : 'tv'
			);

			if (input.mediaType === 'movie') {
				await db
					.update(movies)
					.set({
						rootFolderId: input.destinationRootFolderId,
						libraryId: destinationLibrary.id
					})
					.where(eq(movies.id, input.mediaId));
				libraryMediaEvents.emitMovieUpdated(input.mediaId);
			} else {
				await db
					.update(series)
					.set({
						rootFolderId: input.destinationRootFolderId,
						libraryId: destinationLibrary.id
					})
					.where(eq(series.id, input.mediaId));
				libraryMediaEvents.emitSeriesUpdated(input.mediaId);
			}

			// The media physically moved roots, which no scan of either root will
			// fully explain (source scan sees a deletion, destination an addition).
			// Notify both paths as a rename so Jellyfin/Emby/Plex reconcile —
			// Deleted for the old path, Modified for the new one. Different paths,
			// so both survive the notifier's per-path dedup.
			const notifier = getMediaBrowserNotifier();
			notifier.queueUpdate(moved.sourcePath, 'Deleted', 'rename');
			notifier.queueUpdate(moved.destPath, 'Modified', 'rename');

			await taskHistoryService.completeTask(historyId, {
				kind: 'media_move',
				mediaType: input.mediaType,
				mediaId: input.mediaId,
				mediaTitle: input.mediaTitle,
				mode: moved.mode,
				sourcePath: moved.sourcePath,
				destPath: moved.destPath,
				sourceRootFolderId: input.sourceRootFolderId,
				destinationRootFolderId: input.destinationRootFolderId
			});

			logger.info(
				{
					taskId,
					historyId,
					mediaType: input.mediaType,
					mediaId: input.mediaId,
					mode: moved.mode
				},
				'[MediaMoveService] Root-folder move completed'
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown move error';
			await taskHistoryService.failTask(historyId, [message]);
			logger.error(
				{
					taskId,
					historyId,
					mediaType: input.mediaType,
					mediaId: input.mediaId,
					error: message
				},
				'[MediaMoveService] Root-folder move failed'
			);
		} finally {
			this.emitActivityRefresh();
		}
	}

	private emitActivityRefresh(): void {
		activityStreamEvents.emitRefresh({
			action: 'media_move',
			timestamp: new Date().toISOString()
		});
	}
}

export const mediaMoveService = MediaMoveService.getInstance();
