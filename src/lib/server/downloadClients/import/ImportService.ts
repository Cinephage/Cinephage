/**
 * Import Service
 *
 * Handles importing completed downloads into the media library.
 * - Detects video files in download folder
 * - Hardlinks/copies to appropriate library folder
 * - Creates database records for imported files
 * - Handles upgrades (replaces existing lower-quality files)
 */

import { EventEmitter } from 'events';
import { stat } from 'fs/promises';
import { join, basename, dirname, extname, resolve } from 'path';
import { randomUUID } from 'node:crypto';
import { db } from '#lib/server/db/index.js';
import { eventBuffer } from '#lib/server/sse/EventBuffer.js';
import {
	downloadQueue,
	downloadHistory,
	movies,
	movieFiles,
	series,
	seasons,
	episodes,
	episodeFiles,
	rootFolders,
	downloadClients,
	importFailures,
	importOperations
} from '#lib/server/db/schema.js';
import { eq, and, or, inArray, gte } from 'drizzle-orm';
import { downloadMonitor } from '../monitoring/DownloadMonitorService';
import { resolveMovieMultiQuality } from '#lib/server/quality/movie-buckets.js';
import { computeMovieReplacement, computeEpisodeReplacement } from './replacement.js';
import { normalizeFilename } from '#lib/server/library/duplicates/DuplicateDetectionService.js';
import { contentAlreadyPresent } from '#lib/server/library/content-identity.js';
import type { Resolution } from '#lib/server/indexers/parser/types.js';
import {
	transferFileWithMode,
	findVideoFiles,
	ensureDirectory,
	fileExists,
	isVideoFile,
	hasSufficientDiskSpace,
	removeEmptyDirectories,
	moveToRecycleBin,
	deletePhysicalFile,
	copyExtraFiles,
	applyFilePermissions,
	ImportMode,
	type TransferResult,
	type TransferMode
} from './FileTransfer';
import { getDownloadClientManager } from '../DownloadClientManager';
import { joinCategoryPath } from '../core/client-utils.js';
import { unlink, rm, writeFile } from 'fs/promises';
import { unlinkSync } from 'node:fs';
import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import { mediaInfoService, MediaInfoService } from '#lib/server/library/media-info.js';
import {
	recalculateMovieShortfall,
	recalculateShortfallForEpisode
} from '#lib/server/languages/language-shortfall.js';
import {
	NamingService,
	releaseToNamingInfo,
	type MediaNamingInfo
} from '#lib/server/library/naming/NamingService.js';
import { namingSettingsService } from '#lib/server/library/naming/NamingSettingsService.js';
import { resolveAudioLanguages } from '#lib/server/library/naming/preview-metadata.js';
import { resolveLocalizedTitlesForFormats } from '#lib/server/library/naming/localization.js';
import { createChildLogger, runWithLogContext } from '#lib/logging/index.js';
import { todayDateString, formatBytes } from '#lib/utils/format.js';
import {
	DOWNLOAD,
	EXCLUDED_FILE_PATTERNS,
	DANGEROUS_EXTENSIONS,
	EXECUTABLE_EXTENSIONS
} from '#lib/config/constants.js';
import { ImportWorker, workerManager } from '#lib/server/workers/index.js';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { getFileManagementSettings } from '#lib/server/settings/file-management.js';
import { searchSubtitlesForNewMedia } from '#lib/server/subtitles/services/SubtitleImportService.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { getMediaBrowserNotifier } from '#lib/server/notifications/mediabrowser/index.js';
import { notifyMovieDownload, notifySeriesDownload } from '#lib/server/arr/notifications.js';
import { getOrAssignArrId } from '#lib/server/arr/ArrIdMappingService.js';
import { getSidecarSettings } from '#lib/server/library/sidecar/sidecarSettings.js';
import {
	buildMovieNfo,
	buildSeriesNfo,
	buildSeasonNfo,
	buildEpisodeNfo,
	nfoPathFor
} from '#lib/server/library/sidecar/NfoGenerator.js';
import {
	downloadSidecarImage,
	shouldWriteSidecar,
	tmdbImageUrl,
	movieArtworkPaths,
	seriesArtworkPaths,
	seasonArtworkPath,
	folderOf
} from '#lib/server/library/sidecar/SidecarImageService.js';
import { getMediaParseStem } from '#lib/server/library/media-utils.js';
import {
	matchEpisodesByIdentifier,
	matchEpisodesFromQueueContext as matchEpisodesFromQueueContextShared,
	resolveEpisodeIdentifierWithFallback as resolveEpisodeIdentifierWithFallbackShared,
	type ResolvedTvEpisodeIdentifier
} from '#lib/server/library/tv-episode-resolver.js';
import { isImportedQueueStatus, type QueueStatus } from '#lib/types/queue.js';

const logger = createChildLogger({ logDomain: 'imports' as const });

type ImportFailureStage =
	| 'path_resolution'
	| 'dangerous_files'
	| 'disk_space'
	| 'root_folder'
	| 'library_entity'
	| 'transfer'
	| 'max_retries';

type ImportFailureReason =
	| 'path_unavailable'
	| 'library_entity_missing'
	| 'root_folder_unavailable'
	| 'insufficient_disk_space'
	| 'dangerous_files_detected'
	| 'transfer_failed'
	| 'max_retries_exceeded'
	| 'no_linked_media';

/**
 * Surface a silent hardlink->copy fallback on the job's Activity log.
 *
 * transferFile() already warns at the file-log level (FileTransfer.ts), but
 * that's invisible from the Activity page; a copy instead of a hardlink
 * duplicates the file's full size on disk, so it needs to reach the same
 * place the user is already watching (GitHub #597).
 */
function warnIfHardlinkFellBackToCopy(
	worker: ImportWorker,
	transferResult: TransferResult,
	preferHardlink: boolean | undefined,
	sourcePath: string,
	destPath: string
): void {
	if (transferResult.mode !== 'copy' || !(preferHardlink ?? true)) return;

	worker.log(
		'warn',
		`Copied instead of hardlinked: ${basename(sourcePath)} (hardlink requested but unavailable on this filesystem; duplicates ${formatBytes(transferResult.sizeBytes ?? 0)} of disk space)`,
		{
			sourceDir: dirname(sourcePath),
			destDir: dirname(destPath),
			sizeBytes: transferResult.sizeBytes
		}
	);
}

async function recordImportFailure(opts: {
	releaseTitle: string;
	sourcePath?: string;
	destinationPath?: string;
	failureStage: ImportFailureStage;
	reason: ImportFailureReason;
	reasonDetail?: string;
	dangerousFiles?: Array<{ path: string; extension: string }>;
	attemptCount?: number;
	downloadClientId?: string | null;
	correlationId?: string;
}): Promise<void> {
	try {
		await db.insert(importFailures).values({
			id: randomUUID(),
			correlationId: opts.correlationId ?? randomUUID(),
			releaseTitle: opts.releaseTitle,
			sourcePath: opts.sourcePath ?? null,
			destinationPath: opts.destinationPath ?? null,
			failureStage: opts.failureStage,
			reason: opts.reason,
			reasonDetail: opts.reasonDetail ?? null,
			dangerousFiles: opts.dangerousFiles ?? null,
			attemptCount: opts.attemptCount ?? 1,
			downloadClientId: opts.downloadClientId ?? null,
			failedAt: new Date().toISOString(),
			status: 'failed'
		});
	} catch (err) {
		logger.warn({ err }, '[ImportService] Failed to persist import failure record');
	}
}

/**
 * Import result for a single file
 */
export interface ImportResult {
	success: boolean;
	sourcePath: string;
	destPath?: string;
	fileId?: string;
	error?: string;
	wasUpgrade?: boolean;
	replacedFileId?: string;
	replacedFileIds?: string[]; // For upgrades that delete multiple old files
	/** Episode ids this imported file covers (used for per-acquisition retirement). */
	episodeIds?: string[];
	sceneName?: string;
	releaseGroup?: string;
	quality?: {
		resolution?: string;
		source?: string;
		codec?: string;
		hdr?: string;
	};
	/** How the file reached its destination (hardlink/copy/move/symlink). */
	transferMode?: TransferMode;
}

/**
 * Import job result
 */
export interface ImportJobResult {
	success: boolean;
	queueItemId: string;
	importedFiles: ImportResult[];
	failedFiles: ImportResult[];
	totalSize: number;
	error?: string;
	failureStage?: ImportFailureStage;
	failureReason?: ImportFailureReason;
	dangerousFiles?: Array<{ path: string; extension: string }>;
}

interface ImportableFileOptions {
	allowStrmSmall?: boolean;
	preferNonStrm?: boolean;
	minimumFreeSpaceGb?: number;
	deleteEmptyFolders?: boolean;
	recycleEnabled?: boolean;
	extraFileExtensions?: string[];
	preferHardlink?: boolean;
	preservePermissions?: boolean;
	chmodFile?: string;
	effectiveImportMode?: ImportMode;
}

/**
 * Result of scanning for dangerous/executable files in a download
 * Following Radarr's DownloadedMovieImportService pattern
 * @see https://github.com/Radarr/Radarr/blob/develop/src/NzbDrone.Core/MediaFiles/DownloadedMovieImportService.cs
 */
interface DangerousFileResult {
	hasDangerousFiles: boolean;
	dangerousFiles: Array<{ path: string; extension: string; reason: 'dangerous' | 'executable' }>;
}

/**
 * Import retry configuration
 */
const MAX_IMPORT_ATTEMPTS = 10;
const IMPORT_RETRY_DELAY_MS = 30_000; // 30 seconds between retries

/**
 * Pending import info for retry tracking
 */
interface PendingImportInfo {
	attempts: number;
	lastAttempt: number;
	reason: string;
}

/**
 * Import request result
 */
export type ImportRequestResult =
	| { status: 'queued' }
	| { status: 'already_importing' }
	| { status: 'already_imported' }
	| { status: 'pending_retry'; reason: string }
	| { status: 'failed'; reason: string };

/**
 * Import Service
 *
 * Central service for importing completed downloads into the media library.
 * All import requests should go through this service to ensure proper
 * deduplication and sequential processing.
 */
export class ImportService extends EventEmitter {
	private static instance: ImportService | null = null;
	private parser: ReleaseParser;
	private isProcessing = false;
	private processingQueue: string[] = [];

	// Pending imports that need retry (e.g., SABnzbd path not ready yet)
	private pendingImports: Map<string, PendingImportInfo> = new Map();

	// Timer for retrying pending imports
	private retryTimer: ReturnType<typeof setInterval> | null = null;

	private constructor() {
		super();
		this.parser = new ReleaseParser();
	}

	private isAlreadyImportedStatus(status: QueueStatus | string | null | undefined): boolean {
		return status === 'imported' || status === 'seeding-imported';
	}

	static getInstance(): ImportService {
		if (!ImportService.instance) {
			ImportService.instance = new ImportService();
		}
		return ImportService.instance;
	}

	/** Reset the singleton instance (for testing) */
	static resetInstance(): void {
		if (ImportService.instance) {
			ImportService.instance.stop();
		}
		ImportService.instance = null;
	}

	/**
	 * Start the import service
	 * Sets up retry timer and checks for pending imports from previous runs.
	 */
	start(): void {
		logger.info('Starting import service');

		// Start retry timer for pending imports (e.g., SABnzbd path not ready)
		if (!this.retryTimer) {
			this.retryTimer = setInterval(() => {
				this.retryPendingImports().catch((err) => {
					logger.warn(
						{
							error: err instanceof Error ? err.message : String(err)
						},
						'Error retrying pending imports'
					);
				});
			}, IMPORT_RETRY_DELAY_MS);
		}

		// Check for any completed items that weren't imported (from previous runs)
		this.checkPendingImports();

		// Reconcile the import-operations journal (migration 149): finish or
		// flag interrupted imports so recovery is deterministic, never
		// inferred from queue percentages.
		this.reconcileImportOperations();
	}

	/**
	 * Deterministic recovery for interrupted imports:
	 *  - 'registered' with pending old files: retirement never completed —
	 *    retry each once; rows whose physical deletion fails stay (kept on
	 *    purpose) and the operation is flagged recovery_required.
	 *  - 'staged' (file transferred, never registered): nothing to
	 *    compensate deterministically — flagged for reports; the unregistered
	 *    destination file is left for DiskScan to reconcile.
	 */
	private reconcileImportOperations(): void {
		const unfinished = db
			.select()
			.from(importOperations)
			.where(inArray(importOperations.status, ['staged', 'registered']))
			.all();

		for (const op of unfinished) {
			try {
				if (op.status === 'registered' && (op.pendingOldFileIds ?? []).length > 0) {
					// Stale-plan guard: only retire when the replacement row this
					// journal recorded still exists. A later import/scanner may
					// have replaced it — retiring against a stale plan could
					// delete the last remaining copy.
					if (op.newFileId && !this.importOperationReplacementExists(op)) {
						db.update(importOperations)
							.set({
								status: 'recovery_required',
								error: 'replacement file no longer exists; retirement skipped to avoid data loss',
								updatedAt: new Date().toISOString()
							})
							.where(eq(importOperations.id, op.id));
						logger.warn(
							{ operationId: op.id, newFileId: op.newFileId },
							'[ImportService] Import journal replacement missing — retirement skipped'
						);
						continue;
					}

					const isEpisode = op.mediaType === 'episode';
					const stillPending: string[] = [];
					for (const fileId of op.pendingOldFileIds ?? []) {
						if (isEpisode) {
							const row = db
								.select({ id: episodeFiles.id, seriesId: episodeFiles.seriesId })
								.from(episodeFiles)
								.where(eq(episodeFiles.id, fileId))
								.limit(1)
								.all()[0];
							if (!row) continue; // already retired
							const retired = this.retireEpisodeFileNow(fileId, row.seriesId);
							if (!retired) stillPending.push(fileId);
						} else {
							const row = db
								.select({ id: movieFiles.id, movieId: movieFiles.movieId })
								.from(movieFiles)
								.where(eq(movieFiles.id, fileId))
								.limit(1)
								.all()[0];
							if (!row) continue; // already retired
							const retired = this.retireMovieFileNow(fileId, row.movieId);
							if (!retired) stillPending.push(fileId);
						}
					}

					db.update(importOperations)
						.set({
							status: stillPending.length > 0 ? 'recovery_required' : 'completed',
							failedOldFileIds: stillPending.length > 0 ? stillPending : null,
							completedAt: new Date().toISOString(),
							updatedAt: new Date().toISOString()
						})
						.where(eq(importOperations.id, op.id));

					logger.info(
						{
							operationId: op.id,
							resolved: (op.pendingOldFileIds ?? []).length - stillPending.length
						},
						'[ImportService] Completed interrupted retirement from journal'
					);
					continue;
				}

				// 'staged' or 'registered' without pending retires: surface for reports.
				db.update(importOperations)
					.set({
						status: 'recovery_required',
						error: 'interrupted before deterministic recovery was possible',
						updatedAt: new Date().toISOString()
					})
					.where(eq(importOperations.id, op.id));
			} catch (err) {
				logger.warn(
					{ operationId: op.id, err },
					'[ImportService] Failed to reconcile import operation'
				);
			}
		}
	}

	/** Whether the journal's recorded replacement row still exists. */
	private importOperationReplacementExists(op: typeof importOperations.$inferSelect): boolean {
		if (!op.newFileId) return true;
		if (op.mediaType === 'episode') {
			return (
				db
					.select({ id: episodeFiles.id })
					.from(episodeFiles)
					.where(eq(episodeFiles.id, op.newFileId))
					.limit(1)
					.all().length > 0
			);
		}
		return (
			db
				.select({ id: movieFiles.id })
				.from(movieFiles)
				.where(eq(movieFiles.id, op.newFileId))
				.limit(1)
				.all().length > 0
		);
	}

	/** Synchronous best-effort episode-file retirement used by journal recovery. */
	private retireEpisodeFileNow(fileId: string, seriesId: string): boolean {
		const row = db.select().from(episodeFiles).where(eq(episodeFiles.id, fileId)).limit(1).all()[0];
		if (!row) return true;

		const show = db
			.select({ path: series.path, rootFolderId: series.rootFolderId })
			.from(series)
			.where(eq(series.id, seriesId))
			.limit(1)
			.all()[0];
		if (!show?.rootFolderId) return false;

		const folder = db
			.select({ path: rootFolders.path })
			.from(rootFolders)
			.where(eq(rootFolders.id, show.rootFolderId))
			.limit(1)
			.all()[0];
		if (!folder) return false;

		const fullPath = join(folder.path, show.path, row.relativePath);
		try {
			unlinkSync(fullPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				logger.warn(
					{ fileId, path: fullPath, err },
					'[ImportService] Journal recovery could not delete old episode file - row kept'
				);
				return false;
			}
		}
		db.delete(episodeFiles).where(eq(episodeFiles.id, fileId));
		logger.info(
			{ fileId, path: fullPath },
			'[ImportService] Journal recovery retired old episode file'
		);
		return true;
	}

	/** Synchronous best-effort movie-file retirement used by journal recovery. */
	private retireMovieFileNow(fileId: string, movieId: string): boolean {
		const row = db.select().from(movieFiles).where(eq(movieFiles.id, fileId)).limit(1).all()[0];
		if (!row) return true;
		const movie = db.select().from(movies).where(eq(movies.id, movieId)).limit(1).all()[0];
		if (!movie?.rootFolderId) return false;
		const folder = db
			.select({ path: rootFolders.path })
			.from(rootFolders)
			.where(eq(rootFolders.id, movie.rootFolderId))
			.limit(1)
			.all()[0];
		if (!folder) return false;

		const fullPath = join(folder.path, movie.path, row.relativePath);
		try {
			unlinkSync(fullPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				logger.warn(
					{ fileId, path: fullPath, err },
					'[ImportService] Journal recovery could not delete old file - row kept'
				);
				return false;
			}
		}
		db.delete(movieFiles).where(eq(movieFiles.id, fileId));
		logger.info({ fileId, path: fullPath }, '[ImportService] Journal recovery retired old file');
		return true;
	}

	/**
	 * Stop the import service
	 */
	stop(): void {
		if (this.retryTimer) {
			clearInterval(this.retryTimer);
			this.retryTimer = null;
		}
		this.pendingImports.clear();
		this.processingQueue = [];
		logger.info('Stopped import service');
	}

	/**
	 * Check for downloads that completed but weren't imported
	 * This handles:
	 * - Usenet items with 'completed' status
	 * - Torrent items with 'paused' or 'seeding' status and 100% progress
	 *   (qBittorrent goes downloading -> seeding -> paused, never 'completed')
	 */
	private async checkPendingImports(): Promise<void> {
		// Find items that should have been imported:
		// 1. Status is 'completed' (usenet)
		// 2. Status is 'paused' or 'seeding' with progress >= 99% (torrents)
		const pendingItems = await db
			.select()
			.from(downloadQueue)
			.where(
				or(
					eq(downloadQueue.status, 'completed'),
					and(
						inArray(downloadQueue.status, ['paused', 'seeding']),
						gte(downloadQueue.progress, '0.99')
					)
				)
			);

		for (const item of pendingItems) {
			// Skip if no media linkage (can't import without knowing the target)
			if (!item.movieId && !item.seriesId) {
				continue;
			}
			// Skip if no output path
			if (!item.outputPath) {
				continue;
			}

			logger.info(
				{
					id: item.id,
					title: item.title,
					status: item.status,
					progress: item.progress
				},
				'Found pending import from previous run'
			);
			this.queueImport(item.id);
		}
	}

	/**
	 * Queue an import job (internal - skips validation)
	 */
	queueImport(queueItemId: string): void {
		if (!this.processingQueue.includes(queueItemId)) {
			this.processingQueue.push(queueItemId);
			this.processNext();
		}
	}

	/**
	 * Request an import for a completed download.
	 * This is the PRIMARY entry point for triggering imports from outside.
	 *
	 * Validates the download is ready for import (has valid path, not already
	 * importing, etc.) and either queues it or marks it for retry.
	 *
	 * @param queueItemId - ID of the queue item to import
	 * @returns Result indicating what action was taken
	 */
	async requestImport(queueItemId: string): Promise<ImportRequestResult> {
		// Check if already in processing queue
		if (this.processingQueue.includes(queueItemId)) {
			logger.debug({ queueItemId }, 'Import already queued');
			return { status: 'already_importing' };
		}

		// Get queue item from database
		const [queueItem] = await db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, queueItemId))
			.limit(1);

		if (!queueItem) {
			return { status: 'failed', reason: 'Queue item not found' };
		}

		// Don't import if already importing/imported
		if (queueItem.status === 'importing') {
			return { status: 'already_importing' };
		}
		if (this.isAlreadyImportedStatus(queueItem.status)) {
			this.pendingImports.delete(queueItemId);
			logger.debug(
				{
					queueItemId,
					status: queueItem.status
				},
				'Skipping import request for already imported item'
			);
			return { status: 'already_imported' };
		}

		// Need output path to import
		if (!queueItem.outputPath) {
			this.trackPendingImport(queueItemId, 'No output path');
			return { status: 'pending_retry', reason: 'No output path available' };
		}

		// Validate outputPath is not just the base download directory
		// SABnzbd queue items return empty paths initially, which map to just the base directory
		// This check prevents scanning the entire download folder
		const manager = getDownloadClientManager();
		const clients = await manager.getEnabledClients();
		const client = clients.find((c) => c.client.id === queueItem.downloadClientId);

		if (client?.client.downloadPathLocal) {
			const basePath = client.client.downloadPathLocal.replace(/\/+$/, '');
			const outputPath = queueItem.outputPath.replace(/\/+$/, '');

			// If outputPath equals the base path (or is shorter), it's invalid
			if (outputPath === basePath || outputPath.length <= basePath.length) {
				this.trackPendingImport(queueItemId, 'Invalid path - waiting for download client');
				return { status: 'pending_retry', reason: 'Path not ready yet' };
			}
		}

		// Defence in depth for #532: the download and temp roots and their
		// per-category staging roots are never a single download's import
		// source. Importing from one would scan (and move) every other
		// download under it.
		if (client && this.isRootLevelImportPath(queueItem.outputPath, client.client)) {
			this.trackPendingImport(queueItemId, 'Invalid path - waiting for download client');
			return { status: 'pending_retry', reason: 'Path not ready yet' };
		}

		// Path is valid, clear from pending and queue the import
		this.pendingImports.delete(queueItemId);

		logger.info(
			{
				queueId: queueItemId,
				title: queueItem.title,
				outputPath: queueItem.outputPath
			},
			'Queueing import for completed download'
		);

		this.queueImport(queueItemId);
		return { status: 'queued' };
	}

	/**
	 * True when the import path is a download-client root or one of its
	 * per-category staging roots - directories shared by many downloads that
	 * must never be treated as one download's import source (#532).
	 */
	private isRootLevelImportPath(
		outputPath: string,
		clientConfig: {
			downloadPathLocal?: string | null;
			tempPathLocal?: string | null;
			movieCategory?: string | null;
			tvCategory?: string | null;
		}
	): boolean {
		const roots: string[] = [];
		for (const base of [clientConfig.downloadPathLocal, clientConfig.tempPathLocal]) {
			if (!base) continue;
			roots.push(base);
			for (const category of [clientConfig.movieCategory, clientConfig.tvCategory]) {
				if (!category) continue;
				const joined = joinCategoryPath(base, category);
				if (joined) roots.push(joined);
			}
		}
		const target = resolve(outputPath.replace(/\/+$/, ''));
		return roots.some((root) => resolve(root.replace(/\/+$/, '')) === target);
	}

	/**
	 * Track a pending import that needs retry (path was invalid)
	 */
	private trackPendingImport(queueItemId: string, reason: string): void {
		const existing = this.pendingImports.get(queueItemId);
		const attempts = (existing?.attempts ?? 0) + 1;

		if (attempts > MAX_IMPORT_ATTEMPTS) {
			logger.error(
				{
					queueItemId,
					attempts,
					reason
				},
				'Max import retry attempts reached'
			);
			this.pendingImports.delete(queueItemId);
			// Mark as failed in the database
			downloadMonitor.markFailed(
				queueItemId,
				`Import failed after ${attempts} attempts: ${reason}`,
				{ terminalImport: true }
			);
			return;
		}

		this.pendingImports.set(queueItemId, {
			attempts,
			lastAttempt: Date.now(),
			reason
		});

		logger.info(
			{
				queueItemId,
				attempts,
				reason
			},
			'Tracking pending import for retry'
		);
	}

	/**
	 * Retry pending imports that are ready
	 */
	private async retryPendingImports(): Promise<void> {
		const now = Date.now();

		for (const [queueItemId, info] of this.pendingImports) {
			// Skip if already in processing queue
			if (this.processingQueue.includes(queueItemId)) {
				continue;
			}

			// Skip if not ready for retry yet
			if (now - info.lastAttempt < IMPORT_RETRY_DELAY_MS) {
				continue;
			}

			// Check if item still exists and is in valid state
			const [queueItem] = await db
				.select({ status: downloadQueue.status })
				.from(downloadQueue)
				.where(eq(downloadQueue.id, queueItemId))
				.limit(1);

			if (
				!queueItem ||
				this.isAlreadyImportedStatus(queueItem.status) ||
				queueItem.status === 'removed' ||
				queueItem.status === 'failed'
			) {
				// Item no longer exists or is in terminal state
				this.pendingImports.delete(queueItemId);
				continue;
			}

			logger.info(
				{
					queueItemId,
					attempt: info.attempts + 1,
					reason: info.reason
				},
				'Retrying pending import'
			);

			// Try to request import again (will validate path and queue if ready)
			await this.requestImport(queueItemId);
		}
	}

	/**
	 * Process the next import in queue
	 */
	private async processNext(): Promise<void> {
		if (this.isProcessing || this.processingQueue.length === 0) {
			return;
		}

		this.isProcessing = true;
		const queueItemId = this.processingQueue.shift()!;

		try {
			await this.processImport(queueItemId);
		} catch (error) {
			logger.error(
				{
					queueItemId,
					error: error instanceof Error ? error.message : String(error)
				},
				'Import processing error'
			);
		}

		this.isProcessing = false;
		this.processNext();
	}

	/**
	 * Process a single import
	 */
	async processImport(queueItemId: string): Promise<ImportJobResult> {
		const correlationId = randomUUID();
		return runWithLogContext(
			{ correlationId, requestId: correlationId, logDomain: 'imports' },
			() => this._processImport(queueItemId, correlationId)
		);
	}

	private async _processImport(
		queueItemId: string,
		correlationId: string
	): Promise<ImportJobResult> {
		logger.info({ queueItemId }, 'Processing import');

		// Get queue item
		const [queueItem] = await db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, queueItemId))
			.limit(1);

		if (!queueItem) {
			return {
				success: false,
				queueItemId,
				importedFiles: [],
				failedFiles: [],
				totalSize: 0,
				error: 'Queue item not found'
			};
		}

		// Check if already imported
		if (isImportedQueueStatus(queueItem.status)) {
			return {
				success: true,
				queueItemId,
				importedFiles: [],
				failedFiles: [],
				totalSize: 0,
				error: 'Already imported'
			};
		}

		// Load download client for import options (if available)
		const [client] = queueItem.downloadClientId
			? await db
					.select()
					.from(downloadClients)
					.where(eq(downloadClients.id, queueItem.downloadClientId))
					.limit(1)
			: [];
		const importOptions = this.getImportOptions(client, queueItem);

		// Create ImportWorker for tracking
		const mediaType = queueItem.movieId ? 'movie' : 'episode';
		const worker = new ImportWorker({
			queueItemId,
			mediaType,
			title: queueItem.title
		});

		try {
			workerManager.spawnInBackground(worker);
		} catch (e) {
			// Concurrency limit reached - continue without worker tracking
			logger.warn(
				{
					queueItemId,
					error: e instanceof Error ? e.message : String(e)
				},
				'Could not create import worker'
			);
		}

		// Mark as importing using atomic operation
		// This prevents race conditions where two processes try to import the same item
		const markResult = await downloadMonitor.markImporting(queueItemId);

		if (markResult === 'already_importing') {
			worker.fail('Already being imported by another process');
			return {
				success: false,
				queueItemId,
				importedFiles: [],
				failedFiles: [],
				totalSize: 0,
				error: 'Already being imported by another process'
			};
		}

		if (markResult === 'already_imported') {
			worker.complete({ imported: 0, failed: 0, totalSize: 0 });
			return {
				success: true,
				queueItemId,
				importedFiles: [],
				failedFiles: [],
				totalSize: 0,
				error: 'Already imported'
			};
		}

		if (markResult === 'max_attempts') {
			worker.fail('Max import attempts exceeded');
			recordImportFailure({
				releaseTitle: queueItem.title ?? queueItemId,
				failureStage: 'max_retries',
				reason: 'max_retries_exceeded',
				downloadClientId: queueItem.downloadClientId,
				correlationId
			});
			return {
				success: false,
				queueItemId,
				importedFiles: [],
				failedFiles: [],
				totalSize: 0,
				error: 'Max import attempts exceeded'
			};
		}

		if (markResult === 'not_found') {
			worker.fail('Queue item not found');
			return {
				success: false,
				queueItemId,
				importedFiles: [],
				failedFiles: [],
				totalSize: 0,
				error: 'Queue item not found'
			};
		}

		try {
			// Set source path
			const downloadPath = queueItem.outputPath || queueItem.clientDownloadPath;
			if (downloadPath) {
				worker.setSourcePath(downloadPath);
			}

			// Fetch download info from client to determine if we can move files
			// Seeding torrents can't be moved (canMoveFiles=false) - must use hardlink/copy
			// Usenet downloads can always be moved (canMoveFiles=true)
			// The global "Copy" setting overrides to always keep source files.
			const {
				importMode: globalImportMode,
				preferHardlink,
				minimumFreeSpaceGb,
				deleteEmptyFolders,
				recycleEnabled,
				extraFileExtensions,
				preservePermissions,
				chmodFile
			} = await getFileManagementSettings();
			importOptions.minimumFreeSpaceGb = minimumFreeSpaceGb;
			importOptions.deleteEmptyFolders = deleteEmptyFolders;
			importOptions.recycleEnabled = recycleEnabled;
			importOptions.extraFileExtensions = extraFileExtensions;
			importOptions.preferHardlink = preferHardlink;
			importOptions.preservePermissions = preservePermissions;
			importOptions.chmodFile = chmodFile;
			let canMoveFiles = globalImportMode === 'move'; // only move mode deletes the source
			const effectiveImportMode =
				globalImportMode === 'symlink' ? ImportMode.Symlink : ImportMode.Auto;
			importOptions.effectiveImportMode = effectiveImportMode;

			if (globalImportMode === 'move') {
				// Only check the download client's seeding state when the user wants moves
				if (client) {
					try {
						const clientManager = getDownloadClientManager();
						const clientInstance = await clientManager.getClientInstance(client.id);

						if (clientInstance) {
							const downloadId = queueItem.infoHash || queueItem.downloadId;
							const downloadInfo = await clientInstance.getDownload(downloadId);

							if (downloadInfo) {
								canMoveFiles = downloadInfo.canMoveFiles;
								logger.debug(
									{
										canMoveFiles,
										status: downloadInfo.status,
										protocol: queueItem.protocol,
										downloadId
									},
									'Determined import mode from download client'
								);
							}
						}
					} catch (err) {
						logger.warn(
							{
								error: err instanceof Error ? err.message : String(err),
								queueItemId
							},
							'Failed to get download info for import mode detection, defaulting to hardlink'
						);
						// If we can't determine, prefer hardlink/copy (safer for seeding)
						canMoveFiles = queueItem.protocol === 'usenet';
					}
				} else {
					// No client info, use protocol to guess
					canMoveFiles = queueItem.protocol === 'usenet';
				}
			}

			// Determine what to import based on linked media
			let result: ImportJobResult;
			if (queueItem.movieId) {
				result = await this.importMovie(queueItem, worker, importOptions, canMoveFiles);
			} else if (queueItem.seriesId) {
				result = await this.importSeries(queueItem, worker, importOptions, canMoveFiles);
			} else {
				throw new Error('No linked movie or series');
			}

			// Complete worker
			if (result.success) {
				worker.complete({
					imported: result.importedFiles.length,
					failed: result.failedFiles.length,
					totalSize: result.totalSize
				});
			} else {
				worker.fail(result.error || 'Import failed');
				// Persist import failure for diagnostic reports (fire-and-forget)
				const downloadPath = queueItem.outputPath || queueItem.clientDownloadPath;
				recordImportFailure({
					releaseTitle: queueItem.title ?? queueItem.id,
					sourcePath: downloadPath ?? undefined,
					failureStage: result.failureStage ?? 'transfer',
					reason: result.failureReason ?? 'transfer_failed',
					reasonDetail: result.error,
					dangerousFiles: result.dangerousFiles,
					downloadClientId: queueItem.downloadClientId,
					correlationId
				});
			}

			return result;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			await downloadMonitor.markFailed(queueItemId, errorMessage);
			worker.fail(errorMessage);

			// Persist the exception case
			recordImportFailure({
				releaseTitle: queueItemId,
				failureStage: 'transfer',
				reason: 'transfer_failed',
				reasonDetail: errorMessage,
				correlationId
			});

			return {
				success: false,
				queueItemId,
				importedFiles: [],
				failedFiles: [],
				totalSize: 0,
				error: errorMessage
			};
		}
	}

	/**
	 * Import a movie download
	 *
	 * @param queueItem - Queue item to import
	 * @param worker - Import worker for tracking
	 * @param importOptions - File detection options
	 * @param canMoveFiles - Whether files can be moved (false for seeding torrents)
	 */
	private async importMovie(
		queueItem: typeof downloadQueue.$inferSelect,
		worker: ImportWorker,
		importOptions: ImportableFileOptions,
		canMoveFiles: boolean
	): Promise<ImportJobResult> {
		const result: ImportJobResult = {
			success: false,
			queueItemId: queueItem.id,
			importedFiles: [],
			failedFiles: [],
			totalSize: 0
		};

		// Get movie info
		const [movie] = await db
			.select()
			.from(movies)
			.where(eq(movies.id, queueItem.movieId!))
			.limit(1);

		if (!movie) {
			result.error = 'Movie not found in library';
			result.failureStage = 'library_entity';
			result.failureReason = 'library_entity_missing';
			await downloadMonitor.markFailed(queueItem.id, result.error, { terminalImport: true });
			return result;
		}

		worker.log('info', `Importing movie: ${movie.title}`);

		// Get root folder
		const [rootFolder] = movie.rootFolderId
			? await db.select().from(rootFolders).where(eq(rootFolders.id, movie.rootFolderId)).limit(1)
			: [];

		if (!rootFolder) {
			result.error = 'Root folder not found';
			result.failureStage = 'root_folder';
			result.failureReason = 'root_folder_unavailable';
			await downloadMonitor.markFailed(queueItem.id, result.error, { terminalImport: true });
			return result;
		}

		// Check if root folder is read-only
		if (rootFolder.readOnly) {
			result.error = 'Cannot import to read-only root folder';
			result.failureStage = 'root_folder';
			result.failureReason = 'root_folder_unavailable';
			await downloadMonitor.markFailed(queueItem.id, result.error, { terminalImport: true });
			worker.log('error', 'Root folder is read-only, cannot import files');
			return result;
		}

		// Get download path
		const downloadPath = queueItem.outputPath || queueItem.clientDownloadPath;
		if (!downloadPath) {
			result.error = 'Download path not available';
			result.failureStage = 'path_resolution';
			result.failureReason = 'path_unavailable';
			await downloadMonitor.markFailed(queueItem.id, result.error);
			return result;
		}

		// Check for dangerous/executable files (malware protection)
		const dangerousScan = await this.scanForDangerousFiles(downloadPath);
		if (dangerousScan.hasDangerousFiles) {
			const fileList = dangerousScan.dangerousFiles
				.map((f) => `${basename(f.path)} (${f.extension})`)
				.join(', ');
			result.error = `Caution: Found potentially dangerous files: ${fileList}`;
			result.failureStage = 'dangerous_files';
			result.failureReason = 'dangerous_files_detected';
			result.dangerousFiles = dangerousScan.dangerousFiles;
			logger.warn(
				{
					downloadPath,
					dangerousFiles: dangerousScan.dangerousFiles
				},
				'Rejecting import due to dangerous files'
			);
			await downloadMonitor.markFailed(queueItem.id, result.error, { terminalImport: true });
			worker.log('error', result.error);
			return result;
		}

		// Find video files in download
		const videoFiles = await this.findImportableFiles(downloadPath, importOptions);

		if (videoFiles.length === 0) {
			result.error = 'No video files found in download';
			result.failureStage = 'path_resolution';
			result.failureReason = 'path_unavailable';
			await downloadMonitor.markFailed(queueItem.id, result.error);
			return result;
		}

		// Check for user-configured blocked video extensions
		const blockedExtCheck = await this.checkBlockedVideoExtensions(
			videoFiles,
			rootFolder.blockedVideoExtensions,
			queueItem
		);
		if (blockedExtCheck) {
			result.error = blockedExtCheck;
			result.failureStage = 'path_resolution';
			result.failureReason = 'path_unavailable';
			await downloadMonitor.markFailed(queueItem.id, result.error, { terminalImport: true });
			worker.log('error', result.error);
			return result;
		}

		worker.setTotalFiles(1); // Movies typically have 1 main file

		// For movies, typically take the largest file
		const mainFile = await this.resolveImportFile(
			videoFiles.sort((a, b) => b.size - a.size)[0],
			downloadPath,
			importOptions
		);

		if (!mainFile) {
			result.error = 'No importable files found in download';
			await downloadMonitor.markFailed(queueItem.id, result.error);
			return result;
		}

		// Build destination path
		const movieFolder = join(rootFolder.path, movie.path);
		const allowStrmProbe = movie.scoringProfileId !== 'streamer';
		const mediaInfo = await mediaInfoService.extractMediaInfo(mainFile.path, { allowStrmProbe });
		// A file ffprobe cannot read is not importable: it is still
		// downloading, corrupt, or a fragment adopted by mistake (#532).
		// STRM placeholders never reach here - they get synthetic info.
		const probeFailure = this.getMediaProbeFailure(mainFile.path, mediaInfo);
		if (probeFailure) {
			result.failedFiles.push(probeFailure);
			result.error = probeFailure.error;
			result.failureStage = 'path_resolution';
			result.failureReason = 'path_unavailable';
			worker.fileProcessed(basename(mainFile.path), false, probeFailure.error);
			await downloadMonitor.markFailed(queueItem.id, probeFailure.error!);
			return result;
		}
		const destFileName = await this.buildMovieFileName(movie, mainFile.path, queueItem, mediaInfo);
		let destPath = join(movieFolder, destFileName);

		// Check for existing file (upgrade scenario)
		const existingFiles = await db
			.select()
			.from(movieFiles)
			.where(eq(movieFiles.movieId, movie.id));

		// Content-identity guard (#598): the library may already have this
		// exact content under a different path/name (e.g. a re-grab, or an
		// unmatched download enrolled against a title it's already in).
		// Skip the physical transfer entirely and point the record at the
		// file that's already there instead of writing a duplicate.
		const isStrmFile = extname(mainFile.path).toLowerCase() === '.strm';
		const duplicateOf = existingFiles.find((file) =>
			contentAlreadyPresent(file, queueItem.infoHash, mainFile.size, mediaInfo, isStrmFile)
		);
		if (duplicateOf) {
			destPath = join(movieFolder, duplicateOf.relativePath);
		}

		// Grab-time upgrade flag is advisory only; the actual replacement is
		// recomputed from current state after the transfer (below).
		const isUpgrade = queueItem.isUpgrade || false;

		// Log upgrade detection but DON'T delete old files yet - wait until new file is imported
		if (existingFiles.some((file) => file.relativePath !== destFileName) && isUpgrade) {
			logger.info(
				{
					movieId: movie.id,
					existingCount: existingFiles.length
				},
				'Upgrade detected - will replace existing files after successful import'
			);
		}

		let transferResult: TransferResult;
		if (duplicateOf) {
			logger.info(
				{ movieId: movie.id, queueId: queueItem.id, existingFileId: duplicateOf.id },
				'Skipping transfer - identical content already in the library (#598)'
			);
			worker.log('info', `Already in library as ${basename(destPath)} - skipping transfer`);
			transferResult = {
				success: true,
				sourcePath: mainFile.path,
				destPath,
				mode: 'skip-duplicate',
				sizeBytes: duplicateOf.size ?? mainFile.size
			};
			worker.fileProcessed(basename(mainFile.path), true);
			worker.setDestinationPath(destPath);
		} else {
			// Check minimum free space on the destination before transferring
			const minFreeGb = importOptions.minimumFreeSpaceGb ?? 0;
			if (minFreeGb > 0) {
				const hasSpace = await hasSufficientDiskSpace(rootFolder.path, minFreeGb);
				if (!hasSpace) {
					const msg = `Insufficient disk space on destination: less than ${minFreeGb} GB free`;
					result.error = msg;
					result.failureStage = 'disk_space';
					result.failureReason = 'insufficient_disk_space';
					worker.log('error', msg);
					await downloadMonitor.markFailed(queueItem.id, msg);
					return result;
				}
			}

			// Transfer the file FIRST (keep old file until new one is successfully imported)
			// Use ImportMode.Auto to decide based on canMoveFiles:
			// - Seeding torrents (canMoveFiles=false): Use hardlink/copy to preserve source
			// - Usenet/completed (canMoveFiles=true): Use move for efficiency
			worker.log('info', `Transferring file to: ${destPath} (canMoveFiles=${canMoveFiles})`);
			const preserveSymlinks = rootFolder.preserveSymlinks ?? false;
			transferResult = await transferFileWithMode(mainFile.path, destPath, {
				importMode: importOptions.effectiveImportMode ?? ImportMode.Auto,
				canMoveFiles,
				preserveSymlinks,
				preferHardlink: importOptions.preferHardlink ?? true
			});

			if (!transferResult.success) {
				result.failedFiles.push({
					success: false,
					sourcePath: mainFile.path,
					error: transferResult.error
				});
				result.error = `Failed to transfer file: ${transferResult.error}`;
				result.failureStage = 'transfer';
				result.failureReason = 'transfer_failed';
				worker.fileProcessed(basename(mainFile.path), false, transferResult.error);
				await downloadMonitor.markFailed(queueItem.id, result.error);
				return result;
			}

			worker.fileTransferred(
				basename(mainFile.path),
				transferResult.mode === 'symlink'
					? 'symlink'
					: transferResult.mode === 'hardlink'
						? 'hardlink'
						: transferResult.mode === 'move'
							? 'move'
							: 'copy'
			);
			warnIfHardlinkFellBackToCopy(
				worker,
				transferResult,
				importOptions.preferHardlink,
				mainFile.path,
				destPath
			);
			worker.setDestinationPath(destPath);

			if (importOptions.deleteEmptyFolders && transferResult.mode === 'move') {
				await removeEmptyDirectories(dirname(mainFile.path), downloadPath);
			}

			if (transferResult.mode !== 'symlink') {
				await applyFilePermissions(
					destPath,
					mainFile.path,
					importOptions.preservePermissions ?? false,
					importOptions.chmodFile ?? ''
				);
			}

			if (importOptions.extraFileExtensions?.length) {
				await copyExtraFiles(
					dirname(mainFile.path),
					dirname(destPath),
					importOptions.extraFileExtensions,
					transferResult.mode === 'move',
					{
						preservePermissions: importOptions.preservePermissions ?? false,
						chmodFile: importOptions.chmodFile ?? ''
					}
				);
			}
		}

		const importedMetadata = this.buildImportedMetadata(queueItem, mainFile.path, mediaInfo);

		// Create or update file record (deduplication). A content-identity
		// match reuses the existing row's path, not the freshly computed name.
		const relativePath = duplicateOf ? duplicateOf.relativePath : destFileName;

		// Check if a file record already exists for this path (prevent duplicates)
		const existingFileRecord = duplicateOf
			? [duplicateOf]
			: existingFiles.filter((file) => file.relativePath === relativePath);

		const fileData = {
			movieId: movie.id,
			relativePath,
			size: transferResult.sizeBytes,
			dateAdded: new Date().toISOString(),
			sceneName: importedMetadata.sceneName,
			releaseGroup: importedMetadata.releaseGroup,
			edition: importedMetadata.edition,
			quality: importedMetadata.quality,
			mediaInfo,
			infoHash: queueItem.infoHash ?? undefined,
			filenameSignature: normalizeFilename(basename(relativePath))
		};

		let fileId: string;
		if (existingFileRecord.length > 0) {
			// Update existing record instead of creating duplicate
			fileId = existingFileRecord[0].id;
			await db.update(movieFiles).set(fileData).where(eq(movieFiles.id, fileId));
			logger.info({ movieId: movie.id, fileId }, 'Updated existing movie file record');
		} else {
			// Create new file record
			fileId = randomUUID();
			await db.insert(movieFiles).values({ id: fileId, ...fileData });
		}

		// Update movie hasFile flag
		await db.update(movies).set({ hasFile: true }).where(eq(movies.id, movie.id));

		// Audio-language verification (phase D): compare probed audio against
		// the effective preference and maintain the shortfall flag.
		await recalculateMovieShortfall(movie.id);

		result.totalSize = transferResult.sizeBytes || 0;
		result.success = true;

		// Mark as imported (protocol determines if it shows as 'seeding-imported' or 'imported')
		await downloadMonitor.markImported(
			queueItem.id,
			destPath,
			queueItem.protocol as 'torrent' | 'usenet'
		);

		// NOW delete old files (after successful import - so media is never missing).
		// Replacement is recomputed from CURRENT library state — the grab-time
		// isUpgrade flag is advisory only (it may be weeks stale). Reload the
		// movie's files: the pre-transfer snapshot can be outdated (scanner
		// activity during the transfer window).
		const currentFiles = await db.select().from(movieFiles).where(eq(movieFiles.movieId, movie.id));
		const { multiQuality } = await resolveMovieMultiQuality(
			movie.desiredQualities,
			movie.scoringProfileId
		);
		const newResolution = importedMetadata.quality?.resolution as Resolution | undefined;
		const replaceIdSet = new Set(
			computeMovieReplacement({
				existingFiles: currentFiles,
				newResolution,
				multiQuality,
				retire: true,
				keepFileIds: [fileId]
			})
		);

		// Journal the pending retirement BEFORE deleting: a crash here leaves a
		// 'registered' operation that startup recovery completes.
		const journalId = randomUUID();
		await db.insert(importOperations).values({
			id: journalId,
			queueId: queueItem.id,
			mediaType: 'movie',
			movieId: movie.id,
			protocol: queueItem.protocol,
			destinationPath: destPath,
			newFileId: fileId,
			pendingOldFileIds: [...replaceIdSet],
			status: 'registered'
		});

		const deletedFileIds: string[] = [];
		const failedDeleteIds: string[] = [];
		if (replaceIdSet.size > 0) {
			logger.info(
				{
					movieId: movie.id,
					existingCount: currentFiles.length,
					replaceCount: replaceIdSet.size,
					multiQuality
				},
				'Import successful - now deleting old files'
			);

			for (const oldFile of currentFiles) {
				// Only delete files selected for replacement by the bucket logic
				if (!replaceIdSet.has(oldFile.id)) continue;

				const deleteResult = await this.deleteMovieFile(
					oldFile.id,
					movie.id,
					importOptions.recycleEnabled
				);
				if (deleteResult.success) {
					logger.info(
						{
							movieId: movie.id,
							oldFileId: oldFile.id,
							oldPath: oldFile.relativePath
						},
						'Deleted old movie file after upgrade'
					);
					deletedFileIds.push(oldFile.id);
				} else {
					logger.warn(
						{
							movieId: movie.id,
							oldFileId: oldFile.id,
							error: deleteResult.error
						},
						'Failed to delete old movie file after upgrade'
					);
					failedDeleteIds.push(oldFile.id);
				}
			}
		}

		// Close the journal: completed, or recovery_required when physical
		// deletions failed (their rows were kept on purpose).
		await db
			.update(importOperations)
			.set({
				status: failedDeleteIds.length > 0 ? 'recovery_required' : 'completed',
				failedOldFileIds: failedDeleteIds.length > 0 ? failedDeleteIds : null,
				completedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			})
			.where(eq(importOperations.id, journalId));

		// State-based upgrade report: an import "was an upgrade" when it
		// actually retired existing files — not when a grab-time flag said so.
		const wasUpgrade = deletedFileIds.length > 0;

		result.importedFiles.push({
			success: true,
			sourcePath: mainFile.path,
			destPath,
			fileId,
			wasUpgrade,
			replacedFileIds: deletedFileIds.length > 0 ? deletedFileIds : undefined,
			sceneName: fileData.sceneName,
			releaseGroup: fileData.releaseGroup,
			transferMode: transferResult.mode,
			quality: fileData.quality
		});

		worker.fileProcessed(basename(destPath), true);
		if (wasUpgrade) {
			worker.upgrade('previous version', basename(destPath));
		}

		// Create history record
		await this.createHistoryRecord(queueItem, 'imported', {
			importedPath: destPath,
			movieFileId: fileId,
			title: fileData.sceneName,
			releaseGroup: fileData.releaseGroup,
			quality: fileData.quality,
			transferMode: transferResult.mode
		});

		logger.info(
			{
				movieId: movie.id,
				title: movie.title,
				destPath,
				wasUpgrade,
				replacedFiles: deletedFileIds.length
			},
			'Movie imported successfully'
		);

		// Emit event for SSE clients and buffer for replay
		const movieEvent = {
			mediaType: 'movie' as const,
			movieId: movie.id,
			importedPath: destPath,
			file: {
				id: fileId,
				relativePath: relativePath,
				size: transferResult.sizeBytes,
				dateAdded: fileData.dateAdded,
				sceneName: fileData.sceneName,
				releaseGroup: fileData.releaseGroup,
				quality: fileData.quality,
				mediaInfo,
				edition: fileData.edition
			},
			wasUpgrade,
			replacedFileIds: deletedFileIds.length > 0 ? deletedFileIds : undefined,
			timestamp: Date.now()
		};
		this.emit('file:imported', movieEvent);
		eventBuffer.add(movieEvent);
		libraryMediaEvents.emitMovieUpdated(movie.id);

		// Tell connected media servers (Jellyfin/Plex/Emby) about the new file.
		getMediaBrowserNotifier().queueUpdate(destPath, wasUpgrade ? 'Modified' : 'Created', 'import');

		// Tell any arr-compat clients (Pulsarr, Notifiarr, ...) that registered
		// a webhook - never let a slow/unreachable third-party endpoint delay
		// the import response.
		notifyMovieDownload({ title: movie.title, tmdbId: movie.tmdbId }).catch((err) => {
			logger.warn(
				{ movieId: movie.id, err: err instanceof Error ? err.message : String(err) },
				'Failed to notify arr-compat webhooks'
			);
		});

		// Optional sidecar files (.nfo + poster/fanart) - see NfoGenerator.ts /
		// SidecarImageService.ts for why this exists (Jellyfin never probes
		// .strm files during a scan, so a movie can otherwise sit with no
		// known resolution/duration indefinitely). Never let a write failure
		// here fail an otherwise-successful import.
		const sidecarSettings = getSidecarSettings();
		if (sidecarSettings.enabled) {
			try {
				const nfoPath = nfoPathFor(destPath);
				if (await shouldWriteSidecar(nfoPath, sidecarSettings.overwriteExisting)) {
					await writeFile(
						nfoPath,
						buildMovieNfo(movie, fileData, sidecarSettings.includeArtwork),
						'utf-8'
					);
				}

				if (sidecarSettings.includeArtwork) {
					const movieFolder = folderOf(destPath);
					const { poster, fanart } = movieArtworkPaths(movieFolder);
					await Promise.all([
						downloadSidecarImage(
							tmdbImageUrl(movie.posterPath),
							poster,
							sidecarSettings.overwriteExisting
						),
						downloadSidecarImage(
							tmdbImageUrl(movie.backdropPath),
							fanart,
							sidecarSettings.overwriteExisting
						)
					]);
				}
			} catch (err) {
				logger.warn(
					{ movieId: movie.id, err: err instanceof Error ? err.message : String(err) },
					'Failed to write sidecar files'
				);
			}
		}

		// Trigger subtitle search asynchronously (don't await to avoid blocking)
		this.triggerSubtitleSearch('movie', movie.id).catch((err) => {
			logger.warn(
				{
					movieId: movie.id,
					error: err instanceof Error ? err.message : String(err)
				},
				'[ImportService] Failed to trigger subtitle search for movie'
			);
		});

		// For usenet downloads, delete source folder (no seeding needed)
		// Skip when symlink mode is active; the library symlinks point at the source, so deleting it would break them
		// Skip when canMoveFiles=false; user has configured copy mode and wants to keep the source
		if (
			queueItem.protocol === 'usenet' &&
			queueItem.outputPath &&
			canMoveFiles &&
			importOptions.effectiveImportMode !== ImportMode.Symlink
		) {
			this.cleanupUsenetSource(queueItem.outputPath).catch((err) => {
				logger.warn(
					{
						outputPath: queueItem.outputPath,
						error: err instanceof Error ? err.message : String(err)
					},
					'[ImportService] Failed to cleanup usenet source'
				);
			});
		}

		return result;
	}

	/**
	 * Import a series/episode download
	 *
	 * @param queueItem - Queue item to import
	 * @param worker - Import worker for tracking
	 * @param importOptions - File detection options
	 * @param canMoveFiles - Whether files can be moved (false for seeding torrents)
	 */
	private async importSeries(
		queueItem: typeof downloadQueue.$inferSelect,
		worker: ImportWorker,
		importOptions: ImportableFileOptions,
		canMoveFiles: boolean
	): Promise<ImportJobResult> {
		const result: ImportJobResult = {
			success: false,
			queueItemId: queueItem.id,
			importedFiles: [],
			failedFiles: [],
			totalSize: 0
		};

		// Get series info
		const [seriesData] = await db
			.select()
			.from(series)
			.where(eq(series.id, queueItem.seriesId!))
			.limit(1);

		if (!seriesData) {
			result.error = 'Series not found in library';
			await downloadMonitor.markFailed(queueItem.id, result.error, { terminalImport: true });
			return result;
		}

		worker.log('info', `Importing series: ${seriesData.title}`);

		// Get root folder
		const [rootFolder] = seriesData.rootFolderId
			? await db
					.select()
					.from(rootFolders)
					.where(eq(rootFolders.id, seriesData.rootFolderId))
					.limit(1)
			: [];

		if (!rootFolder) {
			result.error = 'Root folder not found';
			await downloadMonitor.markFailed(queueItem.id, result.error, { terminalImport: true });
			return result;
		}

		// Check if root folder is read-only
		if (rootFolder.readOnly) {
			result.error = 'Cannot import to read-only root folder';
			await downloadMonitor.markFailed(queueItem.id, result.error, { terminalImport: true });
			worker.log('error', 'Root folder is read-only, cannot import files');
			return result;
		}

		// Get download path
		const downloadPath = queueItem.outputPath || queueItem.clientDownloadPath;
		if (!downloadPath) {
			result.error = 'Download path not available';
			await downloadMonitor.markFailed(queueItem.id, result.error);
			return result;
		}

		// Check for dangerous/executable files (malware protection)
		const dangerousScan = await this.scanForDangerousFiles(downloadPath);
		if (dangerousScan.hasDangerousFiles) {
			const fileList = dangerousScan.dangerousFiles
				.map((f) => `${basename(f.path)} (${f.extension})`)
				.join(', ');
			result.error = `Caution: Found potentially dangerous files: ${fileList}`;
			logger.warn(
				{
					downloadPath,
					dangerousFiles: dangerousScan.dangerousFiles
				},
				'Rejecting import due to dangerous files'
			);
			await downloadMonitor.markFailed(queueItem.id, result.error, { terminalImport: true });
			worker.log('error', result.error);
			return result;
		}

		// Check minimum free space on the destination before transferring
		const minFreeGbSeries = importOptions.minimumFreeSpaceGb ?? 0;
		if (minFreeGbSeries > 0) {
			const hasSpace = await hasSufficientDiskSpace(rootFolder.path, minFreeGbSeries);
			if (!hasSpace) {
				const msg = `Insufficient disk space on destination: less than ${minFreeGbSeries} GB free`;
				result.error = msg;
				worker.log('error', msg);
				await downloadMonitor.markFailed(queueItem.id, msg);
				return result;
			}
		}

		// Find video files
		const videoFiles = await this.findImportableFiles(downloadPath, importOptions);

		if (videoFiles.length === 0) {
			result.error = 'No video files found in download';
			await downloadMonitor.markFailed(queueItem.id, result.error);
			return result;
		}

		// Check for user-configured blocked video extensions
		const blockedExtCheck = await this.checkBlockedVideoExtensions(
			videoFiles,
			rootFolder.blockedVideoExtensions,
			queueItem
		);
		if (blockedExtCheck) {
			result.error = blockedExtCheck;
			await downloadMonitor.markFailed(queueItem.id, result.error, { terminalImport: true });
			worker.log('error', result.error);
			return result;
		}

		worker.setTotalFiles(videoFiles.length);

		// Per-acquisition retirement tracking (multi-file imports only).
		const deferRetirement = videoFiles.length > 1;
		const deferredEpisodeIds = new Set<string>();
		const deferredImportedFileIds = new Set<string>();

		// Process each video file
		const importedFileIds: string[] = [];

		for (const videoFile of videoFiles) {
			try {
				const resolvedFile = await this.resolveImportFile(videoFile, downloadPath, importOptions);
				if (!resolvedFile) {
					const errorMessage = 'Source file not found';
					result.failedFiles.push({
						success: false,
						sourcePath: videoFile.path,
						error: errorMessage
					});
					worker.fileProcessed(basename(videoFile.path), false, errorMessage);
					logger.warn(
						{
							seriesId: seriesData.id,
							seriesTitle: seriesData.title,
							sourcePath: videoFile.path,
							error: errorMessage
						},
						'Failed to import episode file'
					);
					continue;
				}

				const importResult = await this.importEpisodeFile(
					resolvedFile,
					seriesData,
					rootFolder,
					queueItem,
					canMoveFiles,
					worker,
					importOptions,
					deferRetirement
				);

				if (importResult.success) {
					result.importedFiles.push(importResult);
					result.totalSize += resolvedFile.size;
					if (importResult.fileId) {
						importedFileIds.push(importResult.fileId);
						deferredImportedFileIds.add(importResult.fileId);
					}
					if (importResult.episodeIds) {
						for (const episodeId of importResult.episodeIds) {
							deferredEpisodeIds.add(episodeId);
						}
					}
					worker.fileProcessed(basename(resolvedFile.path), true);
					if (importResult.wasUpgrade) {
						worker.upgrade(
							'previous version',
							basename(importResult.destPath || resolvedFile.path)
						);
					}
				} else {
					result.failedFiles.push(importResult);
					worker.fileProcessed(basename(videoFile.path), false, importResult.error);
					logger.warn(
						{
							seriesId: seriesData.id,
							seriesTitle: seriesData.title,
							sourcePath: importResult.sourcePath,
							error: importResult.error
						},
						'Failed to import episode file'
					);
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				result.failedFiles.push({
					success: false,
					sourcePath: videoFile.path,
					error: errorMessage
				});
				worker.fileProcessed(basename(videoFile.path), false, errorMessage);
				logger.error(
					{
						seriesId: seriesData.id,
						seriesTitle: seriesData.title,
						sourcePath: videoFile.path,
						error: errorMessage
					},
					'Exception while importing episode file'
				);
			}
		}

		// Consider success if at least one file imported
		result.success = result.importedFiles.length > 0;

		// Per-acquisition retirement (multi-file imports): retire old files only
		// after the WHOLE acquisition imported successfully, computed against
		// the union of episode ids the imported files cover. A pack replaced by
		// two single-episode files retires here; any failed file retires nothing
		// (never trade a stale duplicate for missing episodes).
		if (deferRetirement && result.failedFiles.length === 0 && deferredEpisodeIds.size > 0) {
			await this.retireFullyCoveredEpisodeFiles(
				seriesData,
				[...deferredEpisodeIds],
				deferredImportedFileIds,
				importOptions?.recycleEnabled,
				result.importedFiles[0]?.destPath ?? downloadPath
			);
		}

		if (result.success) {
			// Mark as imported (protocol determines if it shows as 'seeding-imported' or 'imported').
			// A single imported file is referenced directly; a multi-file batch
			// (season pack) reports the series folder instead of an arbitrary
			// one of its files, which would otherwise read as "imported to
			// episode 1" even when every episode imported successfully.
			const importedPath =
				result.importedFiles.length === 1
					? (result.importedFiles[0]?.destPath ?? downloadPath)
					: join(rootFolder.path, seriesData.path);
			const representativeImport = result.importedFiles.find((file) => file.success);
			await downloadMonitor.markImported(
				queueItem.id,
				importedPath,
				queueItem.protocol as 'torrent' | 'usenet'
			);

			// Create history record
			await this.createHistoryRecord(queueItem, 'imported', {
				importedPath,
				episodeFileIds: importedFileIds,
				title: representativeImport?.sceneName,
				releaseGroup: representativeImport?.releaseGroup,
				quality: representativeImport?.quality,
				transferMode: representativeImport?.transferMode
			});

			logger.info(
				{
					seriesId: seriesData.id,
					title: seriesData.title,
					importedCount: result.importedFiles.length,
					failedCount: result.failedFiles.length
				},
				'Series episodes imported'
			);

			// Trigger subtitle search for each imported episode asynchronously
			if (importedFileIds.length > 0) {
				this.triggerSubtitleSearchForEpisodeFiles(importedFileIds).catch((err) => {
					logger.warn(
						{
							seriesId: seriesData.id,
							error: err instanceof Error ? err.message : String(err)
						},
						'[ImportService] Failed to trigger subtitle search for episodes'
					);
				});
			}

			// Skip when symlink mode is active; the library symlinks point at the source, so deleting it would break them
			// Skip when canMoveFiles=false; user has configured copy mode and wants to keep the source
			if (
				queueItem.protocol === 'usenet' &&
				queueItem.outputPath &&
				canMoveFiles &&
				importOptions?.effectiveImportMode !== ImportMode.Symlink
			) {
				this.cleanupUsenetSource(queueItem.outputPath).catch((err) => {
					logger.warn(
						{
							outputPath: queueItem.outputPath,
							error: err instanceof Error ? err.message : String(err)
						},
						'[ImportService] Failed to cleanup usenet source'
					);
				});
			}
		} else {
			result.error = 'Failed to import any episodes';
			await downloadMonitor.markFailed(queueItem.id, result.error);
		}

		return result;
	}

	/**
	 * Import a single episode file
	 */
	private resolveEpisodeIdentifierWithFallback(
		videoFilePath: string,
		queueItem: Pick<typeof downloadQueue.$inferSelect, 'title' | 'seasonNumber'>,
		seriesType: 'standard' | 'anime' | 'daily'
	): ResolvedTvEpisodeIdentifier | null {
		const result = resolveEpisodeIdentifierWithFallbackShared(
			videoFilePath,
			{
				title: queueItem.title,
				seasonNumber: queueItem.seasonNumber
			},
			seriesType
		);

		if (!result) {
			return null;
		}

		if (result.source !== 'file') {
			logger.info(
				{
					sourcePath: videoFilePath,
					fallbackSource: result.source,
					fallbackToken: result.stem
				},
				'[ImportService] Resolved episode identifier from fallback context'
			);
		}

		return result.identifier;
	}

	private async importEpisodeFile(
		videoFile: { path: string; size: number },
		seriesData: typeof series.$inferSelect,
		rootFolder: typeof rootFolders.$inferSelect,
		queueItem: typeof downloadQueue.$inferSelect,
		canMoveFiles: boolean,
		worker: ImportWorker,
		importOptions?: ImportableFileOptions,
		/**
		 * Multi-file acquisitions defer retirement to a per-acquisition pass
		 * after every file imported (see retireFullyCoveredEpisodeFiles):
		 * retiring a pack on the first file of a multi-file acquisition could
		 * destroy episodes the later files have not delivered yet.
		 */
		deferRetirement = false
	): Promise<ImportResult> {
		const normalizedSeriesType =
			seriesData.seriesType === 'anime' || seriesData.seriesType === 'daily'
				? seriesData.seriesType
				: 'standard';

		// Parse episode info from filename/release context (fallbacks handle obfuscated basenames).
		const resolvedIdentifier = this.resolveEpisodeIdentifierWithFallback(
			videoFile.path,
			{
				title: queueItem.title,
				seasonNumber: queueItem.seasonNumber
			},
			normalizedSeriesType
		);

		if (!resolvedIdentifier) {
			return {
				success: false,
				sourcePath: videoFile.path,
				error: 'Could not parse episode info from filename'
			};
		}

		const seriesEpisodes = await db
			.select()
			.from(episodes)
			.where(eq(episodes.seriesId, seriesData.id));
		let matchingEpisodes = matchEpisodesByIdentifier(seriesEpisodes, resolvedIdentifier);
		if (matchingEpisodes.length === 0) {
			matchingEpisodes = this.matchEpisodesFromQueueContext(
				seriesEpisodes,
				queueItem,
				resolvedIdentifier
			);
		}
		if (matchingEpisodes.length === 0) {
			return {
				success: false,
				sourcePath: videoFile.path,
				error: 'Could not match imported file to an episode in the library'
			};
		}

		const seasonNum = matchingEpisodes[0].seasonNumber;
		const episodeNums = matchingEpisodes.map((episode) => episode.episodeNumber);
		const episodeIds = matchingEpisodes.map((episode) => episode.id);
		const firstEpisode = matchingEpisodes[0];
		const absoluteNumber =
			firstEpisode?.absoluteEpisodeNumber ??
			this.getFallbackAbsoluteEpisodeNumber(seriesEpisodes, firstEpisode?.id);

		// Build destination path
		const seriesFolder = join(rootFolder.path, seriesData.path);

		const allowStrmProbe = seriesData.scoringProfileId !== 'streamer';
		const mediaInfo = await mediaInfoService.extractMediaInfo(videoFile.path, { allowStrmProbe });
		// See importMovie: an unreadable file is a failed file, never an import.
		const probeFailure = this.getMediaProbeFailure(videoFile.path, mediaInfo);
		if (probeFailure) return probeFailure;

		// Check for existing files covering these episodes (upgrade scenario).
		// Hoisted ahead of the transfer so the content-identity guard (#598)
		// below can decide whether to skip it before anything touches disk.
		const existingFiles = await db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, seriesData.id));

		const destFileName = await this.buildEpisodeFileName(
			seriesData,
			seasonNum,
			episodeNums,
			videoFile.path,
			queueItem,
			firstEpisode?.title ?? undefined,
			absoluteNumber,
			firstEpisode?.airDate ?? undefined,
			mediaInfo
		);
		let relativePath = this.buildEpisodeRelativePath(
			seriesData.seasonFolder ?? true,
			seasonNum,
			destFileName,
			{
				title: seriesData.title,
				originalTitle: seriesData.originalTitle ?? undefined,
				year: seriesData.year ?? undefined,
				tmdbId: seriesData.tmdbId,
				tvdbId: seriesData.tvdbId ?? undefined,
				imdbId: seriesData.imdbId ?? undefined
			}
		);
		let destPath = join(seriesFolder, relativePath);

		// Content-identity guard (#598): see importMovie for the full
		// rationale. Reuse the existing row's path instead of transferring
		// a byte-identical duplicate. Restricted to files that already cover
		// one of THIS file's episodes - infoHash is release-level, not
		// file-level, and identical across every file of a multi-episode
		// acquisition, so without this an unrelated episode from the same
		// batch would be misread as a duplicate and have its row's
		// episodeIds clobbered onto this file's episode (issue #637).
		const isStrmFile = extname(videoFile.path).toLowerCase() === '.strm';
		const duplicateOf = existingFiles.find(
			(file) =>
				file.episodeIds?.some((id) => episodeIds.includes(id)) &&
				contentAlreadyPresent(file, queueItem.infoHash, videoFile.size, mediaInfo, isStrmFile)
		);
		if (duplicateOf) {
			relativePath = duplicateOf.relativePath;
			destPath = join(seriesFolder, relativePath);
		}

		let transferResult: TransferResult;
		if (duplicateOf) {
			logger.info(
				{ seriesId: seriesData.id, queueId: queueItem.id, existingFileId: duplicateOf.id },
				'Skipping transfer - identical content already in the library (#598)'
			);
			worker.log('info', `Already in library as ${basename(destPath)} - skipping transfer`);
			transferResult = {
				success: true,
				sourcePath: videoFile.path,
				destPath,
				mode: 'skip-duplicate',
				sizeBytes: duplicateOf.size ?? videoFile.size
			};
			worker.fileProcessed(basename(videoFile.path), true);
		} else {
			// Ensure season folder exists
			await ensureDirectory(dirname(destPath));

			// Transfer file using mode based on seeding state
			const preserveSymlinks = rootFolder.preserveSymlinks ?? false;
			transferResult = await transferFileWithMode(videoFile.path, destPath, {
				importMode: importOptions?.effectiveImportMode ?? ImportMode.Auto,
				canMoveFiles,
				preserveSymlinks,
				preferHardlink: importOptions?.preferHardlink ?? true
			});

			if (!transferResult.success) {
				return {
					success: false,
					sourcePath: videoFile.path,
					error: transferResult.error
				};
			}

			worker.fileTransferred(
				basename(videoFile.path),
				transferResult.mode === 'symlink'
					? 'symlink'
					: transferResult.mode === 'hardlink'
						? 'hardlink'
						: transferResult.mode === 'move'
							? 'move'
							: 'copy'
			);
			warnIfHardlinkFellBackToCopy(
				worker,
				transferResult,
				importOptions?.preferHardlink,
				videoFile.path,
				destPath
			);

			if (importOptions?.deleteEmptyFolders && transferResult.mode === 'move') {
				const downloadPath = queueItem.outputPath ?? queueItem.clientDownloadPath ?? '';
				if (downloadPath) {
					await removeEmptyDirectories(dirname(videoFile.path), downloadPath);
				}
			}

			if (transferResult.mode !== 'symlink') {
				await applyFilePermissions(
					destPath,
					videoFile.path,
					importOptions?.preservePermissions ?? false,
					importOptions?.chmodFile ?? ''
				);
			}

			if (importOptions?.extraFileExtensions?.length) {
				await copyExtraFiles(
					dirname(videoFile.path),
					dirname(destPath),
					importOptions.extraFileExtensions,
					transferResult.mode === 'move',
					{
						preservePermissions: importOptions?.preservePermissions ?? false,
						chmodFile: importOptions?.chmodFile ?? ''
					}
				);
			}
		}

		const importedMetadata = this.buildImportedMetadata(queueItem, videoFile.path, mediaInfo);

		// Check for existing files covering these episodes (upgrade scenario).
		// Coverage rule (acquisition redesign): a multi-episode file is only
		// retired when the incoming acquisition covers every episode it holds
		// — a single-episode upgrade must never orphan the rest of a pack.
		// .strm placeholders hold no exclusive content and always yield.
		const filesToReplace: string[] = computeEpisodeReplacement({
			existingFiles: existingFiles.map((file) => ({
				id: file.id,
				relativePath: file.relativePath,
				quality: file.quality,
				episodeIds: file.episodeIds
			})),
			incomingEpisodeIds: episodeIds,
			retireStrmPlaceholders: true
		}).filter((id) => {
			const file = existingFiles.find((f) => f.id === id);
			// The record for the same destination path is updated in place, not replaced.
			return file?.relativePath !== relativePath;
		});

		if (filesToReplace.length > 0) {
			logger.info(
				{
					seriesId: seriesData.id,
					seasonNumber: seasonNum,
					episodeNumbers: episodeNums,
					filesToReplace
				},
				'Import will replace overlapping episode file(s) per coverage rule'
			);
		}
		// Check if a file record already exists for this path (prevent duplicates)
		const existingFileRecord = existingFiles.filter((file) => file.relativePath === relativePath);

		let fileId: string;
		const fileData = {
			seriesId: seriesData.id,
			seasonNumber: seasonNum,
			episodeIds,
			relativePath,
			size: transferResult.sizeBytes,
			dateAdded: new Date().toISOString(),
			sceneName: importedMetadata.sceneName,
			releaseGroup: importedMetadata.releaseGroup,
			edition: importedMetadata.edition,
			releaseType: episodeNums.length > 1 ? 'multiEpisode' : 'singleEpisode',
			filenameSignature: normalizeFilename(basename(relativePath)),
			quality: importedMetadata.quality,
			mediaInfo,
			infoHash: queueItem.infoHash ?? undefined
		};

		if (existingFileRecord.length > 0) {
			// Update existing record instead of creating duplicate
			fileId = existingFileRecord[0].id;
			await db.update(episodeFiles).set(fileData).where(eq(episodeFiles.id, fileId));
			logger.info(
				{
					fileId,
					relativePath,
					seriesId: seriesData.id
				},
				'Updated existing episode file record'
			);
		} else {
			// Create new file record. On a unique (seriesId, relativePath)
			// conflict — a concurrent import registered the same path after
			// our snapshot — re-select the winning row; continuing with the
			// dangling UUID would attach history/events to a nonexistent row.
			fileId = randomUUID();
			await db
				.insert(episodeFiles)
				.values({
					id: fileId,
					...fileData
				})
				.onConflictDoNothing();

			const inserted = await db
				.select({ id: episodeFiles.id })
				.from(episodeFiles)
				.where(
					and(eq(episodeFiles.seriesId, seriesData.id), eq(episodeFiles.relativePath, relativePath))
				)
				.limit(1);
			if (!inserted[0]) {
				throw new Error(
					`Episode file registration failed: no row for ${relativePath} after insert`
				);
			}
			fileId = inserted[0].id;
		}

		// Update episode hasFile flags
		for (const episodeId of episodeIds) {
			await db.update(episodes).set({ hasFile: true }).where(eq(episodes.id, episodeId));
		}

		// Audio-language verification (phase D): episode files carry the
		// evidence; the flag lives on the owning series.
		await recalculateShortfallForEpisode(episodeIds[0]);

		// Emit event for SSE clients and buffer for replay
		const episodeEvent = {
			mediaType: 'episode' as const,
			seriesId: seriesData.id,
			episodeIds,
			seasonNumber: seasonNum,
			importedPath: destPath,
			file: {
				id: fileId,
				relativePath,
				size: transferResult.sizeBytes,
				dateAdded: fileData.dateAdded,
				sceneName: fileData.sceneName,
				releaseGroup: fileData.releaseGroup,
				edition: fileData.edition,
				releaseType: fileData.releaseType,
				quality: fileData.quality,
				mediaInfo,
				languages: undefined as string[] | undefined
			},
			wasUpgrade: filesToReplace.length > 0,
			replacedFileIds: filesToReplace.length > 0 ? filesToReplace : undefined,
			timestamp: Date.now()
		};
		this.emit('file:imported', episodeEvent);
		eventBuffer.add(episodeEvent);
		libraryMediaEvents.emitSeriesUpdated(seriesData.id);

		// See the movie import path above for why this exists.
		getMediaBrowserNotifier().queueUpdate(
			destPath,
			filesToReplace.length > 0 ? 'Modified' : 'Created',
			'import'
		);

		// See the movie import path above for why this exists.
		const episodeFileArrId = await getOrAssignArrId('episodeFile', fileId);
		notifySeriesDownload(
			{ title: seriesData.title, tvdbId: seriesData.tvdbId },
			matchingEpisodes.map((ep) => ({
				episodeNumber: ep.episodeNumber,
				seasonNumber: ep.seasonNumber,
				title: ep.title,
				overview: ep.overview,
				airDate: ep.airDate
			})),
			{
				id: episodeFileArrId,
				relativePath,
				quality:
					[fileData.quality?.resolution, fileData.quality?.source].filter(Boolean).join(' ') ||
					'Unknown',
				size: transferResult.sizeBytes ?? 0
			}
		).catch((err) => {
			logger.warn(
				{ seriesId: seriesData.id, err: err instanceof Error ? err.message : String(err) },
				'Failed to notify arr-compat webhooks'
			);
		});

		// Optional sidecar files - see NfoGenerator.ts / SidecarImageService.ts
		// / the movie import path above. TV has three independent levels
		// (episode .nfo, show-level tvshow.nfo + artwork, season poster) since
		// a single episode import shouldn't force rewriting all three every
		// time - most of a show's metadata only needs writing once.
		const sidecarSettings = getSidecarSettings();
		if (sidecarSettings.enabled) {
			if (sidecarSettings.tvEpisodeLevel) {
				try {
					const nfoPath = nfoPathFor(destPath);
					if (await shouldWriteSidecar(nfoPath, sidecarSettings.overwriteExisting)) {
						await writeFile(
							nfoPath,
							buildEpisodeNfo(seriesData, matchingEpisodes, fileData),
							'utf-8'
						);
					}
				} catch (err) {
					logger.warn(
						{ seriesId: seriesData.id, err: err instanceof Error ? err.message : String(err) },
						'Failed to write episode NFO sidecar'
					);
				}
			}

			if (sidecarSettings.tvSeriesLevel) {
				try {
					const tvshowNfoPath = join(seriesFolder, 'tvshow.nfo');
					if (await shouldWriteSidecar(tvshowNfoPath, sidecarSettings.overwriteExisting)) {
						await writeFile(
							tvshowNfoPath,
							buildSeriesNfo(seriesData, sidecarSettings.includeArtwork),
							'utf-8'
						);
					}

					if (sidecarSettings.includeArtwork) {
						const { poster, fanart } = seriesArtworkPaths(seriesFolder);
						await Promise.all([
							downloadSidecarImage(
								tmdbImageUrl(seriesData.posterPath),
								poster,
								sidecarSettings.overwriteExisting
							),
							downloadSidecarImage(
								tmdbImageUrl(seriesData.backdropPath),
								fanart,
								sidecarSettings.overwriteExisting
							)
						]);
					}
				} catch (err) {
					logger.warn(
						{ seriesId: seriesData.id, err: err instanceof Error ? err.message : String(err) },
						'Failed to write series-level sidecar files'
					);
				}
			}

			if (sidecarSettings.tvSeasonLevel) {
				try {
					const [seasonRow] = await db
						.select()
						.from(seasons)
						.where(and(eq(seasons.seriesId, seriesData.id), eq(seasons.seasonNumber, seasonNum)))
						.limit(1);

					if (seasonRow) {
						const seasonNfoPath = join(folderOf(destPath), 'season.nfo');
						if (await shouldWriteSidecar(seasonNfoPath, sidecarSettings.overwriteExisting)) {
							await writeFile(seasonNfoPath, buildSeasonNfo(seasonRow), 'utf-8');
						}

						if (sidecarSettings.includeArtwork && seasonRow.posterPath) {
							await downloadSidecarImage(
								tmdbImageUrl(seasonRow.posterPath),
								seasonArtworkPath(seriesFolder, seasonNum),
								sidecarSettings.overwriteExisting
							);
						}
					}
				} catch (err) {
					logger.warn(
						{
							seriesId: seriesData.id,
							seasonNumber: seasonNum,
							err: err instanceof Error ? err.message : String(err)
						},
						'Failed to write season-level sidecar files'
					);
				}
			}
		}

		// Delete old files if this was an upgrade. Deferred for multi-file
		// acquisitions (per-acquisition retirement after the whole import).
		if (!deferRetirement && filesToReplace.length > 0) {
			// Journal the pending retirement BEFORE deleting: a crash here leaves
			// a 'registered' operation that startup recovery completes. Mirrors
			// the movie path — episode imports are recoverable too.
			const journalId = randomUUID();
			await db.insert(importOperations).values({
				id: journalId,
				queueId: queueItem.id,
				mediaType: 'episode',
				seriesId: seriesData.id,
				episodeIds,
				protocol: queueItem.protocol,
				destinationPath: destPath,
				newFileId: fileId,
				pendingOldFileIds: filesToReplace,
				status: 'registered'
			});

			const failedDeleteIds: string[] = [];
			for (const oldFileId of filesToReplace) {
				const deleteResult = await this.deleteEpisodeFile(
					oldFileId,
					seriesData.id,
					importOptions?.recycleEnabled
				);
				if (deleteResult.success) {
					logger.info(
						{
							seriesId: seriesData.id,
							replacedFileId: oldFileId
						},
						'Successfully deleted old episode file during upgrade'
					);
				} else {
					logger.warn(
						{
							seriesId: seriesData.id,
							replacedFileId: oldFileId,
							error: deleteResult.error
						},
						'Failed to delete old episode file during upgrade'
					);
					failedDeleteIds.push(oldFileId);
				}
			}

			await db
				.update(importOperations)
				.set({
					status: failedDeleteIds.length > 0 ? 'recovery_required' : 'completed',
					failedOldFileIds: failedDeleteIds.length > 0 ? failedDeleteIds : null,
					completedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString()
				})
				.where(eq(importOperations.id, journalId));
		}

		// Update series stats
		await this.updateSeriesStats(seriesData.id);

		return {
			success: true,
			sourcePath: videoFile.path,
			destPath,
			fileId,
			episodeIds,
			wasUpgrade: filesToReplace.length > 0,
			replacedFileId: filesToReplace.length > 0 ? filesToReplace[0] : undefined,
			sceneName: fileData.sceneName,
			releaseGroup: fileData.releaseGroup,
			quality: fileData.quality,
			transferMode: transferResult.mode
		};
	}

	/**
	 * Per-acquisition retirement pass for multi-file episode imports.
	 *
	 * Retires existing episode files whose ENTIRE episode coverage is preserved
	 * by the union of episodes the just-imported files deliver (the shared
	 * `computeEpisodeReplacement` coverage rule, state-based and recomputed
	 * against files reloaded at this moment). Called only when every file of
	 * the acquisition imported successfully.
	 */
	private async retireFullyCoveredEpisodeFiles(
		seriesData: typeof series.$inferSelect,
		incomingEpisodeIds: string[],
		keepFileIds: Set<string>,
		recycleEnabled: boolean | undefined,
		destinationPath: string
	): Promise<void> {
		const currentFiles = await db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, seriesData.id));

		const toRetire = computeEpisodeReplacement({
			existingFiles: currentFiles.map((file) => ({
				id: file.id,
				relativePath: file.relativePath,
				quality: file.quality,
				episodeIds: file.episodeIds
			})),
			incomingEpisodeIds,
			keepFileIds: [...keepFileIds],
			retireStrmPlaceholders: true
		});

		if (toRetire.length === 0) return;

		logger.info(
			{
				seriesId: seriesData.id,
				incomingEpisodes: incomingEpisodeIds.length,
				retireCount: toRetire.length
			},
			'Per-acquisition retirement: removing fully covered old episode files'
		);

		// Journal before any deletion so a crash mid-pass is recoverable.
		const journalId = randomUUID();
		await db.insert(importOperations).values({
			id: journalId,
			mediaType: 'episode',
			seriesId: seriesData.id,
			episodeIds: incomingEpisodeIds,
			destinationPath,
			pendingOldFileIds: toRetire,
			status: 'registered'
		});

		const failedDeleteIds: string[] = [];
		for (const oldFileId of toRetire) {
			const deleteResult = await this.deleteEpisodeFile(
				oldFileId,
				seriesData.id,
				recycleEnabled ?? false
			);
			if (deleteResult.success) {
				logger.info(
					{ seriesId: seriesData.id, replacedFileId: oldFileId },
					'Retired old episode file after full-acquisition import'
				);
			} else {
				logger.warn(
					{
						seriesId: seriesData.id,
						replacedFileId: oldFileId,
						error: deleteResult.error
					},
					'Failed to retire old episode file after full-acquisition import'
				);
				failedDeleteIds.push(oldFileId);
			}
		}

		await db
			.update(importOperations)
			.set({
				status: failedDeleteIds.length > 0 ? 'recovery_required' : 'completed',
				failedOldFileIds: failedDeleteIds.length > 0 ? failedDeleteIds : null,
				completedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			})
			.where(eq(importOperations.id, journalId));

		await this.updateSeriesStats(seriesData.id);
	}

	/**
	 * Fallback matcher for releases that reset season episode numbering (e.g., E01..E16)
	 * while the library stores global episode numbers for that season (e.g., E62..E77).
	 *
	 * Uses queueItem.episodeIds ordering context to map parsed episode indices.
	 */
	private matchEpisodesFromQueueContext(
		seriesEpisodes: Array<typeof episodes.$inferSelect>,
		queueItem: Pick<typeof downloadQueue.$inferSelect, 'episodeIds' | 'seasonNumber'>,
		identifier: ResolvedTvEpisodeIdentifier
	): Array<typeof episodes.$inferSelect> {
		return matchEpisodesFromQueueContextShared(
			seriesEpisodes,
			{
				episodeIds: queueItem.episodeIds,
				seasonNumber: queueItem.seasonNumber
			},
			identifier
		);
	}

	/**
	 * Find importable video files in a directory
	 */
	private async findImportableFiles(
		downloadPath: string,
		options: ImportableFileOptions
	): Promise<Array<{ path: string; size: number }>> {
		const files: Array<{ path: string; size: number }> = [];

		try {
			const stats = await stat(downloadPath);

			if (stats.isFile()) {
				// Single file download
				if (this.isImportableFile(downloadPath, stats.size, options)) {
					files.push({ path: downloadPath, size: stats.size });
				}
			} else if (stats.isDirectory()) {
				// Directory - find all video files
				const videoFiles = await findVideoFiles(downloadPath);

				for (const filePath of videoFiles) {
					try {
						const fileStats = await stat(filePath);
						if (this.isImportableFile(filePath, fileStats.size, options)) {
							files.push({ path: filePath, size: fileStats.size });
						}
					} catch {
						// Skip files we can't stat
					}
				}
			}
		} catch (error) {
			logger.error(
				{
					downloadPath,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to scan download path'
			);
		}

		if (options.preferNonStrm) {
			const hasNonStrm = files.some((file) => extname(file.path).toLowerCase() !== '.strm');
			if (hasNonStrm) {
				return files.filter((file) => extname(file.path).toLowerCase() !== '.strm');
			}
		}

		return files;
	}

	private getImportOptions(
		client?: typeof downloadClients.$inferSelect,
		queueItem?: Pick<typeof downloadQueue.$inferSelect, 'outputPath' | 'clientDownloadPath'>
	): ImportableFileOptions {
		const isMountModeClient =
			client?.implementation === 'sabnzbd' &&
			(client?.mountMode === 'nzbdav' || client?.mountMode === 'altmount');
		const hasDirectStrmPath = [queueItem?.outputPath, queueItem?.clientDownloadPath].some(
			(path) => path?.toLowerCase().endsWith('.strm') ?? false
		);
		return {
			allowStrmSmall: isMountModeClient || hasDirectStrmPath,
			preferNonStrm: isMountModeClient
		};
	}

	private async resolveImportFile(
		file: { path: string; size: number },
		downloadPath: string,
		options: ImportableFileOptions
	): Promise<{ path: string; size: number } | null> {
		if (await fileExists(file.path)) {
			return file;
		}

		if (!options.allowStrmSmall) {
			return null;
		}

		const ext = extname(file.path).toLowerCase();
		if (ext !== '.strm') {
			return null;
		}

		const refreshed = await this.findImportableFiles(downloadPath, options);
		const candidate =
			refreshed.find((item) => extname(item.path).toLowerCase() === '.strm') ?? refreshed[0];

		if (!candidate) {
			return null;
		}

		logger.debug(
			{
				originalPath: file.path,
				candidatePath: candidate.path,
				downloadPath
			},
			'[ImportService] Retrying missing .strm file with refreshed scan'
		);

		return (await fileExists(candidate.path)) ? candidate : null;
	}

	/**
	 * Check if a file should be imported
	 */
	private isImportableFile(
		filePath: string,
		size: number,
		options: ImportableFileOptions
	): boolean {
		// Check size
		const ext = extname(filePath).toLowerCase();
		if (!(options.allowStrmSmall && ext === '.strm') && size < DOWNLOAD.MIN_IMPORT_SIZE_BYTES) {
			return false;
		}

		// Check extension
		if (!isVideoFile(filePath)) {
			return false;
		}

		// Check for sample/extra patterns
		const fileName = basename(filePath);
		for (const pattern of EXCLUDED_FILE_PATTERNS) {
			if (pattern.test(fileName)) {
				return false;
			}
		}

		return true;
	}

	private async checkBlockedVideoExtensions(
		videoFiles: Array<{ path: string; size: number }>,
		rootFolderBlockedExts: string | null,
		queueItem: typeof downloadQueue.$inferSelect
	): Promise<string | null> {
		let blockedExtensions: string[] = [];

		if (rootFolderBlockedExts) {
			try {
				const parsed = JSON.parse(rootFolderBlockedExts) as string[];
				if (parsed.length > 0) blockedExtensions = parsed;
			} catch {
				// fall through to global
			}
		}

		if (blockedExtensions.length === 0) {
			const { getBlockedVideoExtensions } =
				await import('#lib/server/settings/blocked-extensions.js');
			const global = await getBlockedVideoExtensions();
			blockedExtensions = global.extensions;
		}

		if (blockedExtensions.length === 0) return null;

		const matchedFiles = videoFiles.filter((f) => {
			const dotIndex = f.path.lastIndexOf('.');
			if (dotIndex === -1) return false;
			const ext = f.path.slice(dotIndex).toLowerCase();
			return blockedExtensions.includes(ext);
		});

		if (matchedFiles.length === 0) return null;

		const fileList = matchedFiles.map((f) => basename(f.path)).join(', ');
		const errorMessage = `Blocked video extension detected: ${fileList}`;

		logger.warn(
			{
				title: queueItem.title,
				matchedFiles: matchedFiles.map((f) => f.path),
				blockedExtensions
			},
			'Rejecting import due to blocked video extensions'
		);

		try {
			const { blocklistService } =
				await import('#lib/server/monitoring/specifications/BlocklistSpecification.js');
			await blocklistService.addToBlocklist(
				{
					title: queueItem.title,
					infoHash: queueItem.infoHash ?? undefined,
					indexerId: queueItem.indexerId ?? undefined,
					quality: queueItem.quality ?? undefined,
					size: queueItem.size ?? undefined,
					protocol: queueItem.protocol
				},
				{
					movieId: queueItem.movieId ?? undefined,
					seriesId: queueItem.seriesId ?? undefined,
					episodeIds: queueItem.episodeIds ?? undefined,
					reason: 'blocked_extension',
					message: errorMessage
				}
			);
		} catch (blocklistError) {
			logger.warn(
				{
					title: queueItem.title,
					error: blocklistError instanceof Error ? blocklistError.message : String(blocklistError)
				},
				'Failed to add blocked extension release to blocklist'
			);
		}

		return errorMessage;
	}

	/**
	 * Scan a directory for dangerous or executable files
	 * Following Radarr's DownloadedMovieImportService pattern
	 * @see https://github.com/Radarr/Radarr/blob/develop/src/NzbDrone.Core/MediaFiles/DownloadedMovieImportService.cs
	 */
	private async scanForDangerousFiles(downloadPath: string): Promise<DangerousFileResult> {
		const result: DangerousFileResult = {
			hasDangerousFiles: false,
			dangerousFiles: []
		};

		try {
			const stats = await stat(downloadPath);

			if (stats.isFile()) {
				// Single file - check it directly
				const ext = extname(downloadPath).toLowerCase();
				if ((DANGEROUS_EXTENSIONS as readonly string[]).includes(ext)) {
					result.hasDangerousFiles = true;
					result.dangerousFiles.push({ path: downloadPath, extension: ext, reason: 'dangerous' });
				} else if ((EXECUTABLE_EXTENSIONS as readonly string[]).includes(ext)) {
					result.hasDangerousFiles = true;
					result.dangerousFiles.push({ path: downloadPath, extension: ext, reason: 'executable' });
				}
			} else if (stats.isDirectory()) {
				// Recursively scan directory for dangerous files
				await this.scanDirectoryForDangerousFiles(downloadPath, result);
			}
		} catch (error) {
			logger.warn(
				{
					downloadPath,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to scan for dangerous files'
			);
		}

		return result;
	}

	/**
	 * Recursively scan a directory for dangerous files
	 */
	private async scanDirectoryForDangerousFiles(
		dir: string,
		result: DangerousFileResult
	): Promise<void> {
		try {
			const { readdir } = await import('fs/promises');
			const entries = await readdir(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = join(dir, entry.name);

				if (entry.isDirectory()) {
					// Skip hidden directories
					if (entry.name.startsWith('.') || entry.name.startsWith('@')) {
						continue;
					}
					await this.scanDirectoryForDangerousFiles(fullPath, result);
				} else if (entry.isFile()) {
					const ext = extname(entry.name).toLowerCase();
					if ((DANGEROUS_EXTENSIONS as readonly string[]).includes(ext)) {
						result.hasDangerousFiles = true;
						result.dangerousFiles.push({ path: fullPath, extension: ext, reason: 'dangerous' });
					} else if ((EXECUTABLE_EXTENSIONS as readonly string[]).includes(ext)) {
						result.hasDangerousFiles = true;
						result.dangerousFiles.push({ path: fullPath, extension: ext, reason: 'executable' });
					}
				}
			}
		} catch (error) {
			logger.warn(
				{
					dir,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to scan directory for dangerous files'
			);
		}
	}

	/**
	 * Get a NamingService instance with current database config
	 */
	private getNamingService(): NamingService {
		const config = namingSettingsService.getConfigSync();
		return new NamingService(config);
	}

	private buildSeasonFolderName(seasonNumber: number, series?: Partial<MediaNamingInfo>): string {
		return this.getNamingService().generateSeasonFolderName(seasonNumber, series);
	}

	private buildEpisodeRelativePath(
		useSeasonFolders: boolean,
		seasonNumber: number,
		destFileName: string,
		series?: Partial<MediaNamingInfo>
	): string {
		return useSeasonFolders
			? join(this.buildSeasonFolderName(seasonNumber, series), destFileName)
			: destFileName;
	}

	private formatAudioChannels(channels?: number): string | undefined {
		if (!channels) return undefined;
		const map: Record<number, string> = { 1: '1.0', 2: '2.0', 6: '5.1', 8: '7.1' };
		return map[channels] ?? `${channels}.0`;
	}

	/**
	 * A file ffprobe cannot read is not importable. Without this check a
	 * corrupt fragment or a still-downloading file adopted by mistake would
	 * be renamed into the library as a successful import (#532). STRM
	 * placeholders never produce null - extractMediaInfo returns synthetic
	 * info for those.
	 */
	private getMediaProbeFailure(
		sourcePath: string,
		mediaInfo: Awaited<ReturnType<typeof mediaInfoService.extractMediaInfo>>
	): ImportResult | null {
		if (mediaInfo) return null;
		return {
			success: false,
			sourcePath,
			error: 'Media validation failed: ffprobe could not read the file'
		};
	}

	private async buildMovieFileName(
		movie: typeof movies.$inferSelect,
		sourcePath: string,
		queueItem: typeof downloadQueue.$inferSelect,
		mediaInfo?: Awaited<ReturnType<typeof mediaInfoService.extractMediaInfo>>
	): Promise<string> {
		const parsed = this.parser.parse(queueItem.title);
		const fromRelease = releaseToNamingInfo(parsed, sourcePath);
		// Parity with rename preview: a {Title:xx} token must localize the same
		// way at import time, or every imported file would immediately be
		// flagged as a pending rename.
		const localizedTitles = await resolveLocalizedTitlesForFormats('movie', movie.tmdbId);

		const namingInfo: MediaNamingInfo = {
			title: movie.title,
			originalTitle: movie.originalTitle ?? undefined,
			year: movie.year ?? undefined,
			tmdbId: movie.tmdbId,
			imdbId: movie.imdbId ?? undefined,
			collectionName: movie.collectionName ?? undefined,
			localizedTitles,
			...fromRelease,
			bitDepth: mediaInfo?.videoBitDepth?.toString() ?? fromRelease.bitDepth,
			audioCodec: mediaInfo?.audioCodec ?? fromRelease.audioCodec,
			audioChannels:
				this.formatAudioChannels(mediaInfo?.audioChannels) ?? fromRelease.audioChannels,
			audioLanguages: resolveAudioLanguages(mediaInfo?.audioLanguages)
		};

		return this.getNamingService().generateMovieFileName(namingInfo);
	}

	private async buildEpisodeFileName(
		seriesData: typeof series.$inferSelect,
		seasonNum: number,
		episodeNums: number[],
		sourcePath: string,
		queueItem: typeof downloadQueue.$inferSelect,
		episodeTitle?: string,
		absoluteNumber?: number,
		airDate?: string,
		mediaInfo?: Awaited<ReturnType<typeof mediaInfoService.extractMediaInfo>>
	): Promise<string> {
		const parsed = this.parser.parse(queueItem.title);
		const isAnime = seriesData.seriesType === 'anime';
		const isDaily = seriesData.seriesType === 'daily';
		const fromRelease = releaseToNamingInfo(parsed, sourcePath);
		const localizedTitles = await resolveLocalizedTitlesForFormats(
			'series',
			seriesData.tmdbId ?? undefined
		);

		// IMPORTANT: Spread releaseToNamingInfo FIRST, then override with explicit values.
		// This prevents season pack parsing from overwriting per-file episode numbers.
		const namingInfo: MediaNamingInfo = {
			...fromRelease,
			title: seriesData.title,
			originalTitle: seriesData.originalTitle ?? undefined,
			year: seriesData.year ?? undefined,
			tmdbId: seriesData.tmdbId ?? undefined,
			tvdbId: seriesData.tvdbId ?? undefined,
			imdbId: seriesData.imdbId ?? undefined,
			localizedTitles,
			seasonNumber: seasonNum,
			episodeNumbers: episodeNums,
			episodeTitle,
			absoluteNumber,
			airDate,
			isAnime,
			isDaily,
			bitDepth: mediaInfo?.videoBitDepth?.toString() ?? fromRelease.bitDepth,
			audioCodec: mediaInfo?.audioCodec ?? fromRelease.audioCodec,
			audioChannels:
				this.formatAudioChannels(mediaInfo?.audioChannels) ?? fromRelease.audioChannels,
			audioLanguages: resolveAudioLanguages(mediaInfo?.audioLanguages)
		};

		return this.getNamingService().generateEpisodeFileName(namingInfo);
	}

	private getFallbackAbsoluteEpisodeNumber(
		allEpisodes: Array<typeof episodes.$inferSelect>,
		episodeId?: string
	): number | undefined {
		if (!episodeId) {
			return undefined;
		}

		let lastAbsolute = 0;
		const regularEpisodes = [...allEpisodes]
			.filter((episode) => episode.seasonNumber > 0)
			.sort((a, b) => {
				if (a.seasonNumber !== b.seasonNumber) {
					return a.seasonNumber - b.seasonNumber;
				}
				return a.episodeNumber - b.episodeNumber;
			});

		for (const episode of regularEpisodes) {
			const absoluteNumber =
				typeof episode.absoluteEpisodeNumber === 'number' && episode.absoluteEpisodeNumber > 0
					? episode.absoluteEpisodeNumber
					: lastAbsolute + 1;

			lastAbsolute = absoluteNumber;
			if (episode.id === episodeId) {
				return absoluteNumber;
			}
		}

		return undefined;
	}

	private normalizeUnknownValue(value?: string | null): string | undefined {
		if (!value) return undefined;
		const trimmed = value.trim();
		if (!trimmed) return undefined;

		const normalized = trimmed.toLowerCase();
		if (normalized === 'unknown' || normalized === 'n/a' || normalized === '-') {
			return undefined;
		}

		return trimmed;
	}

	private firstKnownValue(...values: Array<string | null | undefined>): string | undefined {
		for (const value of values) {
			const normalized = this.normalizeUnknownValue(value);
			if (normalized) return normalized;
		}
		return undefined;
	}

	private hasKnownQualityMetadata(parsed: ReturnType<ReleaseParser['parse']>): boolean {
		return (
			parsed.resolution !== 'unknown' ||
			parsed.source !== 'unknown' ||
			parsed.codec !== 'unknown' ||
			parsed.hdr !== null ||
			Boolean(parsed.releaseGroup)
		);
	}

	private resolveSourceReleaseContext(sourcePath: string): {
		sourceName: string;
		parsed: ReturnType<ReleaseParser['parse']>;
	} {
		const fileSourceName = getMediaParseStem(sourcePath);
		const parentFolderName = getMediaParseStem(basename(dirname(sourcePath)));
		const candidates = [fileSourceName, parentFolderName].filter(
			(candidate, index, all) =>
				candidate && all.findIndex((value) => value === candidate) === index
		);

		const [primaryCandidate] = candidates;
		if (!primaryCandidate) {
			return {
				sourceName: basename(sourcePath, extname(sourcePath)),
				parsed: this.parser.parse(basename(sourcePath, extname(sourcePath)))
			};
		}

		const primaryParsed = this.parser.parse(primaryCandidate);
		if (this.hasKnownQualityMetadata(primaryParsed) || candidates.length === 1) {
			return {
				sourceName: primaryCandidate,
				parsed: primaryParsed
			};
		}

		for (let i = 1; i < candidates.length; i++) {
			const fallbackCandidate = candidates[i];
			if (!fallbackCandidate) continue;
			const fallbackParsed = this.parser.parse(fallbackCandidate);
			if (!this.hasKnownQualityMetadata(fallbackParsed)) {
				continue;
			}

			logger.info(
				{
					sourcePath,
					fallbackToken: fallbackCandidate
				},
				'[ImportService] Using fallback source context for metadata parsing'
			);

			return {
				sourceName: fallbackCandidate,
				parsed: fallbackParsed
			};
		}

		return {
			sourceName: primaryCandidate,
			parsed: primaryParsed
		};
	}

	private mapMediaInfoResolution(
		mediaInfo?: { width?: number; height?: number } | null
	): string | undefined {
		if (!mediaInfo) return undefined;

		const label = MediaInfoService.getResolutionLabel(
			mediaInfo.width,
			mediaInfo.height
		).toLowerCase();
		if (label === 'unknown') return undefined;
		if (label === '4k') return '2160p';
		return /^\d{3,4}p$/.test(label) ? label : undefined;
	}

	private mapMediaInfoCodec(codec?: string): string | undefined {
		const normalized = this.normalizeUnknownValue(codec)?.toLowerCase();
		if (!normalized) return undefined;
		const compact = normalized.replace(/[^a-z0-9+]/g, '');

		if (compact.includes('av1')) return 'av1';
		if (compact.includes('hevc') || compact.includes('h265') || compact.includes('x265'))
			return 'h265';
		if (compact.includes('avc') || compact.includes('h264') || compact.includes('x264'))
			return 'h264';
		if (compact.includes('vc1')) return 'vc1';
		if (compact.includes('mpeg2') || compact.includes('m2v')) return 'mpeg2';
		if (compact.includes('xvid')) return 'xvid';
		if (compact.includes('divx')) return 'divx';

		return undefined;
	}

	private mapMediaInfoHdr(hdr?: string): string | undefined {
		const normalized = this.normalizeUnknownValue(hdr)?.toLowerCase();
		if (!normalized) return undefined;

		if (normalized.includes('dolby') && normalized.includes('vision')) return 'dolby-vision';
		if (normalized.includes('hdr10+')) return 'hdr10+';
		if (normalized.includes('hdr10')) return 'hdr10';
		if (normalized.includes('hlg')) return 'hlg';
		if (normalized.includes('pq')) return 'pq';
		if (normalized.includes('sdr')) return 'sdr';
		if (normalized.includes('hdr')) return 'hdr';

		return undefined;
	}

	private buildImportedMetadata(
		queueItem: Pick<typeof downloadQueue.$inferSelect, 'title' | 'quality' | 'releaseGroup'>,
		sourcePath: string,
		mediaInfo: {
			width?: number;
			height?: number;
			videoCodec?: string;
			videoHdrFormat?: string;
		} | null
	): {
		sceneName: string;
		releaseGroup?: string;
		edition?: string;
		quality: {
			resolution?: string;
			source?: string;
			codec?: string;
			hdr?: string;
		};
	} {
		const queueParsed = this.parser.parse(queueItem.title);
		const { sourceName, parsed: sourceParsed } = this.resolveSourceReleaseContext(sourcePath);
		const queueQuality = queueItem.quality ?? undefined;

		const hasQueueMetadata =
			this.hasKnownQualityMetadata(queueParsed) ||
			Boolean(
				this.firstKnownValue(
					queueItem.releaseGroup,
					queueQuality?.resolution,
					queueQuality?.source,
					queueQuality?.codec,
					queueQuality?.hdr
				)
			);
		const hasSourceMetadata = this.hasKnownQualityMetadata(sourceParsed);
		const sceneName = !hasQueueMetadata && hasSourceMetadata ? sourceName : queueItem.title;

		return {
			sceneName,
			edition: queueParsed.edition ?? sourceParsed.edition ?? undefined,
			releaseGroup: this.firstKnownValue(
				queueItem.releaseGroup,
				queueParsed.releaseGroup,
				sourceParsed.releaseGroup
			),
			quality: {
				resolution: this.firstKnownValue(
					queueQuality?.resolution,
					queueParsed.resolution,
					sourceParsed.resolution,
					this.mapMediaInfoResolution(mediaInfo)
				),
				source: this.firstKnownValue(queueQuality?.source, queueParsed.source, sourceParsed.source),
				codec: this.firstKnownValue(
					queueQuality?.codec,
					queueParsed.codec,
					sourceParsed.codec,
					this.mapMediaInfoCodec(mediaInfo?.videoCodec)
				),
				hdr: this.firstKnownValue(
					queueQuality?.hdr,
					queueParsed.hdr ?? undefined,
					sourceParsed.hdr ?? undefined,
					this.mapMediaInfoHdr(mediaInfo?.videoHdrFormat)
				)
			}
		};
	}

	/**
	 * Update series and season episode counts.
	 * Public so it can be called after library scans to refresh cached counts.
	 */
	async updateSeriesStats(seriesId: string): Promise<void> {
		// Get all episodes for this series
		const allEpisodes = await db.select().from(episodes).where(eq(episodes.seriesId, seriesId));

		const today = todayDateString();
		const isAired = (ep: typeof episodes.$inferSelect) =>
			Boolean(ep.airDate && ep.airDate !== '' && ep.airDate <= today);

		// Exclude specials (season 0) and unaired episodes from series-level counts
		const regularEpisodes = allEpisodes.filter((ep) => ep.seasonNumber !== 0 && isAired(ep));
		const regularEpisodesWithFiles = regularEpisodes.filter((ep) => ep.hasFile);

		// Update series counts
		await db
			.update(series)
			.set({
				episodeFileCount: regularEpisodesWithFiles.length,
				episodeCount: regularEpisodes.length
			})
			.where(eq(series.id, seriesId));

		// Group by season and update each season's counts (only aired episodes)
		const seasonMap = new Map<number, { total: number; withFiles: number }>();
		for (const ep of allEpisodes) {
			if (!isAired(ep)) continue;
			const stats = seasonMap.get(ep.seasonNumber) || { total: 0, withFiles: 0 };
			stats.total++;
			if (ep.hasFile) {
				stats.withFiles++;
			}
			seasonMap.set(ep.seasonNumber, stats);
		}

		// Update each season
		for (const [seasonNumber, stats] of seasonMap) {
			await db
				.update(seasons)
				.set({
					episodeFileCount: stats.withFiles,
					episodeCount: stats.total
				})
				.where(and(eq(seasons.seriesId, seriesId), eq(seasons.seasonNumber, seasonNumber)));
		}
	}

	/**
	 * Delete a movie file (both database record and physical file).
	 *
	 * Public so other edit-time flows (e.g. removing now-redundant quality tiers
	 * on a desiredQualities change) can reuse the gold-standard delete path:
	 * resolves the full path, recycles-or-unlinks, cleans the DB row, and emits
	 * the `file:deleted` SSE event.
	 */
	async deleteMovieFile(
		fileId: string,
		movieId: string,
		recycleEnabled?: boolean
	): Promise<{ success: boolean; error?: string }> {
		try {
			// Get file info before deleting
			const [fileRecord] = await db
				.select()
				.from(movieFiles)
				.where(eq(movieFiles.id, fileId))
				.limit(1);

			if (!fileRecord) {
				return { success: false, error: 'File record not found' };
			}

			// Get movie to build full path
			const [movie] = await db.select().from(movies).where(eq(movies.id, movieId)).limit(1);

			if (!movie || !movie.rootFolderId) {
				return { success: false, error: 'Movie or root folder not found' };
			}

			// Get root folder
			const [rootFolder] = await db
				.select()
				.from(rootFolders)
				.where(eq(rootFolders.id, movie.rootFolderId))
				.limit(1);

			if (!rootFolder) {
				return { success: false, error: 'Root folder not found' };
			}

			// Build full path
			const fullPath = join(rootFolder.path, movie.path, fileRecord.relativePath);

			// Delete or recycle physical file if it exists. On failure the DB
			// row is KEPT: dropping ownership while the file remains lets a
			// later scan rediscover it as a phantom re-import.
			try {
				await deletePhysicalFile(fullPath, !!recycleEnabled, rootFolder.path);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.warn(
					{
						fileId,
						path: fullPath,
						err: error
					},
					'Failed to delete/recycle physical file - keeping DB row for retry'
				);
				return {
					success: false,
					error: `Physical delete failed: ${message} (row kept)`
				};
			}

			// Delete database record
			await db.delete(movieFiles).where(eq(movieFiles.id, fileId));

			// Emit event for SSE clients
			this.emit('file:deleted', {
				mediaType: 'movie',
				movieId,
				fileId,
				filePath: fullPath
			});

			logger.info({ fileId, movieId }, 'Deleted movie file record');
			return { success: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error({ fileId, err: error }, 'Failed to delete movie file');
			return { success: false, error: errorMessage };
		}
	}

	/**
	 * Delete an episode file (both database record and physical file)
	 */
	async deleteEpisodeFile(
		fileId: string,
		seriesId: string,
		recycleEnabled?: boolean
	): Promise<{ success: boolean; error?: string }> {
		try {
			// Get file info before deleting
			const [fileRecord] = await db
				.select()
				.from(episodeFiles)
				.where(eq(episodeFiles.id, fileId))
				.limit(1);

			if (!fileRecord) {
				return { success: false, error: 'File record not found' };
			}

			// Get series to build full path
			const [seriesData] = await db.select().from(series).where(eq(series.id, seriesId)).limit(1);

			if (!seriesData || !seriesData.rootFolderId) {
				return { success: false, error: 'Series or root folder not found' };
			}

			// Get root folder
			const [rootFolder] = await db
				.select()
				.from(rootFolders)
				.where(eq(rootFolders.id, seriesData.rootFolderId))
				.limit(1);

			if (!rootFolder) {
				return { success: false, error: 'Root folder not found' };
			}

			// Build full path
			const fullPath = join(rootFolder.path, seriesData.path, fileRecord.relativePath);

			// Delete or recycle physical file if it exists. On failure the DB
			// row is KEPT: dropping ownership while the file remains lets a
			// later scan rediscover it as a phantom re-import.
			try {
				if (await fileExists(fullPath)) {
					if (recycleEnabled) {
						await moveToRecycleBin(fullPath, rootFolder.path);
						logger.info({ fileId, path: fullPath }, 'Moved old episode file to recycle bin');
					} else {
						await unlink(fullPath);
						logger.info({ fileId, path: fullPath }, 'Deleted old episode file');
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.warn(
					{
						fileId,
						path: fullPath,
						err: error
					},
					'Failed to delete/recycle physical file - keeping DB row for retry'
				);
				return {
					success: false,
					error: `Physical delete failed: ${message} (row kept)`
				};
			}

			// Delete database record
			await db.delete(episodeFiles).where(eq(episodeFiles.id, fileId));

			// Update episode hasFile flags
			for (const episodeId of fileRecord.episodeIds ?? []) {
				// Check if episode has other files
				const otherFiles = await db
					.select()
					.from(episodeFiles)
					.where(eq(episodeFiles.seriesId, seriesId));

				const hasOtherFile = otherFiles.some((f) => f.episodeIds?.includes(episodeId) ?? false);

				if (!hasOtherFile) {
					await db.update(episodes).set({ hasFile: false }).where(eq(episodes.id, episodeId));
				}
			}

			// Update series stats
			await this.updateSeriesStats(seriesId);

			// Emit event for SSE clients
			this.emit('file:deleted', {
				mediaType: 'episode',
				seriesId,
				fileId,
				episodeIds: fileRecord.episodeIds ?? [],
				filePath: fullPath
			});

			logger.info({ fileId, seriesId }, 'Deleted episode file record');
			return { success: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error({ fileId, err: error }, 'Failed to delete episode file');
			return { success: false, error: errorMessage };
		}
	}

	/**
	 * Trigger subtitle search for newly imported media
	 * Runs asynchronously and doesn't block import completion
	 */
	async triggerSubtitleSearch(mediaType: 'movie' | 'episode', mediaId: string): Promise<void> {
		try {
			// Check if subtitle search on import is enabled
			const settings = await monitoringScheduler.getSettings();
			if (!settings.subtitleSearchOnImportEnabled) {
				logger.debug(
					{
						mediaType,
						mediaId
					},
					'[ImportService] Subtitle search on import is disabled'
				);
				return;
			}

			// Use the standalone import service for subtitle search
			const result = await searchSubtitlesForNewMedia(mediaType, mediaId);

			logger.info(
				{
					mediaType,
					mediaId,
					downloaded: result.downloaded,
					errors: result.errors.length
				},
				'[ImportService] Post-import subtitle search completed'
			);
		} catch (error) {
			// Log but don't fail - subtitle search is supplementary
			logger.warn(
				{
					mediaType,
					mediaId,
					error: error instanceof Error ? error.message : String(error)
				},
				'[ImportService] Post-import subtitle search failed'
			);
		}
	}

	/**
	 * Trigger subtitle search for episodes associated with imported episode files
	 */
	async triggerSubtitleSearchForEpisodeFiles(fileIds: string[]): Promise<void> {
		// Check if subtitle search on import is enabled
		const settings = await monitoringScheduler.getSettings();
		if (!settings.subtitleSearchOnImportEnabled) {
			logger.debug('[ImportService] Subtitle search on import is disabled');
			return;
		}

		// Collect unique episode IDs from all files
		const uniqueEpisodeIds = new Set<string>();

		for (const fileId of fileIds) {
			const [file] = await db
				.select()
				.from(episodeFiles)
				.where(eq(episodeFiles.id, fileId))
				.limit(1);

			if (file?.episodeIds) {
				for (const epId of file.episodeIds) {
					uniqueEpisodeIds.add(epId);
				}
			}
		}

		if (uniqueEpisodeIds.size === 0) {
			return;
		}

		// Trigger subtitle search for each episode
		let totalDownloaded = 0;
		let totalErrors = 0;

		for (const episodeId of uniqueEpisodeIds) {
			try {
				const result = await searchSubtitlesForNewMedia('episode', episodeId);
				totalDownloaded += result.downloaded;
				totalErrors += result.errors.length;
			} catch (error) {
				totalErrors++;
				logger.warn(
					{
						episodeId,
						error: error instanceof Error ? error.message : String(error)
					},
					'[ImportService] Failed to search subtitles for episode'
				);
			}
		}

		logger.info(
			{
				episodeCount: uniqueEpisodeIds.size,
				downloaded: totalDownloaded,
				errors: totalErrors
			},
			'[ImportService] Post-import episode subtitle search completed'
		);
	}

	/**
	 * Create a history record for a completed import
	 */
	private async createHistoryRecord(
		queueItem: typeof downloadQueue.$inferSelect,
		status: 'imported' | 'failed' | 'rejected' | 'removed',
		extras: {
			statusReason?: string;
			importedPath?: string;
			movieFileId?: string;
			episodeFileIds?: string[];
			title?: string;
			releaseGroup?: string;
			quality?: typeof downloadQueue.$inferSelect.quality;
			transferMode?: TransferMode;
		} = {}
	): Promise<void> {
		// Get download client name
		const [client] = await db
			.select()
			.from(downloadClients)
			.where(eq(downloadClients.id, queueItem.downloadClientId))
			.limit(1);

		// Calculate download time
		let downloadTimeSeconds: number | undefined;
		if (queueItem.startedAt && queueItem.completedAt) {
			const startTime = new Date(queueItem.startedAt).getTime();
			const endTime = new Date(queueItem.completedAt).getTime();
			downloadTimeSeconds = Math.floor((endTime - startTime) / 1000);
		}

		const historyValues: Partial<typeof downloadHistory.$inferInsert> = {
			downloadClientId: queueItem.downloadClientId,
			downloadClientName: client?.name,
			downloadId: queueItem.downloadId,
			infoHash: queueItem.infoHash,
			title: extras.title ?? queueItem.title,
			indexerId: queueItem.indexerId,
			indexerName: queueItem.indexerName,
			protocol: queueItem.protocol,
			movieId: queueItem.movieId,
			seriesId: queueItem.seriesId,
			episodeIds: queueItem.episodeIds ?? undefined,
			seasonNumber: queueItem.seasonNumber,
			status,
			statusReason: extras.statusReason,
			size: queueItem.size,
			downloadTimeSeconds,
			finalRatio: queueItem.ratio,
			quality: (extras.quality ?? queueItem.quality) as typeof downloadHistory.$inferInsert.quality,
			importedPath: extras.importedPath,
			movieFileId: extras.movieFileId,
			episodeFileIds: extras.episodeFileIds,
			transferMode: extras.transferMode,
			grabbedAt: queueItem.addedAt,
			completedAt: queueItem.completedAt,
			releaseGroup: extras.releaseGroup ?? queueItem.releaseGroup,
			importedAt: new Date().toISOString()
		};

		// If this queue attempt was previously recorded as failed, convert that row
		// to imported/recovered instead of creating duplicate activity rows.
		if (status === 'imported' && queueItem.addedAt) {
			const failedCandidates = await db
				.select({
					id: downloadHistory.id,
					downloadId: downloadHistory.downloadId,
					title: downloadHistory.title,
					movieId: downloadHistory.movieId,
					seriesId: downloadHistory.seriesId
				})
				.from(downloadHistory)
				.where(
					and(
						eq(downloadHistory.status, 'failed'),
						eq(downloadHistory.grabbedAt, queueItem.addedAt)
					)
				);

			const failedRecord = failedCandidates.find((candidate) => {
				const sameDownloadId =
					candidate.downloadId &&
					queueItem.downloadId &&
					candidate.downloadId === queueItem.downloadId;
				if (sameDownloadId) return true;

				const sameTitleAndMedia =
					candidate.title === queueItem.title &&
					candidate.movieId === queueItem.movieId &&
					candidate.seriesId === queueItem.seriesId;
				return sameTitleAndMedia;
			});

			if (failedRecord) {
				await db
					.update(downloadHistory)
					.set({
						...historyValues,
						status: 'imported',
						statusReason: null
					})
					.where(eq(downloadHistory.id, failedRecord.id));
				return;
			}
		}

		await db.insert(downloadHistory).values(historyValues as typeof downloadHistory.$inferInsert);
	}

	/**
	 * Cleanup source folder for usenet downloads.
	 * Usenet downloads don't need to be kept for seeding, so we can delete
	 * the source folder after successful import to save disk space.
	 */
	private async cleanupUsenetSource(sourcePath: string): Promise<void> {
		try {
			// Safety check: Don't delete paths that are too short or look like base directories
			// A valid usenet download path should have the download name as a subfolder
			const pathParts = sourcePath.split('/').filter((p) => p.length > 0);
			if (pathParts.length < 4) {
				logger.warn(
					{
						sourcePath,
						pathDepth: pathParts.length
					},
					'[ImportService] Refusing to delete path that looks like a base directory'
				);
				return;
			}

			// Check if it exists first
			const exists = await fileExists(sourcePath);
			if (!exists) {
				logger.debug({ sourcePath }, '[ImportService] Usenet source already cleaned up');
				return;
			}

			// Check if it's a file or directory
			const stats = await stat(sourcePath);

			if (stats.isDirectory()) {
				await rm(sourcePath, { recursive: true, force: true });
			} else {
				await unlink(sourcePath);
			}

			logger.info(
				{
					sourcePath,
					wasDirectory: stats.isDirectory()
				},
				'[ImportService] Deleted usenet source after import'
			);
		} catch (err) {
			// Log but don't throw - cleanup failure shouldn't fail the import
			logger.warn(
				{
					sourcePath,
					error: err instanceof Error ? err.message : String(err)
				},
				'[ImportService] Failed to delete usenet source'
			);
		}
	}
}

// Singleton getter - preferred way to access the service
export function getImportService(): ImportService {
	return ImportService.getInstance();
}

// Reset singleton (for testing)
export function resetImportService(): void {
	ImportService.resetInstance();
}

// Backward-compatible export (prefer getImportService())
export const importService = ImportService.getInstance();
