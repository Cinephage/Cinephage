/**
 * Download Monitor Service
 *
 * Polls download clients to track download progress, detect completions,
 * and trigger imports. Uses adaptive polling (faster when active downloads,
 * slower when idle).
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readdir, stat } from 'fs/promises';
import type { Dirent } from 'node:fs';
import { db } from '#lib/server/db/index.js';
import {
	downloadQueue,
	downloadHistory,
	downloadClients,
	monitoringSettings,
	movies,
	movieFiles,
	series,
	episodeFiles,
	episodes,
	stalledOrphanTracking
} from '#lib/server/db/schema.js';
import { eq, and, or, inArray, not, notInArray, isNull, isNotNull, desc, sql } from 'drizzle-orm';
import { getDownloadClientManager } from '../DownloadClientManager';
import type { DownloadClientProtocol } from '../DownloadClientManager';
import { joinCategoryPath, sanitizeCategorySegment } from '../core/client-utils.js';
import { mapClientPathToLocal } from './PathMapping';
import { resolveInfoHash } from '../utils/hashUtils';
import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import {
	findSuggestedMatches,
	type SuggestedMatch
} from '#lib/server/library/suggested-matches.js';
import { isPathInsideManagedRoot } from '#lib/server/filesystem/path-guard.js';
import { isVideoFile } from '#lib/config/constants.js';
import {
	cleanupExpiredQueueTombstones,
	extendQueueTombstonesFromDownloads,
	getQueueTombstoneCleanupIntervalMs,
	isQueueItemSuppressed,
	upsertQueueTombstoneFromQueueItem
} from './QueueTombstoneService';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'imports' as const });

const releaseParser = new ReleaseParser();
import type { BackgroundService, ServiceStatus } from '#lib/server/services/background-service.js';
import type { IDownloadClient, DownloadInfo } from '../core/interfaces';
import type { DownloadClient } from '#lib/types/downloadClient.js';
import {
	isImportedQueueStatus,
	POST_IMPORT_QUEUE_STATUSES,
	TERMINAL_QUEUE_STATUSES,
	type QueueStatus,
	type QueueItem,
	type QueueStats,
	type QueueEvent
} from '#lib/types/queue.js';
import { parseEpisodePointerFromTitle } from '#lib/server/downloads/episode-pointer.js';
import { activityStreamEvents } from '#lib/server/activity/ActivityStreamEvents.js';
import { acquisitionService } from '#lib/server/acquisition/AcquisitionService.js';

// Import service is loaded lazily to avoid circular dependencies
let importServiceInstance: import('../import').ImportService | null = null;
async function getImportService() {
	if (!importServiceInstance) {
		const { importService } = await import('../import');
		importServiceInstance = importService;
	}
	return importServiceInstance;
}

/**
 * Polling intervals in milliseconds
 */
const DEFAULT_POLL_INTERVAL_ACTIVE_MS = 5_000; // 5 seconds when active downloads
const DEFAULT_POLL_INTERVAL_IDLE_MS = 30_000; // 30 seconds when idle

function getPositiveIntEnv(name: string, fallback: number): number {
	const envValue = process.env[name];
	if (!envValue) {
		return fallback;
	}

	const parsed = Number(envValue);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}

	return Math.round(parsed);
}

const POLL_INTERVAL_ACTIVE = getPositiveIntEnv(
	'DOWNLOAD_MONITOR_POLL_ACTIVE_MS',
	DEFAULT_POLL_INTERVAL_ACTIVE_MS
);
const POLL_INTERVAL_IDLE = getPositiveIntEnv(
	'DOWNLOAD_MONITOR_POLL_IDLE_MS',
	DEFAULT_POLL_INTERVAL_IDLE_MS
);

const STARTUP_SYNC_ENABLED = process.env.DOWNLOAD_MONITOR_STARTUP_SYNC_ENABLED !== 'false';
const DEFAULT_STARTUP_SYNC_TIMEOUT_MS = 10_000; // 10 seconds per client

function getStartupSyncTimeoutMs(): number {
	return getPositiveIntEnv(
		'DOWNLOAD_MONITOR_STARTUP_SYNC_TIMEOUT_MS',
		DEFAULT_STARTUP_SYNC_TIMEOUT_MS
	);
}

const STARTUP_SYNC_TIMEOUT_MS = getStartupSyncTimeoutMs();
const QUEUE_TOMBSTONE_CLEANUP_INTERVAL_MS = getQueueTombstoneCleanupIntervalMs();

/**
 * Max import attempts before marking as failed
 */
const MAX_IMPORT_ATTEMPTS = 10;

/**
 * Grace period for completed items during queue-to-history transition.
 * SABnzbd needs extra time for post-processing (extracting large archives,
 * moving files, running scripts) before items appear in history.
 * Increased to 5 minutes to handle large archive extractions reliably.
 */
const COMPLETED_GRACE_PERIOD_MS = 300_000; // 5 minutes
const MISSING_GRACE_PERIOD_MS = 30_000; // 30 seconds
const TORRENT_MISSING_GRACE_PERIOD_MS = 180_000; // 3 minutes
const TORRENT_MAGNET_METADATA_GRACE_PERIOD_MS = 600_000; // 10 minutes

/** Bounds for the unmatched content scan; an unfinished scan counts as acceptable. */
const MAX_CONTENT_SCAN_ENTRIES = 5_000;
const MAX_CONTENT_SCAN_DEPTH = 6;
// .strm placeholder files (WebDAV/Mounts, e.g. NZBDav) are a real,
// intentional content type elsewhere in the app (media-info.ts,
// FileTransfer.ts both add it) - without this, isAcceptableContent's video
// check never recognizes them and silently excludes every .strm-based
// download from Unmatched.
const CONTENT_SCAN_EXTRA_EXTENSIONS = ['.strm'] as const;

/**
 * Terminal statuses - items that are completely done and hidden from queue UI.
 * Failed items stay visible for user action and should not be treated as terminal.
 */
const TERMINAL_STATUSES: QueueStatus[] = [...TERMINAL_QUEUE_STATUSES];

/**
 * Post-import statuses - items that are imported but still visible in queue (seeding)
 * These should NOT be updated by polling - they're managed by removeCompletedDownloads()
 */
const POST_IMPORT_STATUSES: QueueStatus[] = [...POST_IMPORT_QUEUE_STATUSES];

/**
 * Build a recovery path for torrent downloads that disappeared from the client.
 *
 * When qBittorrent auto-removes a completed torrent, the stored outputPath
 * still points to the temp/incomplete directory. This computes where the
 * completed files should be found: {downloadPathLocal}/{category}/{lastComponent}
 */
export function buildTorrentRecoveryPath(
	outputPath: string,
	downloadPathLocal: string,
	category: string
): string | null {
	const normalizedBase = downloadPathLocal.replace(/\/+$/, '');
	const normalizedCategory = sanitizeCategorySegment(category);
	const parts = outputPath.replace(/\\/g, '/').split('/').filter(Boolean);
	const lastComponent = parts[parts.length - 1];
	if (!lastComponent) return null;
	return `${normalizedBase}/${normalizedCategory}/${lastComponent}`;
}

/** Client config subset needed to judge a recovery candidate path. */
type RecoveryClientConfig = {
	downloadPathLocal?: string | null;
	tempPathLocal?: string | null;
	downloadPathRemote?: string | null;
	tempPathRemote?: string | null;
	movieCategory?: string | null;
	tvCategory?: string | null;
};

/**
 * Resolve the per-download content path clients report for imports.
 *
 * Torrent clients report an empty contentPath until a magnet's metadata
 * resolves; falling back to savePath there stores the save root (or the
 * per-category root) as outputPath, which recovery must never treat as a
 * completed download's own files (#532). Usenet clients only report
 * savePath, so the fallback stays for that protocol.
 */
function getDownloadContentPath(
	download: Pick<DownloadInfo, 'contentPath' | 'savePath'>,
	protocol: string
): string | null {
	if (download.contentPath) return download.contentPath;
	return protocol === 'torrent' ? null : download.savePath || null;
}

// Mirrors DownloadClientManager's IMPLEMENTATION_PROTOCOL_MAP. Kept as a
// local copy rather than importing the class itself: many existing tests
// mock '../DownloadClientManager' with only `getDownloadClientManager`, and
// pulling in the class export here would make those mocks throw.
const CLIENT_IMPLEMENTATION_PROTOCOL: Record<string, DownloadClientProtocol> = {
	qbittorrent: 'torrent',
	transmission: 'torrent',
	deluge: 'torrent',
	rtorrent: 'torrent',
	aria2: 'torrent',
	sabnzbd: 'usenet',
	nzbget: 'usenet',
	realdebrid: 'debrid',
	torbox: 'debrid'
};

function getClientProtocol(implementation: string | null | undefined): DownloadClientProtocol {
	if (!implementation) return 'torrent';
	return CLIENT_IMPLEMENTATION_PROTOCOL[implementation.toLowerCase()] ?? 'torrent';
}

function isSamePath(firstPath: string, secondPath: string): boolean {
	return relative(resolve(firstPath), resolve(secondPath)) === '';
}

function isSameOrDescendant(candidatePath: string, parentPath: string): boolean {
	const pathFromParent = relative(resolve(parentPath), resolve(candidatePath));
	return (
		pathFromParent === '' ||
		(!pathFromParent.startsWith(`..${sep}`) &&
			pathFromParent !== '..' &&
			!isAbsolute(pathFromParent))
	);
}

/**
 * Recursively measure what is actually on disk for a recovery candidate.
 * allocatedBytes (blocks * 512) exposes pre-allocated but unwritten
 * (sparse/partial) content that logical size alone cannot.
 */
async function getPathFootprint(candidatePath: string): Promise<{
	logicalBytes: number;
	allocatedBytes: number;
	fileCount: number;
}> {
	const stats = await stat(candidatePath);
	if (!stats.isDirectory()) {
		return {
			logicalBytes: stats.size,
			allocatedBytes: stats.blocks * 512,
			fileCount: stats.isFile() ? 1 : 0
		};
	}

	let logicalBytes = 0;
	let allocatedBytes = 0;
	let fileCount = 0;
	for (const entry of await readdir(candidatePath, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) continue;
		const footprint = await getPathFootprint(join(candidatePath, entry.name));
		logicalBytes += footprint.logicalBytes;
		allocatedBytes += footprint.allocatedBytes;
		fileCount += footprint.fileCount;
	}

	return { logicalBytes, allocatedBytes, fileCount };
}

/** Download-client roots and per-category staging roots, never valid as a
 * single download's recovery candidate. */
function getUnsafeRecoveryRoots(client: RecoveryClientConfig): string[] {
	const roots: string[] = [];
	for (const base of [client.downloadPathLocal, client.tempPathLocal]) {
		if (!base) continue;
		roots.push(base);
		for (const category of [client.movieCategory, client.tvCategory]) {
			if (!category) continue;
			const joined = joinCategoryPath(base, category);
			if (joined) roots.push(joined);
		}
	}
	return roots;
}

/**
 * Guard every recovery stat() site: existing on disk is not evidence that a
 * vanished download completed there. Rejects download-client and category
 * roots (a metadata-less magnet's outputPath degrades to one), paths
 * overlapping another active download (both directions, so a broad path
 * cannot adopt another torrent's in-progress files), torrents never
 * observed complete, and sparse or undersized footprints (#532).
 */
export async function isSafeRecoveryCandidate(
	candidatePath: string,
	queueItem: typeof downloadQueue.$inferSelect,
	client: RecoveryClientConfig,
	allDownloads: DownloadInfo[]
): Promise<boolean> {
	if (getUnsafeRecoveryRoots(client).some((root) => isSamePath(root, candidatePath))) {
		logger.warn(
			{ title: queueItem.title, candidatePath },
			'Refusing recovery from a download-client root directory'
		);
		return false;
	}

	const activeOwner = allDownloads.find((download) => {
		if (download.hash === queueItem.downloadId || download.hash === queueItem.infoHash)
			return false;
		if (download.progress >= 1 || download.status === 'error') return false;
		const clientPath = download.contentPath || download.savePath;
		if (!clientPath) return false;
		const ownedPath = mapClientPathToLocal(
			clientPath,
			client.downloadPathLocal ?? null,
			client.downloadPathRemote ?? null,
			client.tempPathLocal ?? null,
			client.tempPathRemote ?? null
		);
		return (
			isSameOrDescendant(candidatePath, ownedPath) || isSameOrDescendant(ownedPath, candidatePath)
		);
	});

	if (activeOwner) {
		logger.warn(
			{ title: queueItem.title, candidatePath, owningHash: activeOwner.hash },
			'Refusing recovery from a path claimed by an active download'
		);
		return false;
	}

	const progress = Number(queueItem.progress ?? 0);
	if (queueItem.protocol === 'torrent' && progress < 1) {
		logger.warn(
			{ title: queueItem.title, candidatePath, progress },
			'Refusing recovery of a torrent that was not observed complete'
		);
		return false;
	}

	try {
		const footprint = await getPathFootprint(candidatePath);
		if (footprint.fileCount === 0) return false;

		const expectedSize = queueItem.size ?? 0;
		if (expectedSize > 0 && footprint.logicalBytes < expectedSize * 0.98) {
			logger.warn(
				{
					title: queueItem.title,
					candidatePath,
					expectedSize,
					actualSize: footprint.logicalBytes
				},
				'Refusing recovery because downloaded content is smaller than expected'
			);
			return false;
		}

		if (
			footprint.logicalBytes >= 1024 * 1024 &&
			footprint.allocatedBytes < footprint.logicalBytes * 0.98
		) {
			logger.warn(
				{
					title: queueItem.title,
					candidatePath,
					logicalBytes: footprint.logicalBytes,
					allocatedBytes: footprint.allocatedBytes
				},
				'Refusing recovery of sparse, incomplete content'
			);
			return false;
		}

		return true;
	} catch {
		return false;
	}
}

/**
 * Convert database row to QueueItem
 */
function rowToQueueItem(row: typeof downloadQueue.$inferSelect): QueueItem {
	return {
		id: row.id,
		downloadClientId: row.downloadClientId,
		downloadId: row.downloadId,
		infoHash: row.infoHash,
		title: row.title,
		indexerId: row.indexerId,
		indexerName: row.indexerName,
		downloadUrl: row.downloadUrl,
		magnetUrl: row.magnetUrl,
		protocol: row.protocol,
		movieId: row.movieId,
		seriesId: row.seriesId,
		episodeIds: row.episodeIds as string[] | null,
		seasonNumber: row.seasonNumber,
		status: row.status as QueueStatus,
		progress: parseFloat(row.progress || '0'),
		size: row.size,
		downloadSpeed: row.downloadSpeed || 0,
		uploadSpeed: row.uploadSpeed || 0,
		eta: row.eta,
		ratio: parseFloat(row.ratio || '0'),
		clientDownloadPath: row.clientDownloadPath,
		outputPath: row.outputPath,
		importedPath: row.importedPath,
		quality: row.quality as QueueItem['quality'],
		releaseGroup: row.releaseGroup,
		addedAt: row.addedAt || new Date().toISOString(),
		startedAt: row.startedAt,
		completedAt: row.completedAt,
		importedAt: row.importedAt,
		errorMessage: row.errorMessage,
		importAttempts: row.importAttempts || 0,
		lastAttemptAt: row.lastAttemptAt,
		isAutomatic: !!row.isAutomatic,
		isUpgrade: !!row.isUpgrade
	};
}

/**
 * Map download client status to queue status.
 * Validates progress is in valid range and logs unknown statuses.
 */
function mapDownloadStatusToQueueStatus(
	downloadStatus: DownloadInfo['status'],
	progress: number
): QueueStatus {
	// Validate and clamp progress to 0-1 range
	const safeProgress = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;

	switch (downloadStatus) {
		case 'downloading':
			return 'downloading';
		case 'stalled':
			return 'stalled';
		case 'paused':
			return 'paused';
		case 'seeding':
			// Trust the client - if it says seeding, it's seeding
			// Zero progress can happen with empty/skipped torrents
			return 'seeding';
		case 'completed':
			return 'completed';
		case 'postprocessing':
			return 'postprocessing';
		case 'queued':
			return 'queued';
		case 'error':
			return 'failed';
		default:
			// Log unknown status for debugging
			logger.warn(
				{
					downloadStatus,
					progress: safeProgress
				},
				'Unknown download status encountered, defaulting to queued'
			);
			return 'queued';
	}
}

function shouldPreservePointerSize(
	queueItem: typeof downloadQueue.$inferSelect,
	download: DownloadInfo
): boolean {
	const pointerTarget = parseEpisodePointerFromTitle(queueItem.title);
	if (!pointerTarget) {
		return false;
	}

	const existingSize = queueItem.size ?? 0;
	const clientSize = download.size ?? 0;
	return existingSize > 0 && clientSize > existingSize;
}

/**
 * Events emitted by DownloadMonitorService
 */
export interface DownloadMonitorEvents {
	/** Queue item added */
	'queue:added': (item: QueueItem) => void;
	/** Queue item updated */
	'queue:updated': (item: QueueItem) => void;
	/** Queue item removed */
	'queue:removed': (id: string) => void;
	/** Download completed (ready for import) */
	'queue:completed': (item: QueueItem) => void;
	/** Download imported */
	'queue:imported': (item: QueueItem) => void;
	/** Download failed */
	'queue:failed': (item: QueueItem) => void;
	/** Stats updated */
	'queue:stats': (stats: QueueStats) => void;
}

/**
 * A download present in a client under a Cinephage-managed label with no
 * corresponding download_queue row. Monitor-only: matching and importing
 * live in the import wizard (see resolveUnmatchedEntries), so the listing
 * carries no suggestions. `attachable` is the strong path only: the
 * torrent's infohash byte-matches a library file, so one click attaches it
 * with no fuzzy matching.
 */
export interface UnmatchedDownload {
	hash: string;
	name: string;
	size: number;
	status: DownloadInfo['status'];
	progress: number;
	category?: string;
	/**
	 * Movie vs TV, resolved from which of the client's configured
	 * movie/tv categories this download's category matches. Null when the
	 * download has no category or matches neither (isManagedCategory still
	 * lets uncategorized downloads through, so this can't always resolve).
	 */
	mediaType: 'movie' | 'tv' | null;
	savePath: string;
	clientId: string;
	clientName: string;
	attachable: {
		mediaType: 'movie' | 'tv';
		tmdbId: number;
		title: string;
	} | null;
	suggestion: {
		mediaType: 'movie' | 'tv';
		tmdbId: number;
		title: string;
		year?: number;
		confidence: number;
	} | null;
}

/**
 * Index of live client downloads shared by the unmatched flows.
 */
interface ClientDownloadIndex {
	byClient: Map<string, { client: DownloadClient; byHash: Map<string, DownloadInfo> }>;
	fetchFailed: boolean;
}

// Keyed in the process-wide global symbol registry (not a plain module-level
// variable) so the singleton survives Vite/SvelteKit dev-mode SSR module
// re-evaluation. A plain `static instance` field lives on the class, and the
// class itself gets redefined whenever this module is re-executed - editing
// any file this service transitively imports can trigger that in dev. Each
// re-evaluation would otherwise silently create a second DownloadMonitorService
// with its own live poll loop and its own independent 10-minute orphan-cleanup
// timer, left running forever with nothing left in the app to stop it -
// manifesting as duplicate, overlapping background activity (e.g. the same
// "orphaned" download being rediscovered and removed repeatedly) that looks
// like a single runaway process but is actually several accumulated ones.
const DOWNLOAD_MONITOR_GLOBAL_KEY = Symbol.for('cinephage.downloadMonitorService');

interface GlobalWithDownloadMonitor {
	[DOWNLOAD_MONITOR_GLOBAL_KEY]?: DownloadMonitorService;
}

/**
 * Download Monitor Service
 *
 * Singleton service that continuously monitors download clients and updates
 * the download queue in the database. Implements BackgroundService for
 * lifecycle management via ServiceManager.
 */
export class DownloadMonitorService extends EventEmitter implements BackgroundService {
	readonly name = 'DownloadMonitor';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;

	private isRunning = false;
	private isPolling = false; // Prevents concurrent poll() calls
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private lastPollTime = 0;
	private activeDownloadCount = 0;

	// SSE clients for real-time updates
	private sseClients: Set<(event: QueueEvent) => void> = new Set();

	// Track torrent hashes we've already checked for blocked extensions
	private blockedExtensionCheckedHashes = new Set<string>();
	private blockedExtensionTimer: ReturnType<typeof setTimeout> | null = null;
	private static readonly DEFAULT_BLOCKED_EXTENSION_CHECK_INTERVAL_SECONDS = 30;

	// Last time orphan cleanup was run (runs every 10 minutes)
	private lastOrphanCleanupTime = 0;
	private lastQueueTombstoneCleanupTime = 0;
	private static readonly ORPHAN_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

	private constructor() {
		super();
	}

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	static getInstance(): DownloadMonitorService {
		const g = globalThis as GlobalWithDownloadMonitor;
		if (!g[DOWNLOAD_MONITOR_GLOBAL_KEY]) {
			g[DOWNLOAD_MONITOR_GLOBAL_KEY] = new DownloadMonitorService();
		}
		return g[DOWNLOAD_MONITOR_GLOBAL_KEY];
	}

	/** Reset the singleton instance (for testing) */
	static async resetInstance(): Promise<void> {
		const g = globalThis as GlobalWithDownloadMonitor;
		const existing = g[DOWNLOAD_MONITOR_GLOBAL_KEY];
		if (existing) {
			await existing.stop();
			delete g[DOWNLOAD_MONITOR_GLOBAL_KEY];
		}
	}

	/**
	 * Start the monitoring service (non-blocking)
	 * Implements BackgroundService.start()
	 */
	start(): void {
		if (this.isRunning || this._status === 'starting') {
			logger.debug('Download monitor already running');
			return;
		}

		this._status = 'starting';
		this.isRunning = true;
		logger.info('Starting download monitor service');

		// Perform async startup in background
		setImmediate(() => {
			if (!STARTUP_SYNC_ENABLED) {
				logger.info('Skipping download monitor startup sync (disabled by config)');
				this._status = 'ready';
				this.schedulePoll(0); // Poll immediately on start
				this.scheduleBlockedExtensionCheck(true);
				return;
			}

			this.performStartupSync()
				.then(() => {
					this._status = 'ready';
					this.schedulePoll(0); // Poll immediately on start
					this.scheduleBlockedExtensionCheck(true);
				})
				.catch((err) => {
					this._error = err instanceof Error ? err : new Error(String(err));
					this._status = 'error';
					logger.error({ err: this._error }, 'Download monitor startup failed');
				});
		});
	}

	/**
	 * Perform startup sync to reconcile orphaned downloads
	 *
	 * This checks all enabled download clients for downloads that exist in the client
	 * but are not tracked in our queue. These could be:
	 * - Downloads added manually
	 * - Downloads from before app was restarted
	 * - Downloads that failed to be tracked properly
	 *
	 * We log these orphans for visibility but don't auto-add them since we don't
	 * know which media they belong to.
	 */
	private async performStartupSync(): Promise<void> {
		logger.info('Performing startup sync to check for orphaned downloads');

		try {
			// Release slot reservations whose transport is gone (crash recovery,
			// legacy rows). Runs before client sync so freed slots are grabbable.
			const reconciled = acquisitionService.reconcileStaleIntents();
			if (reconciled > 0) {
				logger.info({ reconciled }, 'Reconciled stale acquisition intents at startup');
			}

			// Recover queue rows stuck in 'importing' from a crash or ungraceful
			// restart mid-import. Nothing can legitimately still be importing
			// immediately after a fresh startup - the in-memory worker/
			// processingQueue state that would have completed it is gone, and
			// markImporting()'s atomic guard treats 'importing' as "another
			// process already has this," so without this reset a row stuck
			// here never gets picked up again and just shows as permanently
			// "active" with nothing actually processing it. Reset to
			// 'completed' so the normal poll-driven import check reconsiders it.
			const stuckImporting = await db
				.update(downloadQueue)
				.set({ status: 'completed' })
				.where(eq(downloadQueue.status, 'importing'))
				.returning({ id: downloadQueue.id, title: downloadQueue.title });
			if (stuckImporting.length > 0) {
				logger.warn(
					{ count: stuckImporting.length, items: stuckImporting },
					'Recovered queue item(s) stuck in importing status at startup'
				);
			}

			const manager = getDownloadClientManager();
			const enabledClients = await manager.getEnabledClients();

			if (enabledClients.length === 0) {
				logger.debug('No enabled download clients for startup sync');
				return;
			}

			// Get all active queue items (non-terminal)
			const activeQueueItems = await db
				.select()
				.from(downloadQueue)
				.where(
					and(
						not(inArray(downloadQueue.status, TERMINAL_STATUSES)),
						not(eq(downloadQueue.protocol, 'debrid'))
					)
				);

			// Build sets of known download IDs and info hashes for quick lookup
			const knownDownloadIds = new Set<string>();
			const knownInfoHashes = new Set<string>();

			for (const item of activeQueueItems) {
				knownDownloadIds.add(item.downloadId.toLowerCase());
				if (item.infoHash) {
					knownInfoHashes.add(item.infoHash.toLowerCase());
				}
			}

			// Sync all clients in parallel with timeout for faster startup
			const syncResults = await Promise.all(
				enabledClients.map(async ({ client, instance }) => {
					try {
						// Race between client sync and timeout
						const downloads = await Promise.race([
							instance.getDownloads(),
							new Promise<never>((_, reject) =>
								setTimeout(() => reject(new Error('Sync timeout')), STARTUP_SYNC_TIMEOUT_MS)
							)
						]);

						const orphanedDownloads: DownloadInfo[] = [];

						for (const download of downloads) {
							const hashLower = download.hash.toLowerCase();

							// Check if we're already tracking this download
							const isTracked = knownDownloadIds.has(hashLower) || knownInfoHashes.has(hashLower);

							if (!isTracked) {
								// Check if it's in our category (if client supports categories)
								const isOurCategory =
									!client.tvCategory ||
									download.category === client.tvCategory ||
									download.category === client.movieCategory;

								if (isOurCategory) {
									orphanedDownloads.push(download);
								}
							}
						}

						if (orphanedDownloads.length > 0) {
							logger.warn(
								{
									clientName: client.name,
									clientId: client.id,
									orphanCount: orphanedDownloads.length,
									orphans: orphanedDownloads.map((d) => ({
										name: d.name,
										hash: d.hash,
										status: d.status,
										progress: Math.round(d.progress * 100) + '%',
										category: d.category,
										savePath: d.savePath
									}))
								},
								'Found orphaned downloads in client not tracked by queue'
							);

							// For completed orphans, we could attempt to identify and import them
							// For now, just log them so user is aware
							const completedOrphans = orphanedDownloads.filter(
								(d) => d.progress >= 1 && d.status !== 'error'
							);

							if (completedOrphans.length > 0) {
								logger.info(
									{
										clientName: client.name,
										completedOrphans: completedOrphans.map((d) => ({
											name: d.name,
											hash: d.hash,
											savePath: d.savePath,
											contentPath: d.contentPath
										}))
									},
									'Some orphaned downloads are completed and may be ready for manual import'
								);
							}
						} else {
							logger.debug(
								{
									clientName: client.name,
									totalDownloads: downloads.length,
									trackedCount: activeQueueItems.filter((q) => q.downloadClientId === client.id)
										.length
								},
								'No orphaned downloads found in client'
							);
						}

						return orphanedDownloads.length;
					} catch (error) {
						const isTimeout = error instanceof Error && error.message === 'Sync timeout';
						logger.warn(
							isTimeout
								? 'Download client sync timed out on startup'
								: 'Failed to sync with download client on startup',
							{
								clientName: client.name,
								clientId: client.id,
								error: error instanceof Error ? error.message : String(error)
							}
						);
						return 0;
					}
				})
			);

			const totalOrphans = syncResults.reduce((sum, count) => sum + count, 0);

			if (totalOrphans > 0) {
				logger.warn(
					`Startup sync complete: found ${totalOrphans} orphaned download(s) not tracked in queue`
				);
			} else {
				logger.info('Startup sync complete: all downloads are properly tracked');
			}
		} catch (error) {
			logger.error({ err: error }, 'Failed to perform startup sync');
		}
	}

	/**
	 * Clean up orphaned completed torrents that are not tracked in the queue.
	 * This removes torrents that have met their seeding requirements (canBeRemoved=true)
	 * but were never tracked by Cinephage (legacy/manual downloads).
	 *
	 * @param dryRun If true, only reports what would be removed without actually removing
	 * @returns Summary of removed/removable torrents
	 */
	async cleanupOrphanedDownloads(dryRun = false): Promise<{
		removed: { name: string; hash: string; ratio: number }[];
		skipped: { name: string; hash: string; reason: string }[];
		errors: { name: string; hash: string; error: string }[];
	}> {
		const result = {
			removed: [] as { name: string; hash: string; ratio: number }[],
			skipped: [] as { name: string; hash: string; reason: string }[],
			errors: [] as { name: string; hash: string; error: string }[]
		};

		logger.info({ dryRun }, 'Starting orphaned download cleanup');

		try {
			const manager = getDownloadClientManager();
			const enabledClients = await manager.getEnabledClients();

			if (enabledClients.length === 0) {
				logger.info('No enabled download clients for orphan cleanup');
				return result;
			}

			// Get all tracked queue items
			const activeQueueItems = await db
				.select()
				.from(downloadQueue)
				.where(
					and(
						not(inArray(downloadQueue.status, TERMINAL_STATUSES)),
						not(eq(downloadQueue.protocol, 'debrid'))
					)
				);

			const knownHashes = new Set<string>();
			// "Actively tracked" = a genuinely in-flight row. A hash whose only rows are
			// failed or post-import is effectively an orphan: the queue-based stalled
			// handler ignores it (it only acts on 'stalled' rows and excludes 'failed'
			// from polling), so the sweep must treat it. Only 'removed' is excluded from
			// knownHashes, so without this distinction a leftover failed row would make a
			// stuck torrent look "tracked" and never get swept.
			const activeHashes = new Set<string>();
			const postImportStatusSet = new Set<string>(POST_IMPORT_STATUSES);
			for (const item of activeQueueItems) {
				knownHashes.add(item.downloadId.toLowerCase());
				if (item.infoHash) {
					knownHashes.add(item.infoHash.toLowerCase());
				}
				if (item.status !== 'failed' && !postImportStatusSet.has(item.status)) {
					activeHashes.add(item.downloadId.toLowerCase());
					if (item.infoHash) {
						activeHashes.add(item.infoHash.toLowerCase());
					}
				}
			}

			// Stalled-orphan handling settings (a timeout of 0 disables it). These let the
			// sweep also remove torrents in our categories that are stuck stalled but not
			// actively tracked — the completed-orphan logic below only removes finished
			// torrents, so stalled ones would otherwise linger forever.
			const stalledTimeoutMinutes = await this.getStalledTimeoutMinutes();
			const stalledProgressTimeoutMinutes = await this.getStalledProgressTimeoutMinutes();
			const stalledHandlingEnabled = stalledTimeoutMinutes > 0 || stalledProgressTimeoutMinutes > 0;
			const stalledTimeoutMs =
				Math.max(stalledTimeoutMinutes, DownloadMonitorService.MIN_STALLED_TIMEOUT_MINUTES) *
				60 *
				1000;
			const stalledProgressTimeoutMs =
				Math.max(
					stalledProgressTimeoutMinutes,
					DownloadMonitorService.MIN_STALLED_TIMEOUT_MINUTES
				) *
				60 *
				1000;
			const stalledProgressThreshold = await this.getStalledProgressThreshold();
			const stalledBlocklistHours = await this.getStalledBlocklistHours();
			const sweepNow = Date.now();

			for (const { client, instance } of enabledClients) {
				try {
					const downloads = await instance.getDownloads();

					// Hashes currently stalled in our categories — used to prune stale tracking
					// rows for torrents that have since recovered or disappeared.
					const seenStalledHashes = new Set<string>();

					for (const download of downloads) {
						const hashLower = download.hash.toLowerCase();

						// Skip if not in our category
						const isOurCategory =
							!client.tvCategory ||
							download.category === client.tvCategory ||
							download.category === client.movieCategory;

						if (!isOurCategory) {
							continue;
						}

						// Stalled/stuck orphan: a torrent stuck stalled in our category with no
						// active queue row (untracked, or only failed/terminal rows). Items WITH an
						// active row are owned by the queue-based handleStalledDownloads, so we leave
						// those to it. Checked before the knownHashes skip so failed-only torrents
						// (which are in knownHashes but not active) still get swept.
						if (stalledHandlingEnabled && download.status === 'stalled') {
							if (!activeHashes.has(hashLower)) {
								seenStalledHashes.add(hashLower);
								await this.handleStalledOrphan(
									client.id,
									instance,
									download,
									{
										progressThreshold: stalledProgressThreshold,
										timeoutMs: stalledTimeoutMs,
										progressTimeoutMs: stalledProgressTimeoutMs,
										blocklistHours: stalledBlocklistHours,
										now: sweepNow,
										dryRun
									},
									result
								);
							}
							continue;
						}

						// Completed/seeding orphan path: skip anything tracked by a non-removed row.
						if (knownHashes.has(hashLower)) {
							continue;
						}

						// Check if it can be removed (completed + met seeding limits)
						if (!download.canBeRemoved) {
							result.skipped.push({
								name: download.name,
								hash: download.hash,
								reason:
									download.progress < 1
										? 'Still downloading'
										: 'Still seeding (limits not met or not paused)'
							});
							continue;
						}

						// This orphan can be removed
						if (dryRun) {
							result.removed.push({
								name: download.name,
								hash: download.hash,
								ratio: download.ratio || 0
							});
							logger.info(
								{
									name: download.name,
									hash: download.hash,
									ratio: download.ratio,
									seedingTime: download.seedingTime
								},
								'[DRY RUN] Would remove orphaned torrent'
							);
						} else {
							try {
								await instance.removeDownload(download.hash, false);
								result.removed.push({
									name: download.name,
									hash: download.hash,
									ratio: download.ratio || 0
								});
								logger.info(
									{
										name: download.name,
										hash: download.hash,
										ratio: download.ratio,
										seedingTime: download.seedingTime
									},
									'Removed orphaned torrent'
								);
							} catch (removeError) {
								result.errors.push({
									name: download.name,
									hash: download.hash,
									error: removeError instanceof Error ? removeError.message : String(removeError)
								});
							}
						}
					}

					// Drop tracking rows for torrents that are no longer stalled (recovered)
					// or have disappeared from the client.
					if (stalledHandlingEnabled && !dryRun) {
						await this.pruneStalledOrphanTracking(client.id, seenStalledHashes);
					}
				} catch (error) {
					logger.error(
						{ err: error, clientName: client.name },
						'Failed to process client for orphan cleanup'
					);
				}
			}
		} catch (error) {
			logger.error({ err: error }, 'Failed to cleanup orphaned downloads');
		}

		logger.info(
			{
				dryRun,
				removed: result.removed.length,
				skipped: result.skipped.length,
				errors: result.errors.length
			},
			'Orphaned download cleanup complete'
		);

		return result;
	}

	/**
	 * Handle a single stalled "orphan": a torrent in one of our categories that is
	 * stuck stalled but is not actively tracked in the queue. Applies the same
	 * progress-threshold and timeout gates as the queue-based handler, using a
	 * persisted per-hash timer so the timeout survives restarts. The tracking row is
	 * deliberately kept after a delete, so a delete that doesn't take effect is retried
	 * on the next sweep (the row is pruned once the torrent actually disappears).
	 */
	private async handleStalledOrphan(
		clientId: string,
		instance: IDownloadClient,
		download: DownloadInfo,
		opts: {
			progressThreshold: number;
			timeoutMs: number;
			progressTimeoutMs: number;
			blocklistHours: number;
			now: number;
			dryRun: boolean;
		},
		result: {
			removed: { name: string; hash: string; ratio: number }[];
			skipped: { name: string; hash: string; reason: string }[];
			errors: { name: string; hash: string; error: string }[];
		}
	): Promise<void> {
		// Two-tier timeout: high-progress orphans get the much longer progress
		// window (a seeder may return); low-progress orphans use the short one.
		const isHighProgress = download.progress * 100 > opts.progressThreshold;
		const tierTimeoutMs = isHighProgress ? opts.progressTimeoutMs : opts.timeoutMs;

		const hashLower = download.hash.toLowerCase();
		const [tracked] = await db
			.select({ firstStalledAt: stalledOrphanTracking.firstStalledAt })
			.from(stalledOrphanTracking)
			.where(
				and(
					eq(stalledOrphanTracking.downloadClientId, clientId),
					eq(stalledOrphanTracking.infoHash, hashLower)
				)
			)
			.limit(1);

		const firstStalledMs = tracked ? Date.parse(tracked.firstStalledAt) : opts.now;
		const elapsed = opts.now - firstStalledMs;
		const timedOut = Number.isFinite(firstStalledMs) && elapsed >= tierTimeoutMs;

		if (opts.dryRun) {
			if (timedOut) {
				result.removed.push({
					name: download.name,
					hash: download.hash,
					ratio: download.ratio || 0
				});
			} else {
				result.skipped.push({
					name: download.name,
					hash: download.hash,
					reason: 'Stalled, waiting for timeout'
				});
			}
			return;
		}

		// Start the timer the first time we see it stalled.
		if (!tracked) {
			await db
				.insert(stalledOrphanTracking)
				.values({
					downloadClientId: clientId,
					infoHash: hashLower,
					firstStalledAt: new Date(opts.now).toISOString()
				})
				.onConflictDoNothing();
			logger.info(
				{ name: download.name, hash: download.hash, timeoutMs: opts.timeoutMs },
				'Tracking stalled orphaned torrent (timer started)'
			);
			result.skipped.push({
				name: download.name,
				hash: download.hash,
				reason: 'Stalled, tracking started'
			});
			return;
		}

		if (!timedOut) {
			result.skipped.push({
				name: download.name,
				hash: download.hash,
				reason: 'Stalled, waiting for timeout'
			});
			return;
		}

		// Timed out: remove from client. Keep the tracking row so a delete that doesn't
		// take effect is retried on the next sweep.
		try {
			await instance.removeDownload(download.hash, true);
		} catch (removeError) {
			const message = removeError instanceof Error ? removeError.message : String(removeError);
			logger.warn(
				{ name: download.name, hash: download.hash, error: message },
				'Failed to remove stalled orphaned torrent; will retry next sweep'
			);
			result.errors.push({ name: download.name, hash: download.hash, error: message });
			return;
		}

		result.removed.push({ name: download.name, hash: download.hash, ratio: download.ratio || 0 });
		logger.info(
			{ name: download.name, hash: download.hash, elapsedMinutes: Math.round(elapsed / 60000) },
			'Removed stalled orphaned torrent'
		);

		// Blocklist the hash so it isn't immediately re-grabbed (permanent when configured).
		try {
			const { blocklistService } =
				await import('#lib/server/monitoring/specifications/BlocklistSpecification.js');
			blocklistService.addToBlocklist(
				{ title: download.name, infoHash: download.hash, protocol: 'torrent' },
				{
					reason: 'download_failed',
					message: 'Stalled orphan auto-removed',
					expiresInHours: opts.blocklistHours > 0 ? opts.blocklistHours : undefined
				}
			);
		} catch (blocklistError) {
			logger.warn(
				{
					name: download.name,
					error: blocklistError instanceof Error ? blocklistError.message : String(blocklistError)
				},
				'Failed to blocklist stalled orphan'
			);
		}
	}

	/**
	 * Remove stalled-orphan tracking rows for a client whose hashes are no longer
	 * stalled (recovered) or are no longer present in the client.
	 */
	private async pruneStalledOrphanTracking(
		clientId: string,
		seenStalledHashes: Set<string>
	): Promise<void> {
		const rows = await db
			.select({ infoHash: stalledOrphanTracking.infoHash })
			.from(stalledOrphanTracking)
			.where(eq(stalledOrphanTracking.downloadClientId, clientId));

		const stale = rows.map((r) => r.infoHash).filter((h) => !seenStalledHashes.has(h));
		if (stale.length === 0) return;

		await db
			.delete(stalledOrphanTracking)
			.where(
				and(
					eq(stalledOrphanTracking.downloadClientId, clientId),
					inArray(stalledOrphanTracking.infoHash, stale)
				)
			);
	}

	/**
	 * Clear failed queue items from the database.
	 * Optionally filters by age (e.g., only clear items older than X days).
	 *
	 * @param options.olderThanDays - Only clear items that failed more than X days ago
	 * @param options.dryRun - Preview what would be removed without actually removing
	 * @returns Summary of cleared items
	 */
	async clearFailedItems(
		options: {
			olderThanDays?: number;
			dryRun?: boolean;
		} = {}
	): Promise<{
		cleared: { id: string; title: string; errorMessage?: string | null }[];
		total: number;
	}> {
		const { olderThanDays, dryRun = false } = options;

		logger.info({ olderThanDays, dryRun }, 'Clearing failed queue items');

		const ageCutoffCondition =
			olderThanDays !== undefined && olderThanDays > 0
				? sql`coalesce(${downloadQueue.lastAttemptAt}, ${downloadQueue.addedAt}) < ${new Date(
						Date.now() - olderThanDays * 24 * 60 * 60 * 1000
					).toISOString()}`
				: undefined;

		const failedItems = await db
			.select()
			.from(downloadQueue)
			.where(
				ageCutoffCondition
					? and(eq(downloadQueue.status, 'failed'), ageCutoffCondition)
					: eq(downloadQueue.status, 'failed')
			);

		const result = {
			cleared: [] as { id: string; title: string; errorMessage?: string | null }[],
			total: failedItems.length
		};

		if (dryRun) {
			// Just return what would be cleared
			result.cleared = failedItems.map((item) => ({
				id: item.id,
				title: item.title,
				errorMessage: item.errorMessage
			}));
		} else {
			// Actually clear the items
			for (const item of failedItems) {
				try {
					// Suppress automatic re-addition from the download client during the
					// tombstone window. Note: explicit user-initiated relinks (relinkOrphanedDownloads)
					// bypass the tombstone by design — they use a direct db.insert.
					await upsertQueueTombstoneFromQueueItem(item, 'local_remove_without_client_delete');

					await db.delete(downloadQueue).where(eq(downloadQueue.id, item.id));

					result.cleared.push({
						id: item.id,
						title: item.title,
						errorMessage: item.errorMessage
					});

					this.emit('queue:removed', item.id);
					this.emitSSE('queue:removed', { id: item.id });
				} catch (error) {
					logger.error(
						{
							id: item.id,
							title: item.title,
							error: error instanceof Error ? error.message : String(error)
						},
						'Failed to clear failed item'
					);
				}
			}
		}

		logger.info(
			{
				dryRun,
				cleared: result.cleared.length,
				total: result.total
			},
			'Failed queue items cleared'
		);

		return result;
	}

	/**
	 * Stop the monitoring service
	 * Implements BackgroundService.stop()
	 */
	async stop(): Promise<void> {
		if (!this.isRunning) return;

		this.isRunning = false;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.blockedExtensionTimer) {
			clearTimeout(this.blockedExtensionTimer);
			this.blockedExtensionTimer = null;
		}
		this._status = 'pending';
		logger.info('Stopped download monitor service');
	}

	/**
	 * Register an SSE client for real-time updates
	 */
	registerSSEClient(callback: (event: QueueEvent) => void): () => void {
		this.sseClients.add(callback);
		return () => this.sseClients.delete(callback);
	}

	/**
	 * Emit an event to SSE clients
	 */
	private emitSSE(type: QueueEvent['type'], data: QueueEvent['data']): void {
		const event: QueueEvent = {
			type,
			data,
			timestamp: new Date().toISOString()
		};

		const failedClients: Array<(event: QueueEvent) => void> = [];
		for (const client of this.sseClients) {
			try {
				client(event);
			} catch (error) {
				logger.warn({ error }, 'Failed to send SSE event, removing client');
				failedClients.push(client);
			}
		}
		// Remove failed clients to prevent accumulation
		for (const client of failedClients) {
			this.sseClients.delete(client);
		}
	}

	/**
	 * Schedule the next poll
	 */
	private schedulePoll(delayMs?: number): void {
		if (!this.isRunning) return;

		const interval =
			delayMs ?? (this.activeDownloadCount > 0 ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_IDLE);

		this.pollTimer = setTimeout(() => this.poll(), interval);
	}

	/**
	 * Poll all download clients and update queue
	 */
	async poll(): Promise<void> {
		if (!this.isRunning) return;

		// Prevent concurrent polls (e.g., from forcePoll while regular poll is running)
		if (this.isPolling) {
			logger.debug('Skipping poll - another poll is already in progress');
			return;
		}

		this.isPolling = true;
		const startTime = Date.now();
		this.lastPollTime = startTime;

		try {
			await this.pollClients();

			// Periodic orphan cleanup (every 10 minutes)
			if (
				startTime - this.lastOrphanCleanupTime >
				DownloadMonitorService.ORPHAN_CLEANUP_INTERVAL_MS
			) {
				this.lastOrphanCleanupTime = startTime;
				// Run orphan cleanup in background (don't block polling)
				this.runOrphanCleanup().catch((err) => {
					logger.warn(
						{
							error: err instanceof Error ? err.message : String(err)
						},
						'Orphan cleanup failed'
					);
				});
			}

			if (startTime - this.lastQueueTombstoneCleanupTime > QUEUE_TOMBSTONE_CLEANUP_INTERVAL_MS) {
				this.lastQueueTombstoneCleanupTime = startTime;
				this.runQueueTombstoneCleanup().catch((err) => {
					logger.warn(
						{
							error: err instanceof Error ? err.message : String(err)
						},
						'Queue tombstone cleanup failed'
					);
				});
			}
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'Error during download poll'
			);
		} finally {
			this.isPolling = false;
		}

		// Schedule next poll
		this.schedulePoll();
	}

	/**
	 * Run orphan cleanup in background
	 */
	private async runOrphanCleanup(): Promise<void> {
		logger.debug('Running periodic orphan cleanup');
		const result = await this.cleanupOrphanedDownloads(false);
		if (result.removed.length > 0) {
			logger.info(
				{
					removed: result.removed.length,
					skipped: result.skipped.length,
					errors: result.errors.length
				},
				'Orphan cleanup completed'
			);
		}
	}

	/**
	 * Force an immediate poll (useful after a grab)
	 */
	async forcePoll(): Promise<void> {
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
		await this.poll();
	}

	/**
	 * Poll all enabled download clients
	 */
	private async pollClients(): Promise<void> {
		const manager = getDownloadClientManager();
		const enabledClients = await manager.getEnabledClients();

		if (enabledClients.length === 0) {
			this.activeDownloadCount = 0;
			return;
		}

		// Get queue items that need polling (exclude terminal and post-import statuses).
		// Failed items are intentionally kept in polling so that transient errors
		// (e.g. tracker HTTP 500) that self-resolve in the download client are
		// detected and the status is restored to downloading/completed automatically.
		// handleMissingDownload() has a safe guard that no-ops for failed items
		// that are no longer present in the client.
		const queueItems = await db
			.select()
			.from(downloadQueue)
			.where(
				and(
					not(inArray(downloadQueue.status, TERMINAL_STATUSES)),
					not(inArray(downloadQueue.status, POST_IMPORT_STATUSES)),
					not(eq(downloadQueue.protocol, 'debrid'))
				)
			);

		// Group by client
		const itemsByClient = new Map<string, (typeof queueItems)[0][]>();
		for (const item of queueItems) {
			const existing = itemsByClient.get(item.downloadClientId) || [];
			existing.push(item);
			itemsByClient.set(item.downloadClientId, existing);
		}

		let totalActive = 0;

		// Poll each client
		for (const { client, instance } of enabledClients) {
			try {
				const clientItems = itemsByClient.get(client.id) || [];
				const activeCount = await this.pollClient(client, instance, clientItems);
				totalActive += activeCount;
			} catch (error) {
				logger.error(
					{
						clientId: client.id,
						clientName: client.name,
						error: error instanceof Error ? error.message : String(error)
					},
					'Failed to poll download client'
				);
			}
		}

		this.activeDownloadCount = totalActive;

		// Check for and remove completed downloads that have met seeding requirements
		// This follows Radarr's pattern of removing after seeding is done
		await this.removeCompletedDownloads(enabledClients);

		// Handle stalled downloads that have timed out
		await this.handleStalledDownloads();

		// Note: Pending import retries are now handled by ImportService

		// Emit stats update
		const stats = await this.getStats();
		this.emitSSE('queue:stats', stats);
	}

	/**
	 * Remove completed downloads that have met their seeding requirements.
	 * Follows Radarr's RemoveCompletedDownloads pattern.
	 *
	 * This checks for queue items that are 'imported' or 'seeding-imported' and whose torrent
	 * has canBeRemoved=true (paused after reaching seed limits).
	 */
	private async removeCompletedDownloads(
		enabledClients: { client: DownloadClient; instance: IDownloadClient }[]
	): Promise<void> {
		// Get imported queue items that haven't been cleaned up yet
		// Check both 'imported' (usenet) and 'seeding-imported' (torrents still seeding)
		const importedItems = await db
			.select()
			.from(downloadQueue)
			.where(inArray(downloadQueue.status, ['imported', 'seeding-imported']));

		if (importedItems.length === 0) {
			return;
		}

		// Maps for quick lookup: the instance for client calls, and the hydrated
		// config for the per-client removal policy.
		const clientMap = new Map<string, IDownloadClient>();
		const clientConfigMap = new Map<string, DownloadClient>();
		for (const { client, instance } of enabledClients) {
			clientMap.set(client.id, instance);
			clientConfigMap.set(client.id, client);
		}

		for (const item of importedItems) {
			const clientInstance = clientMap.get(item.downloadClientId);
			if (!clientInstance) {
				continue;
			}
			const clientConfig = clientConfigMap.get(item.downloadClientId);

			try {
				// Check if the download still exists and can be removed
				const downloadHash = item.infoHash || item.downloadId;
				const download = await clientInstance.getDownload(downloadHash);

				if (!download) {
					// Download already removed from client, clean up queue entry
					logger.debug(
						{
							title: item.title,
							hash: downloadHash,
							protocol: item.protocol
						},
						'Download already removed from client, cleaning up queue entry'
					);
					await db.delete(downloadQueue).where(eq(downloadQueue.id, item.id));
					this.emit('queue:removed', item.id);
					this.emitSSE('queue:removed', { id: item.id });
					continue;
				}

				if (download.canBeRemoved && (clientConfig?.removeAfterImport ?? true)) {
					// Download has met requirements (seeding limits for torrents, completed for usenet)
					// and the client's remove-after-import policy allows removal.
					logger.info(
						{
							title: item.title,
							hash: downloadHash,
							protocol: item.protocol,
							ratio: download.ratio,
							seedingTime: download.seedingTime,
							ratioLimit: download.ratioLimit,
							seedingTimeLimit: download.seedingTimeLimit
						},
						'Removing completed download from client'
					);

					const deleteFiles = item.protocol === 'torrent';
					await clientInstance.removeDownload(downloadHash, deleteFiles);

					// Clean up queue entry
					await db.delete(downloadQueue).where(eq(downloadQueue.id, item.id));

					logger.info(
						{
							title: item.title,
							hash: downloadHash,
							protocol: item.protocol,
							deleteFiles
						},
						'Successfully removed completed download'
					);

					this.emit('queue:removed', item.id);
					this.emitSSE('queue:removed', { id: item.id });
				} else if (download.canBeRemoved) {
					// Goals met, but this client's remove-after-import policy keeps
					// the torrent in the client (user opted out of auto-removal).
					logger.debug(
						{
							title: item.title,
							hash: downloadHash,
							ratio: download.ratio,
							status: download.status
						},
						'Download met seed goals but client policy keeps it'
					);
				} else {
					// Still seeding/processing, leave it alone
					logger.debug(
						{
							title: item.title,
							hash: downloadHash,
							ratio: download.ratio,
							status: download.status,
							canBeRemoved: download.canBeRemoved
						},
						'Imported download still active'
					);
				}
			} catch (error) {
				logger.warn(
					{
						title: item.title,
						error: error instanceof Error ? error.message : String(error)
					},
					'Failed to check/remove completed download'
				);
			}
		}
	}

	private async runQueueTombstoneCleanup(): Promise<void> {
		await cleanupExpiredQueueTombstones();
	}

	/**
	 * Poll a single download client
	 */
	private async pollClient(
		client: DownloadClient,
		instance: IDownloadClient,
		queueItems: (typeof downloadQueue.$inferSelect)[]
	): Promise<number> {
		// Get all downloads from this client
		const downloads = await instance.getDownloads();
		const clientProtocol =
			client.implementation === 'sabnzbd' || client.implementation === 'nzbget'
				? 'usenet'
				: 'torrent';
		await extendQueueTombstonesFromDownloads({
			downloadClientId: client.id,
			protocol: clientProtocol,
			downloads
		});

		// Create a map for quick lookup by download ID (hash)
		const downloadMap = new Map<string, DownloadInfo>();
		for (const dl of downloads) {
			downloadMap.set(dl.hash.toLowerCase(), dl);
		}

		let activeCount = 0;

		// Update each queue item
		for (const queueItem of queueItems) {
			// Try multiple strategies to find the download:
			// 1. By downloadId (primary)
			// 2. By stored infoHash
			// 3. By extracting hash from magnetUrl
			// 4. By title (SABnzbd only - nzo_id changes on re-grab)
			let download = downloadMap.get(queueItem.downloadId.toLowerCase());
			let matchedBy: 'downloadId' | 'infoHash' | 'magnetUrl' | 'title' | null = download
				? 'downloadId'
				: null;

			// Fallback: try infoHash if stored
			if (!download && queueItem.infoHash) {
				download = downloadMap.get(queueItem.infoHash.toLowerCase());
				if (download) matchedBy = 'infoHash';
			}

			// Fallback: try extracting hash from magnetUrl
			if (!download && queueItem.magnetUrl) {
				const extractedHash = resolveInfoHash(queueItem.magnetUrl);
				if (extractedHash) {
					download = downloadMap.get(extractedHash.toLowerCase());
					if (download) matchedBy = 'magnetUrl';
				}
			}

			// Fallback for SABnzbd-compatible clients: try matching by title
			// SABnzbd generates new nzo_id when downloads are re-added,
			// unlike torrent hashes which are persistent
			if (!download && client.implementation === 'sabnzbd') {
				download = downloads.find((d) => d.name.toLowerCase() === queueItem.title.toLowerCase());
				if (download) matchedBy = 'title';
			}

			if (download) {
				// If we matched by a fallback method, update downloadId for future lookups
				if (matchedBy && matchedBy !== 'downloadId') {
					logger.info(
						{
							title: queueItem.title,
							oldDownloadId: queueItem.downloadId,
							newDownloadId: download.hash,
							matchedBy
						},
						'Updating downloadId from fallback match'
					);
					await db
						.update(downloadQueue)
						.set({
							downloadId: download.hash,
							infoHash: queueItem.infoHash || download.hash
						})
						.where(eq(downloadQueue.id, queueItem.id));
					// Update local reference for the rest of this iteration
					queueItem.downloadId = download.hash;
				}

				// Count active downloads for adaptive polling
				const isNowDownloading = download.status === 'downloading';

				if (isNowDownloading || download.status === 'queued') {
					activeCount++;
				}

				await this.updateQueueItem(queueItem, download, client);

				// Radarr pattern: Check every completed download on every poll
				// This catches downloads that:
				// - Just finished
				// - Were already complete when we started tracking
				// - Completed between polls
				// Don't rely on transition detection which can miss fast downloads
				const isReadyForImport =
					download.status === 'completed' ||
					(download.status === 'seeding' && download.progress >= 1) ||
					(download.status === 'paused' && download.progress >= 1);

				// Only check items that haven't been imported yet
				// Radarr checks items in 'Downloading' or 'ImportBlocked' state
				const canBeChecked =
					queueItem.status === 'downloading' ||
					queueItem.status === 'queued' ||
					queueItem.status === 'seeding' ||
					queueItem.status === 'completed' ||
					queueItem.status === 'stalled';

				if (isReadyForImport && canBeChecked && !queueItem.importedAt) {
					// This download is ready for import - request import via ImportService
					const updatedItem = await this.getQueueItem(queueItem.id);
					if (updatedItem) {
						this.emit('queue:completed', updatedItem);
						this.emitSSE('queue:completed', updatedItem);

						// Request import through ImportService (handles all validation and deduplication)
						const importService = await getImportService();
						importService.requestImport(updatedItem.id).catch((err) => {
							logger.error(
								{
									queueId: updatedItem.id,
									title: updatedItem.title,
									error: err instanceof Error ? err.message : String(err)
								},
								'Failed to request import for completed download'
							);
						});
					}
				}
			} else {
				// Download no longer exists in client
				// This could mean it was removed or finished seeding
				await this.handleMissingDownload(queueItem, client, downloads);
			}
		}

		return activeCount;
	}

	/**
	 * Update a queue item from download client data
	 */
	private async updateQueueItem(
		queueItem: typeof downloadQueue.$inferSelect,
		download: DownloadInfo,
		client: DownloadClient
	): Promise<void> {
		const now = new Date().toISOString();

		// Use contentPath (full path to torrent folder/file) for import
		// contentPath is the actual location of the downloaded files
		// savePath is just the parent directory, and for a metadata-less
		// magnet it is the save/category root. Storing that as outputPath
		// would let recovery adopt every other torrent under it (#532), so
		// torrents without a contentPath keep a null outputPath instead.
		// Use user-configured path mappings for both completed and temp folders
		const newClientDownloadPath = getDownloadContentPath(download, queueItem.protocol);
		const outputPath = newClientDownloadPath
			? mapClientPathToLocal(
					newClientDownloadPath,
					client.downloadPathLocal,
					client.downloadPathRemote ?? null,
					client.tempPathLocal,
					client.tempPathRemote
				)
			: null;

		// Determine new status
		const newStatus = mapDownloadStatusToQueueStatus(download.status, download.progress);

		// Check if this is meaningful change
		const oldProgress = parseFloat(queueItem.progress || '0');
		const progressChanged = Math.abs(download.progress - oldProgress) > 0.001;
		const statusChanged = queueItem.status !== newStatus;
		const pathChanged =
			queueItem.clientDownloadPath !== newClientDownloadPath || queueItem.outputPath !== outputPath;

		// Detect torrent metadata resolution (magnet → metadata loaded)
		// qBittorrent: stalled (metaDL) → downloading; Transmission: size becomes known
		if (queueItem.protocol === 'torrent') {
			const exitedStalled = newStatus !== 'stalled' && queueItem.status === 'stalled';
			const sizeBecameKnown = download.size > 0 && (!queueItem.size || queueItem.size <= 0);
			if (exitedStalled || sizeBecameKnown) {
				const cacheKey = queueItem.infoHash || queueItem.downloadId;
				this.blockedExtensionCheckedHashes.delete(cacheKey);
				this.scheduleBlockedExtensionCheck(true);
			}
		}

		// Build update object
		const updates: Partial<typeof downloadQueue.$inferInsert> = {
			progress: download.progress.toString(),
			size: shouldPreservePointerSize(queueItem, download) ? queueItem.size : download.size,
			downloadSpeed: download.downloadSpeed,
			uploadSpeed: download.uploadSpeed,
			eta: download.eta,
			ratio: download.ratio?.toString() || '0',
			clientDownloadPath: newClientDownloadPath,
			outputPath,
			status: newStatus
		};

		// If the item has exhausted its import attempts, keep it permanently failed.
		// The download client (e.g. SABnzbd history) reports 'completed' forever, but
		// the failure is on Cinephage's import side, not the client's and should not
		// be treated as a client-side recovery.
		if (queueItem.importFailed && queueItem.status === 'failed') {
			return;
		}

		// Track when the download entered the stalled state so handleStalledDownloads()
		// can apply the timeout. The timer is persisted (survives restarts) and is
		// deliberately resistant to flapping: a magnet that briefly flips metaDL →
		// downloading → metaDL without gaining any data must NOT reset its clock, or it
		// would never time out. So we only start the timer when entering stalled, and
		// only clear it once the download actually makes forward progress.
		if (newStatus === 'stalled') {
			if (!queueItem.stalledSince) {
				updates.stalledSince = now;
			}
		} else if (queueItem.stalledSince && download.progress > oldProgress) {
			updates.stalledSince = null;
		}

		// Set startedAt on first download progress
		if (newStatus === 'downloading' && !queueItem.startedAt) {
			updates.startedAt = now;
		}

		// Set completedAt when finished downloading
		if ((newStatus === 'completed' || newStatus === 'seeding') && !queueItem.completedAt) {
			updates.completedAt = now;
		}

		// Capture error message and timestamp when download fails
		if (newStatus === 'failed') {
			if (download.errorMessage) {
				updates.errorMessage = download.errorMessage;
			}
			updates.lastAttemptAt = now;
		}

		// Clear error state when a previously-failed download recovers
		// (e.g. tracker HTTP 5xx resolved and qBittorrent resumes the torrent)
		if (queueItem.status === 'failed' && newStatus !== 'failed') {
			updates.errorMessage = null;
			updates.lastAttemptAt = null;
			// A recovery means a NEW download attempt was started (the previous one
			// was removed by the stalled-timeout). The stalled clock belongs to the
			// old torrent instance — carrying it over would let handleStalledDownloads
			// instantly delete the freshly re-added torrent. Reset it and let the
			// stalled transition below stamp a new one.
			updates.stalledSince = null;
		}

		// Only update if something changed
		if (statusChanged || progressChanged || pathChanged) {
			await db.update(downloadQueue).set(updates).where(eq(downloadQueue.id, queueItem.id));

			// When a failed download recovers, remove the failed history record so it
			// no longer appears in Activity > History as a permanent failure.
			if (queueItem.status === 'failed' && newStatus !== 'failed' && queueItem.addedAt) {
				await db
					.delete(downloadHistory)
					.where(
						and(
							eq(downloadHistory.status, 'failed'),
							eq(downloadHistory.title, queueItem.title),
							eq(downloadHistory.grabbedAt, queueItem.addedAt)
						)
					);
				logger.info(
					{ title: queueItem.title, newStatus },
					'Download recovered from failed state, removed failed history record'
				);
				activityStreamEvents.emitRefresh({
					action: 'download_recovered',
					timestamp: now
				});
			}

			// Emit update event
			const updatedItem = await this.getQueueItem(queueItem.id);
			if (updatedItem) {
				const transitionedToFailed =
					queueItem.status !== 'failed' && updatedItem.status === 'failed';
				if (transitionedToFailed) {
					const failureMessage = updatedItem.errorMessage ?? 'Download client reported an error';
					await this.createFailedHistoryRecord(updatedItem, failureMessage);
					// Terminal queue state must release the acquisition intent
					// (slot + identity), or the target stays wedged until restart.
					acquisitionService.failByQueueId(updatedItem.id, failureMessage);

					// Auto-blocklist the failed release so future searches don't
					// re-grab it (issue #618).
					try {
						const blocklistHours = await this.getStalledBlocklistHours();
						const { blocklistService } =
							await import('#lib/server/monitoring/specifications/BlocklistSpecification.js');
						await blocklistService.addToBlocklist(
							{
								title: updatedItem.title,
								infoHash: updatedItem.infoHash ?? undefined,
								indexerId: updatedItem.indexerId ?? undefined,
								quality: updatedItem.quality ?? undefined,
								size: updatedItem.size ?? undefined,
								protocol: updatedItem.protocol
							},
							{
								movieId: updatedItem.movieId ?? undefined,
								seriesId: updatedItem.seriesId ?? undefined,
								episodeIds: updatedItem.episodeIds ?? undefined,
								reason: 'download_failed',
								message: failureMessage,
								expiresInHours: blocklistHours > 0 ? blocklistHours : undefined
							}
						);
					} catch (blocklistError) {
						logger.warn(
							{
								title: updatedItem.title,
								error:
									blocklistError instanceof Error ? blocklistError.message : String(blocklistError)
							},
							'Failed to add failed release to blocklist'
						);
					}

					this.emit('queue:failed', updatedItem);
					this.emitSSE('queue:failed', updatedItem);
					return;
				}

				this.emit('queue:updated', updatedItem);
				this.emitSSE('queue:updated', updatedItem);
			}
		}
	}

	/**
	 * Mark a recovered missing download as completed and request import.
	 * Shared by the initial recovery path and the awaiting backoff retry so
	 * both tiers behave identically.
	 */
	private async completeRecoveredDownload(
		queueId: string,
		options: { outputPath?: string; completedAtFallback: string }
	): Promise<void> {
		const updates: Partial<typeof downloadQueue.$inferInsert> = {
			status: 'completed',
			completedAt: options.completedAtFallback,
			errorMessage: null,
			importAttempts: 0,
			lastAttemptAt: null
		};
		if (options.outputPath) {
			updates.outputPath = options.outputPath;
		}

		await db.update(downloadQueue).set(updates).where(eq(downloadQueue.id, queueId));

		const recoveredItem = await this.getQueueItem(queueId);
		if (recoveredItem) {
			this.emit('queue:completed', recoveredItem);
			this.emitSSE('queue:completed', recoveredItem);

			const importService = await getImportService();
			importService.requestImport(recoveredItem.id).catch((err) => {
				logger.error(
					{
						queueId: recoveredItem.id,
						title: recoveredItem.title,
						error: err instanceof Error ? err.message : String(err)
					},
					'Failed to request import for recovered download'
				);
			});
		}
	}

	/**
	 * Handle a download that's no longer in the client
	 */
	private async handleMissingDownload(
		queueItem: typeof downloadQueue.$inferSelect,
		client: DownloadClient,
		allDownloads: DownloadInfo[]
	): Promise<void> {
		// If it was importing or already imported, don't change anything
		if (queueItem.status === 'importing' || queueItem.status === 'imported') {
			return;
		}
		if (isImportedQueueStatus(queueItem.status)) {
			return;
		}
		if (queueItem.importFailed && queueItem.status === 'failed') {
			return;
		}

		// Awaiting items: exponential backoff retry for vanished downloads
		if (queueItem.status === 'awaiting') {
			const attempts = queueItem.importAttempts || 0;
			const backoffMinutes = Math.min(5 * Math.pow(2, attempts - 1), 60);
			const lastAttempt = queueItem.lastAttemptAt ? new Date(queueItem.lastAttemptAt).getTime() : 0;
			const elapsed = Date.now() - lastAttempt;

			if (elapsed < backoffMinutes * 60_000) {
				return; // Not time yet
			}

			// Max 12 recovery attempts
			if (attempts >= 12) {
				await db
					.update(downloadQueue)
					.set({
						status: 'failed',
						errorMessage: 'Download removed from client unexpectedly (recovery exhausted)'
					})
					.where(eq(downloadQueue.id, queueItem.id));

				const failedItem = await this.getQueueItem(queueItem.id);
				if (failedItem) {
					await this.createFailedHistoryRecord(
						failedItem,
						'Download removed from client unexpectedly (recovery exhausted)'
					);
					acquisitionService.failByQueueId(
						queueItem.id,
						'Download removed from client unexpectedly (recovery exhausted)'
					);
					this.emit('queue:failed', failedItem);
					this.emitSSE('queue:failed', failedItem);
				}
				return;
			}

			const completedAtFallback = queueItem.completedAt || new Date().toISOString();

			// Tier 1: re-check the stored output path. Covers delayed-sync
			// (e.g. Syncthing/Resilio) where the completed files appear at the
			// original path after the client already dropped the download. This
			// works even when the client has no downloadPathLocal configured.
			if (
				queueItem.outputPath &&
				(await isSafeRecoveryCandidate(queueItem.outputPath, queueItem, client, allDownloads))
			) {
				await this.completeRecoveredDownload(queueItem.id, { completedAtFallback });
				return;
			}

			// Tier 2: re-check the reconstructed completed path.
			const category = queueItem.seriesId ? client.tvCategory : client.movieCategory;
			if (client.downloadPathLocal) {
				const recoveryPath = buildTorrentRecoveryPath(
					queueItem.outputPath || '',
					client.downloadPathLocal,
					category
				);
				if (
					recoveryPath &&
					(await isSafeRecoveryCandidate(recoveryPath, queueItem, client, allDownloads))
				) {
					await this.completeRecoveredDownload(queueItem.id, {
						outputPath: recoveryPath,
						completedAtFallback
					});
					return;
				}
			}

			// Update attempt counter and timestamp
			await db
				.update(downloadQueue)
				.set({
					importAttempts: attempts + 1,
					lastAttemptAt: new Date().toISOString()
				})
				.where(eq(downloadQueue.id, queueItem.id));
			return;
		}

		// Grace period before considering a not-found item truly missing.
		// Torrent magnets can transiently disappear while metadata is fetched/parsing completes.
		let gracePeriodMs = MISSING_GRACE_PERIOD_MS;
		const isTorrent = queueItem.protocol === 'torrent';
		if (isTorrent) {
			gracePeriodMs = TORRENT_MISSING_GRACE_PERIOD_MS;
			const awaitingMetadata =
				!!queueItem.magnetUrl && !queueItem.startedAt && !queueItem.completedAt;
			if (awaitingMetadata) {
				gracePeriodMs = TORRENT_MAGNET_METADATA_GRACE_PERIOD_MS;
			}
		}

		const addedAt = queueItem.addedAt ? new Date(queueItem.addedAt).getTime() : 0;
		const timeSinceAdd = Date.now() - addedAt;
		const transientStatuses = new Set<QueueStatus>(['queued', 'downloading', 'stalled', 'paused']);
		const currentStatus = queueItem.status as QueueStatus;

		if (timeSinceAdd < gracePeriodMs && transientStatuses.has(currentStatus)) {
			logger.debug(
				{
					title: queueItem.title,
					status: currentStatus,
					protocol: queueItem.protocol,
					hasMagnet: !!queueItem.magnetUrl,
					timeSinceAdd,
					gracePeriod: gracePeriodMs
				},
				'Download not found but within grace period, skipping'
			);
			return;
		}

		// If it was completed/seeding and is now gone, it may be:
		// 1. Transitioning from SABnzbd queue to history (need grace period)
		// 2. Actually removed from client
		if (queueItem.status === 'completed' || queueItem.status === 'seeding') {
			// Give a grace period for completed items (SABnzbd queue->history transition time)
			const completedAt = queueItem.completedAt
				? new Date(queueItem.completedAt).getTime()
				: queueItem.addedAt
					? new Date(queueItem.addedAt).getTime()
					: Date.now();
			const timeSinceComplete = Date.now() - completedAt;

			if (timeSinceComplete < COMPLETED_GRACE_PERIOD_MS) {
				logger.debug(
					{
						title: queueItem.title,
						timeSinceComplete,
						gracePeriod: COMPLETED_GRACE_PERIOD_MS
					},
					'Completed download recently, waiting for client sync'
				);
				return;
			}

			logger.info(
				{
					title: queueItem.title,
					clientName: client.name
				},
				'Download removed from client after completion'
			);

			// Mark as removed - the import service should have already imported it.
			// If the import never ran, cancel the acquisition so the slot frees.
			await db
				.update(downloadQueue)
				.set({ status: 'removed' })
				.where(eq(downloadQueue.id, queueItem.id));
			acquisitionService.cancelByQueueId(queueItem.id, 'download removed from client');

			const item = rowToQueueItem({ ...queueItem, status: 'removed' });
			this.emit('queue:removed', item.id);
			this.emitSSE('queue:removed', { id: item.id });
			return;
		}

		// Usenet clients can briefly drop queue visibility around completion/moves.
		// If the output path already exists, treat it as ready-for-import instead of failed.
		if (queueItem.protocol === 'usenet' && queueItem.outputPath) {
			try {
				await stat(queueItem.outputPath);

				logger.info(
					{
						title: queueItem.title,
						clientName: client.name,
						outputPath: queueItem.outputPath
					},
					'Usenet download missing from client but output path exists, queueing import'
				);

				const now = new Date().toISOString();
				await db
					.update(downloadQueue)
					.set({
						status: 'completed',
						completedAt: queueItem.completedAt ?? now,
						errorMessage: null
					})
					.where(eq(downloadQueue.id, queueItem.id));

				const updatedItem = await this.getQueueItem(queueItem.id);
				if (updatedItem) {
					this.emit('queue:completed', updatedItem);
					this.emitSSE('queue:completed', updatedItem);

					const importService = await getImportService();
					importService.requestImport(updatedItem.id).catch((err) => {
						logger.error(
							{
								queueId: updatedItem.id,
								title: updatedItem.title,
								error: err instanceof Error ? err.message : String(err)
							},
							'Failed to request import for missing usenet download'
						);
					});
				}

				return;
			} catch (error) {
				// Path doesn't exist yet, continue with regular missing-download handling.
				logger.debug(
					{
						title: queueItem.title,
						outputPath: queueItem.outputPath,
						error: error instanceof Error ? error.message : String(error)
					},
					'Missing usenet output path is not ready yet'
				);
			}
		}

		// Failed items are retained for user visibility and action.
		if (queueItem.status === 'failed') {
			return;
		}

		// Protocol-agnostic recovery: the download vanished from the client.
		// Tier 1: validate the stored outputPath before trusting it. Existing
		// on disk is not completion - the path may be a client/category root
		// or another download's still-active directory (#532).
		if (
			queueItem.outputPath &&
			(await isSafeRecoveryCandidate(queueItem.outputPath, queueItem, client, allDownloads))
		) {
			logger.info(
				{
					title: queueItem.title,
					clientName: client.name,
					outputPath: queueItem.outputPath
				},
				'Download missing from client but output path exists, queueing import'
			);

			await this.completeRecoveredDownload(queueItem.id, {
				completedAtFallback: queueItem.completedAt ?? new Date().toISOString()
			});
			return;
		}

		// Tier 2: compute recovery path from client config and validate it
		const category = queueItem.seriesId ? client.tvCategory : client.movieCategory;
		if (client.downloadPathLocal) {
			const recoveryPath = buildTorrentRecoveryPath(
				queueItem.outputPath || '',
				client.downloadPathLocal,
				category
			);
			if (
				recoveryPath &&
				(await isSafeRecoveryCandidate(recoveryPath, queueItem, client, allDownloads))
			) {
				logger.info(
					{
						title: queueItem.title,
						clientName: client.name,
						recoveryPath,
						originalOutputPath: queueItem.outputPath
					},
					'Download recovered via client path reconstruction'
				);

				await this.completeRecoveredDownload(queueItem.id, {
					outputPath: recoveryPath,
					completedAtFallback: queueItem.completedAt ?? new Date().toISOString()
				});
				return;
			}
		}

		// Both tiers failed — set to awaiting for auto-retry in poll loop
		logger.warn(
			{
				title: queueItem.title,
				clientName: client.name,
				previousStatus: queueItem.status,
				downloadId: queueItem.downloadId,
				infoHash: queueItem.infoHash,
				magnetUrl: queueItem.magnetUrl?.substring(0, 60),
				availableHashes: allDownloads.slice(0, 5).map((d) => d.hash)
			},
			'Download disappeared from client unexpectedly, entering recovery mode'
		);

		await db
			.update(downloadQueue)
			.set({
				status: 'awaiting',
				importAttempts: 1,
				lastAttemptAt: new Date().toISOString()
			})
			.where(eq(downloadQueue.id, queueItem.id));
	}

	/**
	 * Get a queue item by ID
	 */
	async getQueueItem(id: string): Promise<QueueItem | null> {
		const [row] = await db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).limit(1);
		return row ? rowToQueueItem(row) : null;
	}

	/**
	 * Get all queue items (non-terminal)
	 */
	async getQueue(): Promise<QueueItem[]> {
		const rows = await db
			.select()
			.from(downloadQueue)
			.where(not(inArray(downloadQueue.status, TERMINAL_STATUSES)));

		return rows.map(rowToQueueItem);
	}

	/**
	 * Get queue statistics
	 */
	async getStats(): Promise<QueueStats> {
		const rows = await db
			.select()
			.from(downloadQueue)
			.where(not(inArray(downloadQueue.status, TERMINAL_STATUSES)));

		const stats: QueueStats = {
			totalCount: rows.length,
			queuedCount: 0,
			downloadingCount: 0,
			stalledCount: 0,
			awaitingCount: 0,
			seedingCount: 0,
			pausedCount: 0,
			completedCount: 0,
			postprocessingCount: 0,
			importingCount: 0,
			failedCount: 0,
			totalSizeBytes: 0,
			totalDownloadSpeed: 0,
			totalUploadSpeed: 0
		};

		for (const row of rows) {
			stats.totalSizeBytes += row.size || 0;
			stats.totalDownloadSpeed += row.downloadSpeed || 0;
			stats.totalUploadSpeed += row.uploadSpeed || 0;

			switch (row.status) {
				case 'queued':
					stats.queuedCount++;
					break;
				case 'downloading':
					stats.downloadingCount++;
					break;
				case 'stalled':
					stats.stalledCount++;
					break;
				case 'awaiting':
					stats.awaitingCount++;
					break;
				case 'seeding':
				case 'seeding-imported':
					stats.seedingCount++;
					break;
				case 'paused':
					stats.pausedCount++;
					break;
				case 'completed':
					stats.completedCount++;
					break;
				case 'postprocessing':
					stats.postprocessingCount++;
					break;
				case 'importing':
					stats.importingCount++;
					break;
				case 'failed':
					stats.failedCount++;
					break;
			}
		}

		return stats;
	}

	/**
	 * Add a new item to the queue (called by grab endpoint)
	 */
	async addToQueue(params: {
		downloadClientId: string;
		downloadId: string;
		infoHash?: string;
		title: string;
		indexerId?: string;
		indexerName?: string;
		downloadUrl?: string;
		magnetUrl?: string;
		protocol?: string;
		movieId?: string;
		seriesId?: string;
		episodeIds?: string[];
		seasonNumber?: number;
		quality?: QueueItem['quality'];
		size?: number;
		releaseGroup?: string;
		isAutomatic?: boolean;
		isUpgrade?: boolean;
	}): Promise<QueueItem> {
		const infoHash = resolveInfoHash(params.infoHash, params.magnetUrl, params.downloadUrl);

		// Automatic grabs are suppressed for a short window when the same remote item
		// was recently removed locally while the client was unavailable.
		if (params.isAutomatic) {
			const suppressed = await isQueueItemSuppressed({
				downloadClientId: params.downloadClientId,
				protocol: params.protocol,
				downloadId: params.downloadId,
				infoHash
			});
			if (suppressed) {
				throw new Error('Download temporarily suppressed after local removal');
			}
		}

		const result = db.transaction((tx) => {
			const duplicateConditions = [
				and(
					eq(downloadQueue.downloadClientId, params.downloadClientId),
					eq(downloadQueue.downloadId, params.downloadId),
					notInArray(downloadQueue.status, ['removed', 'failed', ...POST_IMPORT_STATUSES])
				)
			];
			if (infoHash) {
				// 'failed' is excluded here too: resurrecting a failed row
				// silently returned the previous target and upgrade flags to
				// the new grab (stale-row reuse bug).
				duplicateConditions.push(
					and(
						eq(downloadQueue.infoHash, infoHash),
						notInArray(downloadQueue.status, ['removed', 'failed', ...POST_IMPORT_STATUSES])
					)
				);
			}

			const existing = tx
				.select()
				.from(downloadQueue)
				.where(or(...duplicateConditions))
				.limit(1)
				.all();

			if (existing.length > 0) {
				logger.info(
					{
						downloadId: params.downloadId,
						existingId: existing[0].id,
						status: existing[0].status
					},
					'Download already in queue, returning existing item'
				);
				return { created: false, item: rowToQueueItem(existing[0]) };
			}

			const id = randomUUID();
			const now = new Date().toISOString();
			const releaseGroup =
				params.releaseGroup ?? releaseParser.parse(params.title).releaseGroup ?? undefined;

			tx.insert(downloadQueue)
				.values({
					id,
					downloadClientId: params.downloadClientId,
					downloadId: params.downloadId,
					infoHash,
					title: params.title,
					indexerId: params.indexerId,
					indexerName: params.indexerName,
					downloadUrl: params.downloadUrl,
					magnetUrl: params.magnetUrl,
					protocol: params.protocol || 'torrent',
					movieId: params.movieId,
					seriesId: params.seriesId,
					episodeIds: params.episodeIds,
					seasonNumber: params.seasonNumber,
					status: 'queued',
					quality: params.quality,
					size: params.size,
					releaseGroup,
					addedAt: now,
					isAutomatic: params.isAutomatic || false,
					isUpgrade: params.isUpgrade || false
				})
				.run();

			const item = tx
				.select()
				.from(downloadQueue)
				.where(eq(downloadQueue.id, id))
				.limit(1)
				.all()[0];
			if (!item) throw new Error('Failed to create queue item');
			return { created: true, item: rowToQueueItem(item) };
		});

		if (!result.created) return result.item;
		const item = result.item;

		this.emit('queue:added', item);
		this.emitSSE('queue:added', item);

		// Force poll to pick up the new download
		setTimeout(() => this.forcePoll(), 1000);

		return item;
	}

	/**
	 * Complete a previously persisted debrid submission intent.
	 *
	 * Submission owns queue identity; the dedicated debrid poller owns provider
	 * polling and materialization.
	 */
	async completeDebridSubmission(id: string, providerItemId: string): Promise<QueueItem | null> {
		await db
			.update(downloadQueue)
			.set({
				downloadId: providerItemId,
				status: 'queued',
				progress: '0',
				downloadSpeed: 0,
				uploadSpeed: 0,
				eta: null,
				errorMessage: null,
				startedAt: null,
				completedAt: null,
				lastAttemptAt: new Date().toISOString()
			})
			.where(and(eq(downloadQueue.id, id), eq(downloadQueue.protocol, 'debrid')));

		const item = await this.getQueueItem(id);
		if (item) {
			this.emit('queue:updated', item);
			this.emitSSE('queue:updated', item);
		}
		return item;
	}

	/** Re-arm an existing failed debrid row as the durable intent for retry. */
	async prepareDebridSubmissionIntent(id: string, infoHash: string): Promise<QueueItem | null> {
		await db
			.update(downloadQueue)
			.set({
				downloadId: `debrid-intent:${infoHash.toLowerCase()}`,
				status: 'queued',
				progress: '0',
				errorMessage: null,
				lastAttemptAt: new Date().toISOString()
			})
			.where(and(eq(downloadQueue.id, id), eq(downloadQueue.protocol, 'debrid')));

		const item = await this.getQueueItem(id);
		if (item) {
			this.emit('queue:updated', item);
			this.emitSSE('queue:updated', item);
		}
		return item;
	}

	/**
	 * Remove an item from the queue and optionally from the client
	 */
	async removeFromQueue(
		id: string,
		options: {
			removeFromClient?: boolean;
			deleteFiles?: boolean;
		} = {}
	): Promise<void> {
		const [queueItem] = await db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, id))
			.limit(1);

		if (!queueItem) {
			throw new Error('Queue item not found');
		}

		// Remove from download client if requested (best-effort — always cleans up queue)
		if (options.removeFromClient) {
			const manager = getDownloadClientManager();
			const instance = await manager.getClientInstance(queueItem.downloadClientId);

			if (instance) {
				try {
					const clientDownloadId = this.resolveClientDownloadId(queueItem, 'remove');
					await instance.removeDownload(clientDownloadId, options.deleteFiles);
				} catch (error) {
					logger.warn(
						{
							title: queueItem.title,
							error: error instanceof Error ? error.message : String(error)
						},
						'Failed to remove download from client, proceeding with queue cleanup'
					);
				}
			} else {
				logger.warn(
					{
						title: queueItem.title,
						downloadClientId: queueItem.downloadClientId
					},
					'Download client not available, removing from queue only'
				);
			}
		}

		// Update status to removed
		await db.update(downloadQueue).set({ status: 'removed' }).where(eq(downloadQueue.id, id));

		// User-initiated removal: release the acquisition's slot reservations.
		acquisitionService.cancelByQueueId(id, 'removed from queue');

		this.emit('queue:removed', id);
		this.emitSSE('queue:removed', { id });
	}

	/**
	 * Pause a download
	 */
	async pauseDownload(id: string): Promise<void> {
		const [queueItem] = await db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, id))
			.limit(1);

		if (!queueItem) {
			throw new Error('Queue item not found');
		}

		const manager = getDownloadClientManager();
		const instance = await manager.getClientInstance(queueItem.downloadClientId);

		if (!instance) {
			throw new Error('Download client not available');
		}

		const clientDownloadId = this.resolveClientDownloadId(queueItem, 'pause');
		await instance.pauseDownload(clientDownloadId);

		// Update local status
		await db.update(downloadQueue).set({ status: 'paused' }).where(eq(downloadQueue.id, id));

		const updatedItem = await this.getQueueItem(id);
		if (updatedItem) {
			this.emit('queue:updated', updatedItem);
			this.emitSSE('queue:updated', updatedItem);
		}
	}

	/**
	 * Resume a download
	 */
	async resumeDownload(id: string): Promise<void> {
		const [queueItem] = await db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, id))
			.limit(1);

		if (!queueItem) {
			throw new Error('Queue item not found');
		}

		const manager = getDownloadClientManager();
		const instance = await manager.getClientInstance(queueItem.downloadClientId);

		if (!instance) {
			throw new Error('Download client not available');
		}

		const clientDownloadId = this.resolveClientDownloadId(queueItem, 'resume');
		await instance.resumeDownload(clientDownloadId);

		// Update local status
		await db.update(downloadQueue).set({ status: 'downloading' }).where(eq(downloadQueue.id, id));

		const updatedItem = await this.getQueueItem(id);
		if (updatedItem) {
			this.emit('queue:updated', updatedItem);
			this.emitSSE('queue:updated', updatedItem);
		}
	}

	/**
	 * Resolve the identifier that should be sent to a download client command.
	 * Torrents prefer infoHash; usenet clients prefer downloadId.
	 */
	private resolveClientDownloadId(
		queueItem: typeof downloadQueue.$inferSelect,
		action: 'pause' | 'resume' | 'remove'
	): string {
		const isTorrent = queueItem.protocol === 'torrent';
		const identifier = isTorrent
			? queueItem.infoHash || queueItem.downloadId
			: queueItem.downloadId || queueItem.infoHash;

		if (!identifier) {
			throw new Error(`Queue item is missing a download identifier for ${action}`);
		}

		return identifier;
	}

	/**
	 * Mark a queue item as importing (for ImportService to call)
	 * Uses atomic check to prevent race conditions - only succeeds if item
	 * is not already importing/imported.
	 *
	 * @returns 'success' if marked as importing, 'already_importing' if another
	 *          process got there first, 'max_attempts' if limit exceeded
	 */
	async markImporting(
		id: string
	): Promise<'success' | 'already_importing' | 'already_imported' | 'max_attempts' | 'not_found'> {
		const now = new Date().toISOString();

		// Get current state
		const current = await db
			.select({
				status: downloadQueue.status,
				importAttempts: downloadQueue.importAttempts,
				title: downloadQueue.title
			})
			.from(downloadQueue)
			.where(eq(downloadQueue.id, id))
			.get();

		if (!current) {
			return 'not_found';
		}

		// Already in terminal state
		if (current.status === 'importing') {
			return 'already_importing';
		}
		if (isImportedQueueStatus(current.status)) {
			return 'already_imported';
		}

		const newAttempts = (current.importAttempts ?? 0) + 1;

		// Enforce MAX_IMPORT_ATTEMPTS limit
		if (newAttempts > MAX_IMPORT_ATTEMPTS) {
			logger.error(
				{
					queueItemId: id,
					title: current.title,
					attempts: newAttempts,
					maxAttempts: MAX_IMPORT_ATTEMPTS
				},
				'Max import attempts exceeded, marking as failed'
			);
			await this.markFailed(id, `Import failed after ${newAttempts} attempts`, {
				terminalImport: true
			});
			return 'max_attempts';
		}

		// Atomic update: only update if status is NOT already 'importing' or 'imported'
		// This prevents race conditions where two callers both pass the check above
		const result = await db
			.update(downloadQueue)
			.set({
				status: 'importing',
				importAttempts: newAttempts,
				lastAttemptAt: now
			})
			.where(
				and(
					eq(downloadQueue.id, id),
					not(eq(downloadQueue.status, 'importing')),
					notInArray(downloadQueue.status, [...POST_IMPORT_STATUSES])
				)
			);

		// Check if the update actually changed anything
		// SQLite returns changes count in result
		if (result.changes === 0) {
			// Another process already marked it as importing
			logger.debug({ id }, 'markImporting: race condition detected, another process won');
			return 'already_importing';
		}

		const updatedItem = await this.getQueueItem(id);
		if (updatedItem) {
			this.emit('queue:updated', updatedItem);
			this.emitSSE('queue:updated', updatedItem);
		}
		return 'success';
	}

	/**
	 * Mark a queue item as imported.
	 *
	 * For torrents: Sets status to 'seeding-imported' to indicate file is imported
	 * but torrent is still seeding. removeCompletedDownloads() will set to 'imported'
	 * and delete when seeding requirements are met.
	 *
	 * For usenet and debrid: Sets status to 'imported' directly (no seeding needed).
	 */
	async markImported(
		id: string,
		importedPath: string,
		protocol?: 'torrent' | 'usenet' | 'debrid'
	): Promise<void> {
		const now = new Date().toISOString();

		// The acquisition completed: release its slot reservations.
		acquisitionService.completeByQueueId(id);

		// For torrents, use 'seeding-imported' to show it's imported but still seeding
		// For usenet and debrid, use 'imported' directly (no seeding)
		const status = protocol === 'torrent' ? 'seeding-imported' : 'imported';

		await db
			.update(downloadQueue)
			.set({
				status,
				importedPath,
				importedAt: now
			})
			.where(eq(downloadQueue.id, id));

		const updatedItem = await this.getQueueItem(id);
		if (updatedItem) {
			this.emit('queue:imported', updatedItem);
			this.emitSSE('queue:imported', updatedItem);
		}

		logger.info(
			{
				id,
				importedPath,
				status,
				protocol
			},
			'Marked queue item as imported'
		);
	}

	/**
	 * Mark a queue item as failed
	 */
	/**
	 * Default stalled download timeout in minutes for downloads at or below the
	 * progress threshold (they never got off the ground). 3 days: stalling is
	 * normal — torrents routinely resume when a seeder returns — so do not
	 * assume a stalled download is dead within an hour.
	 */
	private static readonly DEFAULT_STALLED_TIMEOUT_MINUTES = 3 * 24 * 60;

	/**
	 * Minimum stalled download timeout in minutes
	 */
	private static readonly MIN_STALLED_TIMEOUT_MINUTES = 5;

	/**
	 * Default stalled download timeout in minutes for downloads with meaningful
	 * progress (above the progress threshold). These used to be reaped never,
	 * which let dead torrents linger in the client for months; 14 days of zero
	 * progress is enough to conclude the release is unreachable.
	 */
	private static readonly DEFAULT_STALLED_PROGRESS_TIMEOUT_MINUTES = 14 * 24 * 60;

	/**
	 * Default progress threshold (%): remove stalled downloads at or below this percentage.
	 * 1% catches downloads that fetched a tiny amount but then stalled permanently.
	 */
	private static readonly DEFAULT_STALLED_PROGRESS_THRESHOLD = 1; // 1%

	/**
	 * Default blocklist duration (hours) applied to an auto-removed stalled release.
	 * 0 means a permanent ban (no expiry).
	 */
	private static readonly DEFAULT_STALLED_BLOCKLIST_HOURS = 72; // 3 days

	/**
	 * Read the stalled download timeout from monitoring settings
	 */
	private async getStalledTimeoutMinutes(): Promise<number> {
		try {
			const [row] = await db
				.select({ value: monitoringSettings.value })
				.from(monitoringSettings)
				.where(eq(monitoringSettings.key, 'stalled_download_timeout_minutes'))
				.limit(1);

			if (row) {
				const value = parseFloat(row.value);
				if (Number.isFinite(value) && value >= 0) {
					return value;
				}
			}
		} catch (error) {
			logger.warn(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to read stalled download timeout from settings'
			);
		}

		return DownloadMonitorService.DEFAULT_STALLED_TIMEOUT_MINUTES;
	}

	/**
	 * Read the stalled download progress threshold from monitoring settings.
	 * Torrents stalled below this percentage will be eligible for removal.
	 * Defaults to 0 (only kills torrents at 0%).
	 */
	private async getStalledProgressThreshold(): Promise<number> {
		try {
			const [row] = await db
				.select({ value: monitoringSettings.value })
				.from(monitoringSettings)
				.where(eq(monitoringSettings.key, 'stalled_download_progress_threshold'))
				.limit(1);

			if (row) {
				const value = parseFloat(row.value);
				if (Number.isFinite(value) && value >= 0 && value <= 100) {
					return value;
				}
			}
		} catch (error) {
			logger.warn(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to read stalled progress threshold from settings'
			);
		}

		return DownloadMonitorService.DEFAULT_STALLED_PROGRESS_THRESHOLD;
	}

	/**
	 * Read the blocklist duration (in hours) applied to auto-removed stalled releases.
	 * A value of 0 means the release is banned permanently (no expiry).
	 */
	private async getStalledBlocklistHours(): Promise<number> {
		try {
			const [row] = await db
				.select({ value: monitoringSettings.value })
				.from(monitoringSettings)
				.where(eq(monitoringSettings.key, 'stalled_download_blocklist_hours'))
				.limit(1);

			if (row) {
				const value = parseFloat(row.value);
				if (Number.isFinite(value) && value >= 0) {
					return value;
				}
			}
		} catch (error) {
			logger.warn(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to read stalled blocklist duration from settings'
			);
		}

		return DownloadMonitorService.DEFAULT_STALLED_BLOCKLIST_HOURS;
	}

	/**
	 * Stalled timeout (minutes) for downloads with meaningful progress (above
	 * the progress threshold). Separate from the low-progress timeout: torrents
	 * that already downloaded data get a much longer window before cleanup.
	 */
	private async getStalledProgressTimeoutMinutes(): Promise<number> {
		try {
			const [row] = await db
				.select({ value: monitoringSettings.value })
				.from(monitoringSettings)
				.where(eq(monitoringSettings.key, 'stalled_download_progress_timeout_minutes'))
				.limit(1);

			if (row) {
				const value = parseFloat(row.value);
				if (Number.isFinite(value) && value >= 0) {
					return value;
				}
			}
		} catch (error) {
			logger.warn(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to read stalled progress timeout from settings'
			);
		}

		return DownloadMonitorService.DEFAULT_STALLED_PROGRESS_TIMEOUT_MINUTES;
	}

	/**
	 * Handle stalled downloads that have timed out.
	 *
	 * Two tiers (stalling is normal — torrents routinely resume when a seeder
	 * returns, so patience is the default):
	 * - At/below the progress threshold (never got off the ground, e.g. magnet
	 *   metadata never fetched, no seeders ever connected): removed after the
	 *   short stalled timeout.
	 * - Above the threshold (real progress, then went quiet): left alone until
	 *   the much longer progress timeout — a seeder may still appear. Only
	 *   genuinely long-dead partial downloads get reaped.
	 *
	 * For each timed-out stalled item:
	 * 1. Remove from the download client
	 * 2. Mark as failed in the queue (creates history record and emits events)
	 * 3. Reset the search cooldown on the media item so it gets re-searched
	 *
	 * A timeout of 0 disables that tier's handling entirely.
	 */
	private async handleStalledDownloads(): Promise<void> {
		const timeoutMinutes = await this.getStalledTimeoutMinutes();
		const progressTimeoutMinutes = await this.getStalledProgressTimeoutMinutes();

		// A timeout of 0 in BOTH tiers means the feature is disabled
		if (timeoutMinutes === 0 && progressTimeoutMinutes === 0) return;

		const progressThreshold = await this.getStalledProgressThreshold();
		const blocklistHours = await this.getStalledBlocklistHours();

		const effectiveTimeout = Math.max(
			timeoutMinutes,
			DownloadMonitorService.MIN_STALLED_TIMEOUT_MINUTES
		);
		const timeoutMs = effectiveTimeout * 60 * 1000;
		const progressTimeoutMs =
			Math.max(progressTimeoutMinutes, DownloadMonitorService.MIN_STALLED_TIMEOUT_MINUTES) *
			60 *
			1000;
		const now = Date.now();

		// Defensive backfill: any row that is stalled but has no recorded stall start
		// (e.g. it became stalled while the poll loop was mid-cycle) gets stamped now so
		// it begins aging. The poll loop normally sets this on the stalled transition.
		await db
			.update(downloadQueue)
			.set({ stalledSince: new Date(now).toISOString() })
			.where(
				and(
					eq(downloadQueue.status, 'stalled'),
					isNull(downloadQueue.stalledSince),
					not(eq(downloadQueue.protocol, 'debrid'))
				)
			);

		// Select every stalled row once, then tier-filter below. The two tiers have
		// different timeouts, so a single SQL cutoff cannot express both.
		const stalledItems = await db
			.select()
			.from(downloadQueue)
			.where(
				and(
					eq(downloadQueue.status, 'stalled'),
					isNotNull(downloadQueue.stalledSince),
					not(eq(downloadQueue.protocol, 'debrid'))
				)
			);

		if (stalledItems.length === 0) return;

		// Tier assignment:
		// - low progress (<= threshold): short timeout (still respects 0 = tier disabled)
		// - meaningful progress (> threshold): long progress timeout (0 = tier disabled)
		// Uses <= so that threshold=0 correctly catches downloads at exactly 0%.
		const shortCutoff = new Date(now - timeoutMs).toISOString();
		const progressCutoff = new Date(now - progressTimeoutMs).toISOString();
		const timedOutItems = stalledItems.filter((item) => {
			const progressPct = parseFloat(item.progress || '0') * 100;
			if (progressPct <= progressThreshold) {
				return timeoutMinutes !== 0 && item.stalledSince! <= shortCutoff;
			}
			return progressTimeoutMinutes !== 0 && item.stalledSince! <= progressCutoff;
		});

		if (timedOutItems.length === 0) return;

		logger.info(
			{
				count: timedOutItems.length,
				timeoutMinutes: effectiveTimeout,
				progressThreshold,
				blocklistHours: blocklistHours === 0 ? 'permanent' : blocklistHours
			},
			'Processing timed-out stalled downloads'
		);

		const manager = getDownloadClientManager();

		for (const item of timedOutItems) {
			const progressPct = parseFloat(item.progress || '0') * 100;
			const errorMessage =
				item.protocol === 'usenet'
					? 'Download stalled - articles unavailable or expired'
					: progressPct <= progressThreshold
						? 'Download stalled - no seeds or peers available'
						: `Download stalled at ${progressPct.toFixed(1)}% - no progress for an extended period`;

			// Removal must succeed before we forget about the download — otherwise the
			// dead torrent lingers in the client while Cinephage considers it handled.
			// If the client is unreachable we skip this item and let the next poll cycle
			// retry: its stall timer keeps running, so it stays eligible. (The delete API
			// is idempotent for already-gone torrents, so a thrown error means a genuine
			// connection/auth failure, not "already removed".) A null instance means the
			// client is no longer configured, so there is nothing to remove and we fall
			// through to clean up the orphaned queue item.
			let instance: IDownloadClient | undefined;
			try {
				instance = await manager.getClientInstance(item.downloadClientId);
			} catch (error) {
				logger.warn(
					{
						title: item.title,
						error: error instanceof Error ? error.message : String(error)
					},
					'Error accessing download client for stalled download removal; will retry next cycle'
				);
				continue;
			}

			if (instance) {
				try {
					const clientDownloadId = this.resolveClientDownloadId(item, 'remove');
					await instance.removeDownload(clientDownloadId, true);
				} catch (clientError) {
					logger.warn(
						{
							title: item.title,
							error: clientError instanceof Error ? clientError.message : String(clientError)
						},
						'Failed to remove stalled download from client; will retry next cycle'
					);
					continue;
				}
			}

			// Mark as failed (creates history record, emits queue:failed event)
			await this.markFailed(item.id, errorMessage);

			// Auto-blocklist the stalled release to prevent re-grabbing the same dead torrent.
			// A configured duration of 0 means a permanent ban (no expiry).
			try {
				const { blocklistService } =
					await import('#lib/server/monitoring/specifications/BlocklistSpecification.js');
				await blocklistService.addToBlocklist(
					{
						title: item.title,
						infoHash: item.infoHash ?? undefined,
						indexerId: item.indexerId ?? undefined,
						quality: item.quality ?? undefined,
						size: item.size ?? undefined,
						protocol: item.protocol
					},
					{
						movieId: item.movieId ?? undefined,
						seriesId: item.seriesId ?? undefined,
						episodeIds: item.episodeIds ?? undefined,
						reason: 'download_failed',
						message: errorMessage,
						expiresInHours: blocklistHours > 0 ? blocklistHours : undefined
					}
				);
			} catch (blocklistError) {
				logger.warn(
					{
						title: item.title,
						error: blocklistError instanceof Error ? blocklistError.message : String(blocklistError)
					},
					'Failed to add stalled release to blocklist'
				);
			}

			// Reset search cooldown so the monitoring cycle re-searches immediately
			try {
				if (item.movieId) {
					await db
						.update(movies)
						.set({ lastSearchTime: new Date(0).toISOString() })
						.where(eq(movies.id, item.movieId));
				}
				if (item.seriesId && item.episodeIds?.length) {
					await db
						.update(episodes)
						.set({ lastSearchTime: new Date(0).toISOString() })
						.where(inArray(episodes.id, item.episodeIds));
				}
			} catch (error) {
				logger.warn(
					{
						movieId: item.movieId,
						seriesId: item.seriesId,
						title: item.title,
						error: error instanceof Error ? error.message : String(error)
					},
					'Failed to reset search cooldown for stalled download'
				);
			}
		}
	}

	private async getBlockedExtensionCheckIntervalSeconds(): Promise<number> {
		try {
			const [row] = await db
				.select({ value: monitoringSettings.value })
				.from(monitoringSettings)
				.where(eq(monitoringSettings.key, 'blocked_extension_check_interval_seconds'))
				.limit(1);

			if (row) {
				const value = parseFloat(row.value);
				if (Number.isFinite(value) && value >= 0) {
					return value;
				}
			}
		} catch (error) {
			logger.warn(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to read blocked extension check interval from settings'
			);
		}

		return DownloadMonitorService.DEFAULT_BLOCKED_EXTENSION_CHECK_INTERVAL_SECONDS;
	}

	scheduleBlockedExtensionCheck(immediate = false): void {
		if (!this.isRunning) return;

		if (this.blockedExtensionTimer) {
			clearTimeout(this.blockedExtensionTimer);
			this.blockedExtensionTimer = null;
		}

		const run = async () => {
			if (!this.isRunning) return;
			try {
				const interval = await this.getBlockedExtensionCheckIntervalSeconds();
				if (interval === 0) return;

				await this.handleBlockedExtensionDownloads();

				if (this.isRunning) {
					this.blockedExtensionTimer = setTimeout(() => run(), interval * 1000);
				}
			} catch (error) {
				logger.warn(
					{ error: error instanceof Error ? error.message : String(error) },
					'Blocked extension check failed'
				);
				if (this.isRunning) {
					this.blockedExtensionTimer = setTimeout(
						() => run(),
						DownloadMonitorService.DEFAULT_BLOCKED_EXTENSION_CHECK_INTERVAL_SECONDS * 1000
					);
				}
			}
		};

		if (immediate) {
			run();
		} else {
			this.getBlockedExtensionCheckIntervalSeconds().then((interval) => {
				if (interval === 0 || !this.isRunning) return;
				this.blockedExtensionTimer = setTimeout(() => run(), interval * 1000);
			});
		}
	}

	private async handleBlockedExtensionDownloads(): Promise<void> {
		const activeItems = await db
			.select()
			.from(downloadQueue)
			.where(
				and(
					not(inArray(downloadQueue.status, TERMINAL_STATUSES)),
					not(inArray(downloadQueue.status, POST_IMPORT_STATUSES)),
					not(eq(downloadQueue.status, 'failed')),
					eq(downloadQueue.protocol, 'torrent')
				)
			);

		if (activeItems.length === 0) return;

		const manager = getDownloadClientManager();

		for (const item of activeItems) {
			const cacheKey = item.infoHash || item.downloadId;
			if (this.blockedExtensionCheckedHashes.has(cacheKey)) continue;

			try {
				const { resolveBlockedExtensionsForQueueItem } =
					await import('#lib/server/settings/blocked-extensions.js');
				const { DANGEROUS_EXTENSIONS, EXECUTABLE_EXTENSIONS } =
					await import('#lib/config/constants.js');
				const userBlocked = await resolveBlockedExtensionsForQueueItem({
					movieId: item.movieId,
					seriesId: item.seriesId
				});
				const blockedExtensions = [
					...userBlocked,
					...DANGEROUS_EXTENSIONS,
					...EXECUTABLE_EXTENSIONS
				];

				if (blockedExtensions.length === 0) {
					this.blockedExtensionCheckedHashes.add(cacheKey);
					continue;
				}

				const instance = await manager.getClientInstance(item.downloadClientId);
				if (!instance?.getFiles) {
					this.blockedExtensionCheckedHashes.add(cacheKey);
					continue;
				}

				const clientDownloadId = item.infoHash || item.downloadId;
				if (!clientDownloadId) {
					this.blockedExtensionCheckedHashes.add(cacheKey);
					continue;
				}

				const files = await instance.getFiles(clientDownloadId);

				if (files.length === 0) {
					continue;
				}

				const matchedFiles = files.filter((f) => {
					const dotIndex = f.name.lastIndexOf('.');
					if (dotIndex === -1) return false;
					const ext = f.name.slice(dotIndex).toLowerCase();
					return blockedExtensions.includes(ext);
				});

				if (matchedFiles.length === 0) {
					this.blockedExtensionCheckedHashes.add(cacheKey);
					continue;
				}

				const fileList = matchedFiles.map((f) => f.name.split('/').pop() || f.name).join(', ');
				const errorMessage = `Blocked extension detected: ${fileList}`;

				// Preferred path: the dangerous file never reaches disk if we simply
				// exclude it via client-side file priority, so strip the junk files and
				// let the media download continue. Only fall back to removing the whole
				// torrent (and blocklisting the release) when the client cannot exclude
				// files or every file in the torrent is dangerous.
				const dangerousIndices = matchedFiles.map((f) => f.index);
				const mediaFiles = files.filter((f) => !dangerousIndices.includes(f.index));

				if (typeof instance.excludeFiles === 'function' && mediaFiles.length > 0) {
					logger.info(
						{
							title: item.title,
							matchedFiles: matchedFiles.map((f) => f.name),
							mediaFileCount: mediaFiles.length
						},
						'Download contains files with blocked extensions, excluding files via priority'
					);

					try {
						await instance.excludeFiles(clientDownloadId, dangerousIndices);
						this.blockedExtensionCheckedHashes.add(cacheKey);
						continue;
					} catch (excludeError) {
						logger.warn(
							{
								title: item.title,
								error: excludeError instanceof Error ? excludeError.message : String(excludeError)
							},
							'Failed to exclude blocked extension files, falling back to torrent removal'
						);
					}
				}

				logger.info(
					{
						title: item.title,
						matchedFiles: matchedFiles.map((f) => f.name),
						blockedExtensions
					},
					'Download contains files with blocked extensions, removing and blocklisting'
				);

				try {
					await instance.removeDownload(clientDownloadId, true);
				} catch (removeError) {
					logger.warn(
						{
							title: item.title,
							error: removeError instanceof Error ? removeError.message : String(removeError)
						},
						'Failed to remove blocked extension download from client'
					);
				}

				await this.markFailed(item.id, errorMessage);

				try {
					const { blocklistService } =
						await import('#lib/server/monitoring/specifications/BlocklistSpecification.js');
					await blocklistService.addToBlocklist(
						{
							title: item.title,
							infoHash: item.infoHash ?? undefined,
							indexerId: item.indexerId ?? undefined,
							quality: item.quality ?? undefined,
							size: item.size ?? undefined,
							protocol: item.protocol
						},
						{
							movieId: item.movieId ?? undefined,
							seriesId: item.seriesId ?? undefined,
							episodeIds: item.episodeIds ?? undefined,
							reason: 'blocked_extension',
							message: errorMessage
						}
					);
				} catch (blocklistError) {
					logger.warn(
						{
							title: item.title,
							error:
								blocklistError instanceof Error ? blocklistError.message : String(blocklistError)
						},
						'Failed to add blocked extension release to blocklist'
					);
				}

				this.blockedExtensionCheckedHashes.add(cacheKey);
			} catch (error) {
				this.blockedExtensionCheckedHashes.add(cacheKey);
				logger.warn(
					{
						title: item.title,
						error: error instanceof Error ? error.message : String(error)
					},
					'Failed to check download files for blocked extensions'
				);
			}
		}
	}

	async checkBlockedExtensions(): Promise<void> {
		this.blockedExtensionCheckedHashes.clear();
		this.scheduleBlockedExtensionCheck(true);
	}

	async markFailed(
		id: string,
		errorMessage: string,
		options?: { terminalImport?: boolean }
	): Promise<void> {
		// The acquisition failed terminally: release its slot reservations.
		acquisitionService.failByQueueId(id, errorMessage);

		await db
			.update(downloadQueue)
			.set({
				status: 'failed',
				errorMessage,
				lastAttemptAt: new Date().toISOString(),
				...(options?.terminalImport ? { importFailed: true } : {})
			})
			.where(eq(downloadQueue.id, id));

		const updatedItem = await this.getQueueItem(id);
		if (updatedItem) {
			await this.createFailedHistoryRecord(updatedItem, errorMessage);
			this.emit('queue:failed', updatedItem);
			this.emitSSE('queue:failed', updatedItem);
		}
	}

	/**
	 * Persist failed queue items to download history so they remain visible in Activity
	 * even if the queue item is later auto-marked removed.
	 */
	private async createFailedHistoryRecord(
		queueItem: QueueItem,
		errorMessage: string
	): Promise<void> {
		try {
			// Prevent duplicate failed history records for the same queue attempt.
			const [existing] = await db
				.select({ id: downloadHistory.id })
				.from(downloadHistory)
				.where(
					and(
						eq(downloadHistory.status, 'failed'),
						eq(downloadHistory.title, queueItem.title),
						eq(downloadHistory.grabbedAt, queueItem.addedAt)
					)
				)
				.limit(1);

			if (existing) {
				return;
			}

			const [client] = await db
				.select({ name: downloadClients.name })
				.from(downloadClients)
				.where(eq(downloadClients.id, queueItem.downloadClientId))
				.limit(1);

			let downloadTimeSeconds: number | undefined;
			if (queueItem.startedAt && queueItem.completedAt) {
				const startTime = new Date(queueItem.startedAt).getTime();
				const endTime = new Date(queueItem.completedAt).getTime();
				downloadTimeSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));
			}

			await db.insert(downloadHistory).values({
				downloadClientId: queueItem.downloadClientId,
				downloadClientName: client?.name,
				downloadId: queueItem.downloadId,
				infoHash: queueItem.infoHash,
				title: queueItem.title,
				indexerId: queueItem.indexerId,
				indexerName: queueItem.indexerName,
				protocol: queueItem.protocol,
				movieId: queueItem.movieId,
				seriesId: queueItem.seriesId,
				episodeIds: queueItem.episodeIds ?? undefined,
				seasonNumber: queueItem.seasonNumber,
				status: 'failed',
				statusReason: errorMessage,
				size: queueItem.size ?? undefined,
				downloadTimeSeconds,
				finalRatio: String(queueItem.ratio ?? 0),
				quality: queueItem.quality,
				releaseGroup: queueItem.releaseGroup,
				grabbedAt: queueItem.addedAt,
				completedAt: queueItem.completedAt ?? undefined,
				importedAt: undefined
			});
		} catch (error) {
			logger.warn(
				{
					queueItemId: queueItem.id,
					title: queueItem.title,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to create failed download history record'
			);
		}
	}

	/**
	 * Re-link downloads that are active in the client but have no active queue entry,
	 * by matching against failed download history records (which carry the media
	 * association from the original grab).
	 *
	 * This recovers downloads where the queue entry was cleared (e.g. via "Clear
	 * Failed") while the torrent/usenet item was still running in the client.
	 */
	async relinkOrphanedDownloads(): Promise<{
		relinked: { title: string; hash: string; mediaType: string }[];
		skipped: { title: string; hash: string; reason: string }[];
	}> {
		const result = {
			relinked: [] as { title: string; hash: string; mediaType: string }[],
			skipped: [] as { title: string; hash: string; reason: string }[]
		};

		const manager = getDownloadClientManager();
		const enabledClients = await manager.getEnabledClients();

		if (enabledClients.length === 0) return result;

		// Build set of all hashes currently tracked in the active queue
		const activeQueueItems = await db
			.select({ downloadId: downloadQueue.downloadId, infoHash: downloadQueue.infoHash })
			.from(downloadQueue)
			.where(
				and(
					not(inArray(downloadQueue.status, TERMINAL_STATUSES)),
					not(eq(downloadQueue.protocol, 'debrid'))
				)
			);

		const trackedIds = new Set<string>();
		for (const item of activeQueueItems) {
			trackedIds.add(item.downloadId.toLowerCase());
			if (item.infoHash) trackedIds.add(item.infoHash.toLowerCase());
		}

		for (const { client, instance } of enabledClients) {
			let downloads: DownloadInfo[];
			try {
				downloads = await instance.getDownloads();
			} catch (error) {
				logger.warn(
					{
						clientName: client.name,
						error: error instanceof Error ? error.message : String(error)
					},
					'Failed to fetch downloads for orphan relink'
				);
				continue;
			}

			for (const download of downloads) {
				const hashLower = download.hash.toLowerCase();

				// Already tracked in active queue
				if (trackedIds.has(hashLower)) {
					result.skipped.push({
						title: download.name,
						hash: download.hash,
						reason: 'already_tracked'
					});
					continue;
				}

				// Only consider downloads in Cinephage-managed categories
				const isOurCategory =
					!client.tvCategory ||
					download.category === client.tvCategory ||
					download.category === client.movieCategory;

				if (!isOurCategory) continue;

				// Look up a failed history record for this exact download hash
				const [historyRecord] = await db
					.select()
					.from(downloadHistory)
					.where(
						and(eq(downloadHistory.downloadId, download.hash), eq(downloadHistory.status, 'failed'))
					)
					.orderBy(desc(downloadHistory.grabbedAt))
					.limit(1);

				if (!historyRecord) {
					result.skipped.push({
						title: download.name,
						hash: download.hash,
						reason: 'no_history_match'
					});
					continue;
				}

				// Re-create the queue entry from history data
				const now = new Date().toISOString();
				const id = randomUUID();

				// Same rule as updateQueueItem: a metadata-less torrent's
				// savePath is a root, not this download's content - store null
				// rather than a path recovery could mistake for its files.
				const clientDownloadPath = getDownloadContentPath(
					download,
					historyRecord.protocol || 'torrent'
				);
				const outputPath = clientDownloadPath
					? mapClientPathToLocal(
							clientDownloadPath,
							client.downloadPathLocal,
							client.downloadPathRemote ?? null,
							client.tempPathLocal,
							client.tempPathRemote
						)
					: null;

				await db.insert(downloadQueue).values({
					id,
					downloadClientId: client.id,
					downloadId: download.hash,
					infoHash: download.hash,
					title: historyRecord.title,
					indexerId: historyRecord.indexerId,
					indexerName: historyRecord.indexerName,
					protocol: historyRecord.protocol || 'torrent',
					movieId: historyRecord.movieId,
					seriesId: historyRecord.seriesId,
					episodeIds: historyRecord.episodeIds,
					seasonNumber: historyRecord.seasonNumber,
					quality: historyRecord.quality,
					size: download.size || historyRecord.size,
					releaseGroup: historyRecord.releaseGroup,
					status: 'queued',
					progress: download.progress.toString(),
					clientDownloadPath,
					outputPath,
					addedAt: historyRecord.grabbedAt || now,
					isAutomatic: false,
					isUpgrade: false
				});

				// Remove the failed history record — it will be recreated if the
				// download fails again, or a success record created on import.
				await db.delete(downloadHistory).where(eq(downloadHistory.id, historyRecord.id));

				const relinkedItem = await this.getQueueItem(id);
				if (relinkedItem) {
					this.emit('queue:added', relinkedItem);
					this.emitSSE('queue:added', relinkedItem);
				}

				const mediaType = historyRecord.movieId ? 'movie' : 'tv';
				result.relinked.push({ title: historyRecord.title, hash: download.hash, mediaType });

				logger.info(
					{ title: historyRecord.title, hash: download.hash, mediaType, queueId: id },
					'Re-linked orphaned download from history'
				);
			}
		}

		// Force immediate poll to pick up re-linked items and update their statuses
		if (result.relinked.length > 0) {
			setTimeout(() => this.forcePoll(), 500);
		}

		logger.info(
			{ relinked: result.relinked.length, skipped: result.skipped.length },
			'Orphan relink complete'
		);

		return result;
	}

	/**
	 * Shared prelude for the unmatched flows: fetch every enabled client's
	 * downloads once (bounded like startup sync so a dead client can't hang
	 * the caller) and index them by lower-cased hash. List, resolve, track
	 * and enroll all share it — one copy.
	 */
	private async fetchClientDownloadIndex(
		context: 'listing' | 'resolve' | 'track' | 'enroll',
		clientId?: string
	): Promise<ClientDownloadIndex> {
		const manager = getDownloadClientManager();
		const enabledClients = await manager.getEnabledClients();
		const clients = clientId
			? enabledClients.filter(({ client }) => client.id === clientId)
			: enabledClients;

		const byClient = new Map<
			string,
			{ client: DownloadClient; byHash: Map<string, DownloadInfo> }
		>();
		let fetchFailed = false;
		for (const { client, instance } of clients) {
			try {
				const downloads: DownloadInfo[] = await Promise.race([
					instance.getDownloads(),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error('Unmatched sync timeout')), STARTUP_SYNC_TIMEOUT_MS)
					)
				]);
				const byHash = new Map<string, DownloadInfo>();
				for (const download of downloads) {
					byHash.set(download.hash.toLowerCase(), download);
				}
				byClient.set(client.id, { client, byHash });
			} catch (error) {
				fetchFailed = true;
				logger.warn(
					{
						clientName: client.name,
						error: error instanceof Error ? error.message : String(error)
					},
					`Failed to fetch downloads for unmatched ${context}`
				);
			}
		}

		return { byClient, fetchFailed };
	}

	/**
	 * The relink tracked-set rule: anything with a non-terminal,
	 * non-debrid queue row is managed, not unmatched.
	 */
	private async fetchTrackedIds(): Promise<Set<string>> {
		const activeQueueItems = await db
			.select({ downloadId: downloadQueue.downloadId, infoHash: downloadQueue.infoHash })
			.from(downloadQueue)
			.where(
				and(
					not(inArray(downloadQueue.status, TERMINAL_STATUSES)),
					not(eq(downloadQueue.protocol, 'debrid'))
				)
			);

		const trackedIds = new Set<string>();
		for (const item of activeQueueItems) {
			trackedIds.add(item.downloadId.toLowerCase());
			if (item.infoHash) trackedIds.add(item.infoHash.toLowerCase());
		}
		return trackedIds;
	}

	/**
	 * A torrent counts as ours when it carries no label at all, or one of the
	 * client's configured movie/tv labels. Absent labels count as ours:
	 * manually-added torrents never carry our labels. Foreign labels stay
	 * excluded. The relink paths deliberately keep a stricter rule (they also
	 * require a label); do not fold them in here.
	 */
	private isManagedCategory(client: DownloadClient, download: DownloadInfo): boolean {
		return (
			!client.tvCategory ||
			!download.category ||
			download.category === client.tvCategory ||
			download.category === client.movieCategory
		);
	}

	/**
	 * Movie vs TV for an unmatched download, resolved the same way
	 * isManagedCategory decides "is this ours": by which of the client's
	 * configured categories the download's own category matches. Null when
	 * the download carries no category or matches neither - isManagedCategory
	 * still lets those through, so this can't always resolve.
	 */
	private resolveUnmatchedMediaType(
		client: DownloadClient,
		download: DownloadInfo
	): 'movie' | 'tv' | null {
		if (!download.category) return null;
		if (download.category === client.movieCategory) return 'movie';
		if (download.category === client.tvCategory) return 'tv';
		return null;
	}

	/**
	 * Find a download by hash in the fetched client index. Track and enroll
	 * share one lookup and one not-found reason.
	 */
	private findDownloadByHash(
		byClient: ClientDownloadIndex['byClient'],
		hashLower: string
	): { client: DownloadClient; download: DownloadInfo } | null {
		for (const { client, byHash } of byClient.values()) {
			const download = byHash.get(hashLower);
			if (download) return { client, download };
		}
		return null;
	}

	/**
	 * Resolve a library row from the wizard's TMDB match. One query shape for
	 * the several call sites that need movie-or-series.
	 */
	private async findMediaByTmdbId(
		mediaType: 'movie' | 'tv',
		tmdbId: number
	): Promise<{ movieId: string | null; seriesId: string | null } | null> {
		if (mediaType === 'movie') {
			const [row] = await db
				.select({ id: movies.id })
				.from(movies)
				.where(eq(movies.tmdbId, tmdbId))
				.limit(1);
			return row ? { movieId: row.id, seriesId: null } : null;
		}
		const [row] = await db
			.select({ id: series.id })
			.from(series)
			.where(eq(series.tmdbId, tmdbId))
			.limit(1);
		return row ? { movieId: null, seriesId: row.id } : null;
	}

	/**
	 * Whether this torrent's content is something Cinephage can import: a
	 * video file, or a folder holding at least one. Single non-video files
	 * (.exe, .iso, .rar …) and folders with no video are refused so they
	 * never reach the Unmatched view or the import flow. The path is
	 * stat()'d rather than read by name: a folder called
	 * `Movie.2026.1080p` is not an extension.
	 *
	 * shortcut: an unreadable path, a path not yet on disk, or a scan cut
	 * short by the bounds counts as acceptable — never hide a download on a
	 * guess. Upgrade to the client's file list if a bounded tree walk proves
	 * too slow on network mounts.
	 */
	private async isAcceptableContent(
		client: DownloadClient,
		download: DownloadInfo
	): Promise<boolean> {
		const clientDownloadPath = getDownloadContentPath(
			download,
			getClientProtocol(client.implementation)
		);
		if (!clientDownloadPath) return true;
		const localPath = mapClientPathToLocal(
			clientDownloadPath,
			client.downloadPathLocal,
			client.downloadPathRemote ?? null,
			client.tempPathLocal,
			client.tempPathRemote
		);
		if (!localPath) return true;
		try {
			const stats = await stat(localPath);
			const accepted = stats.isDirectory()
				? await this.folderHasVideo(localPath, 0, { left: MAX_CONTENT_SCAN_ENTRIES })
				: isVideoFile(localPath, CONTENT_SCAN_EXTRA_EXTENSIONS);
			if (!accepted) {
				// This is the only place a real, present download silently drops
				// out of Unmatched - log the path actually scanned so a rejection
				// can be told apart from a genuine mapping/extension gap instead
				// of just disappearing with no trace.
				logger.debug(
					{
						clientName: client.name,
						downloadName: download.name,
						clientDownloadPath,
						localPath,
						isDirectory: stats.isDirectory()
					},
					'Excluding unmatched download - no importable video found at resolved path'
				);
			}
			return accepted;
		} catch (error) {
			// Not on disk yet (still downloading): the wizard and the import
			// pipeline decide once the files exist.
			logger.debug(
				{
					clientName: client.name,
					downloadName: download.name,
					clientDownloadPath,
					localPath,
					error: error instanceof Error ? error.message : String(error)
				},
				'Content path not reachable yet - accepting as unmatched anyway'
			);
			return true;
		}
	}

	/**
	 * True when the tree holds an importable video, or when the walk ran out
	 * of budget or depth (see the shortcut note above). Symlinks are skipped:
	 * they are not directories, which also stops cycles.
	 */
	private async folderHasVideo(
		dir: string,
		depth: number,
		budget: { left: number }
	): Promise<boolean> {
		if (depth > MAX_CONTENT_SCAN_DEPTH || budget.left <= 0) return true;

		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return true;
		}
		budget.left -= entries.length;

		for (const entry of entries) {
			if (entry.isFile() && isVideoFile(entry.name, CONTENT_SCAN_EXTRA_EXTENSIONS)) return true;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (await this.folderHasVideo(join(dir, entry.name), depth + 1, budget)) return true;
		}
		return false;
	}

	/**
	 * List downloads present in clients under a Cinephage-managed label with
	 * no corresponding download_queue row ("unmatched"). Read-only: listing
	 * never mutates anything. Monitor-only — matching and importing live in
	 * the import wizard, so items carry no suggestions.
	 */
	async listUnmatchedDownloads(options?: {
		clientId?: string;
		page?: number;
		limit?: number;
		search?: string;
		mediaType?: 'movie' | 'tv';
	}): Promise<{ items: UnmatchedDownload[]; total: number; page: number; limit: number }> {
		const page = Math.max(1, Math.floor(options?.page ?? 1));
		const limit = Math.min(100, Math.max(1, Math.floor(options?.limit ?? 25)));
		const search = options?.search?.trim().toLowerCase() || '';
		const mediaType = options?.mediaType;

		const { byClient: clientDownloads } = await this.fetchClientDownloadIndex(
			'listing',
			options?.clientId
		);

		if (clientDownloads.size === 0) {
			return { items: [], total: 0, page, limit };
		}

		// Same tracked-set rule as relink: anything with a non-terminal,
		// non-debrid queue row is managed, not unmatched.
		const trackedIds = await this.fetchTrackedIds();

		const unmatched: {
			client: DownloadClient;
			download: DownloadInfo;
			mediaType: 'movie' | 'tv' | null;
		}[] = [];

		for (const { client, byHash } of clientDownloads.values()) {
			for (const download of byHash.values()) {
				if (trackedIds.has(download.hash.toLowerCase())) {
					logger.debug(
						{ clientName: client.name, downloadName: download.name, hash: download.hash },
						'Excluding from unmatched listing - already tracked by a queue row'
					);
					continue;
				}

				// Only downloads in Cinephage-managed categories. No progress
				// gate: still-downloading items list as live statuses.
				if (!this.isManagedCategory(client, download)) {
					logger.debug(
						{
							clientName: client.name,
							downloadName: download.name,
							downloadCategory: download.category,
							configuredMovieCategory: client.movieCategory,
							configuredTvCategory: client.tvCategory
						},
						'Excluding from unmatched listing - category matches neither configured movie nor tv category'
					);
					continue;
				}
				if (!(await this.isAcceptableContent(client, download))) continue;
				// Filter before total/slice (issue #628): otherwise search only
				// ever sees whatever page happened to already be loaded, and
				// total/pagination stay keyed to the unfiltered count.
				if (search && !download.name.toLowerCase().includes(search)) continue;

				const itemMediaType = this.resolveUnmatchedMediaType(client, download);
				if (mediaType && itemMediaType !== mediaType) continue;

				unmatched.push({ client, download, mediaType: itemMediaType });
			}
		}

		const total = unmatched.length;
		const pageItems = unmatched.slice((page - 1) * limit, page * limit);

		// Strong-path attach lookup: exact infohash hits across library
		// files, both cases (clients and the library disagree on hex case).
		// No TMDB, no fuzzy — a hit means identical bytes.
		const pageHashes = [...new Set(pageItems.map(({ download }) => download.hash.toLowerCase()))];
		const hashVariants = [...new Set(pageHashes.flatMap((h) => [h, h.toUpperCase()]))];
		const attachMap = new Map<string, NonNullable<UnmatchedDownload['attachable']>>();
		if (hashVariants.length > 0) {
			const [movieHits, episodeHits] = await Promise.all([
				db
					.select({
						infoHash: movieFiles.infoHash,
						tmdbId: movies.tmdbId,
						title: movies.title
					})
					.from(movieFiles)
					.innerJoin(movies, eq(movieFiles.movieId, movies.id))
					.where(inArray(movieFiles.infoHash, hashVariants)),
				db
					.select({
						infoHash: episodeFiles.infoHash,
						tmdbId: series.tmdbId,
						title: series.title
					})
					.from(episodeFiles)
					.innerJoin(series, eq(episodeFiles.seriesId, series.id))
					.where(inArray(episodeFiles.infoHash, hashVariants))
			]);
			for (const hit of movieHits) {
				if (!hit.infoHash) continue;
				attachMap.set(hit.infoHash.toLowerCase(), {
					mediaType: 'movie',
					tmdbId: hit.tmdbId,
					title: hit.title
				});
			}
			for (const hit of episodeHits) {
				if (!hit.infoHash) continue;
				const key = hit.infoHash.toLowerCase();
				if (!attachMap.has(key)) {
					attachMap.set(key, { mediaType: 'tv', tmdbId: hit.tmdbId, title: hit.title });
				}
			}
		}

		// TMDB suggestions, skipped for items that already have a confirmed
		// infohash attach - a probabilistic guess next to a sure match is just
		// noise. Cache keyed by title+year+mediaType so a page of items
		// sharing a title (season packs, a show's episodes) hits TMDB once.
		const suggestionCache = new Map<string, SuggestedMatch[]>();
		const suggestions = new Map<string, UnmatchedDownload['suggestion']>();
		for (const { download } of pageItems) {
			const hashLower = download.hash.toLowerCase();
			if (attachMap.has(hashLower)) continue;

			const parsed = releaseParser.parse(download.name);
			if (!parsed.cleanTitle) continue;
			const mediaType: 'movie' | 'tv' = parsed.episode ? 'tv' : 'movie';

			const matches = await findSuggestedMatches(
				[parsed.cleanTitle],
				parsed.year,
				mediaType,
				download.name,
				suggestionCache
			);
			const top = matches[0];
			if (!top) continue;

			suggestions.set(hashLower, {
				mediaType: top.mediaType,
				tmdbId: top.tmdbId,
				title: top.title,
				year: top.year,
				confidence: top.confidence
			});
		}

		const items: UnmatchedDownload[] = pageItems.map(
			({ client, download, mediaType: itemMediaType }) => ({
				hash: download.hash,
				name: download.name,
				size: download.size ?? 0,
				status: download.status,
				progress: download.progress,
				category: download.category,
				mediaType: itemMediaType,
				savePath: download.savePath,
				clientId: client.id,
				clientName: client.name,
				attachable: attachMap.get(download.hash.toLowerCase()) ?? null,
				suggestion: suggestions.get(download.hash.toLowerCase()) ?? null
			})
		);

		return { items, total, page, limit };
	}

	/**
	 * Resolve unmatched client hashes to server-local source paths for the
	 * import wizard. Read-only: never mutates. Entries whose torrent vanished
	 * report as missing, already-tracked ones as alreadyTracked — the wizard
	 * skips both with distinct messages.
	 */
	async resolveUnmatchedEntries(entries: { clientId: string; hash: string }[]): Promise<{
		resolved: {
			clientId: string;
			hash: string;
			name: string;
			size: number;
			progress: number;
			localPath: string | null;
			insideManagedRoot: boolean;
			searchHint: string;
		}[];
		missing: { clientId: string; hash: string; reason: string }[];
		alreadyTracked: { clientId: string; hash: string }[];
	}> {
		const resolved: {
			clientId: string;
			hash: string;
			name: string;
			size: number;
			progress: number;
			localPath: string | null;
			insideManagedRoot: boolean;
			searchHint: string;
		}[] = [];
		const missing: { clientId: string; hash: string; reason: string }[] = [];
		const alreadyTracked: { clientId: string; hash: string }[] = [];

		const wanted = entries
			.filter((e) => e.clientId && e.hash)
			.slice(0, 100)
			.map((e) => ({ clientId: e.clientId, key: e.hash.trim().toLowerCase() }));
		if (wanted.length === 0) return { resolved, missing, alreadyTracked };

		const { byClient, fetchFailed } = await this.fetchClientDownloadIndex('resolve');
		// Same rule as the listing: tracked torrents are managed, not
		// unmatched. Without this, a finished wizard flow that resets with
		// ?unmatched= still in the URL would resurrect the same rows.
		const trackedIds = await this.fetchTrackedIds();

		for (const { clientId, key } of wanted) {
			if (trackedIds.has(key)) {
				alreadyTracked.push({ clientId, hash: key });
				continue;
			}
			const entry = byClient.get(clientId);
			const download = entry?.byHash.get(key);
			if (!download || !entry) {
				missing.push({
					clientId,
					hash: key,
					reason: fetchFailed ? 'client_unreachable' : 'not_in_client'
				});
				continue;
			}
			const clientDownloadPath = getDownloadContentPath(
				download,
				getClientProtocol(entry.client.implementation)
			);
			const localPath = clientDownloadPath
				? mapClientPathToLocal(
						clientDownloadPath,
						entry.client.downloadPathLocal,
						entry.client.downloadPathRemote ?? null,
						entry.client.tempPathLocal,
						entry.client.tempPathRemote
					)
				: null;
			resolved.push({
				clientId,
				hash: download.hash,
				name: download.name,
				size: download.size ?? 0,
				progress: download.progress,
				localPath,
				insideManagedRoot: localPath ? await isPathInsideManagedRoot(localPath) : false,
				searchHint: releaseParser.parse(download.name).cleanTitle?.trim() || download.name
			});
		}

		return { resolved, missing, alreadyTracked };
	}

	/**
	 * Insert a download_queue row recording what an imported client torrent
	 * belongs to. The torrent stays in the client for seeding; the row is
	 * always seeding-imported — the files are already in the library by the
	 * time this runs.
	 */
	private async createLinkedQueueRow(input: {
		client: DownloadClient;
		download: DownloadInfo;
		movieId?: string | null;
		seriesId?: string | null;
		seasonNumber?: number | null;
		status: QueueStatus;
		importedAt?: string | null;
		errorMessage?: string | null;
		origin: 'unmatched_track' | 'unmatched_enroll';
	}): Promise<string> {
		const { client, download } = input;
		const now = new Date().toISOString();
		const id = randomUUID();
		const parsed = releaseParser.parse(download.name);
		const protocol = getClientProtocol(client.implementation);

		// Same path rule as relink: a metadata-less torrent's savePath is a
		// root, not this download's content — store null rather than a path
		// recovery could mistake for its files.
		const clientDownloadPath = getDownloadContentPath(download, protocol);
		const outputPath = clientDownloadPath
			? mapClientPathToLocal(
					clientDownloadPath,
					client.downloadPathLocal,
					client.downloadPathRemote ?? null,
					client.tempPathLocal,
					client.tempPathRemote
				)
			: null;

		await db.insert(downloadQueue).values({
			id,
			downloadClientId: client.id,
			downloadId: download.hash,
			infoHash: download.hash,
			title: download.name,
			protocol,
			movieId: input.movieId ?? null,
			seriesId: input.seriesId ?? null,
			seasonNumber: input.seasonNumber ?? parsed.episode?.season ?? null,
			status: input.status,
			progress: String(download.progress),
			size: download.size || null,
			quality: {
				resolution: parsed.resolution ?? undefined,
				source: parsed.source ?? undefined,
				codec: parsed.codec ?? undefined,
				hdr: parsed.hdr ?? undefined,
				languages: parsed.languages.length > 0 ? parsed.languages : undefined
			},
			releaseGroup: parsed.releaseGroup ?? undefined,
			clientDownloadPath,
			outputPath,
			completedAt: download.progress >= 1 ? now : null,
			importedAt: input.importedAt ?? null,
			errorMessage: input.errorMessage ?? null,
			addedAt: now,
			isAutomatic: false,
			isUpgrade: false,
			origin: input.origin
		});

		return id;
	}

	/**
	 * Track an unmatched download after the import wizard imported its
	 * files. Single path, called once per successful wizard import: the
	 * torrent stays in the client for seeding while the queue row records
	 * what it belongs to. The wizard's match (mediaType + TMDB id) resolves
	 * the library row server-side; pairs for media with no library file are
	 * rejected — a seeding-imported marker without bytes on disk would be
	 * false. Idempotent.
	 */
	async trackUnmatchedDownloads(
		pairs: {
			hash: string;
			mediaType: 'movie' | 'tv';
			tmdbId: number;
			seasonNumber?: number | null;
			episodeNumber?: number | null;
		}[]
	): Promise<{
		tracked: { hash: string; queueId: string }[];
		skipped: { hash: string; reason: string }[];
	}> {
		const result: {
			tracked: { hash: string; queueId: string }[];
			skipped: { hash: string; reason: string }[];
		} = {
			tracked: [],
			skipped: []
		};

		const { byClient: clientDownloads, fetchFailed } = await this.fetchClientDownloadIndex('track');
		if (pairs.length === 0 || clientDownloads.size === 0) return result;

		const trackedIds = await this.fetchTrackedIds();

		for (const pair of pairs.slice(0, 100)) {
			const hashLower = pair.hash?.trim().toLowerCase();
			if (
				!hashLower ||
				(pair.mediaType !== 'movie' && pair.mediaType !== 'tv') ||
				!Number.isInteger(pair.tmdbId)
			) {
				result.skipped.push({ hash: pair.hash, reason: 'invalid_pair' });
				continue;
			}

			const media = await this.findMediaByTmdbId(pair.mediaType, pair.tmdbId);
			if (!media) {
				result.skipped.push({ hash: pair.hash, reason: 'not_in_library' });
				continue;
			}

			// Never record a seeding-imported row for media with no library
			// file: without bytes on disk the history marker would be false.
			// For TV, check the specific episode when we know which one this
			// torrent covers - a file for some other episode in the series (or
			// even the same season) doesn't mean this episode is on disk.
			const hasLibraryFile =
				media.movieId != null
					? (
							await db
								.select({ id: movieFiles.id })
								.from(movieFiles)
								.where(eq(movieFiles.movieId, media.movieId))
								.limit(1)
						).length > 0
					: pair.seasonNumber != null && pair.episodeNumber != null
						? (
								await db
									.select({ hasFile: episodes.hasFile })
									.from(episodes)
									.where(
										and(
											eq(episodes.seriesId, media.seriesId as string),
											eq(episodes.seasonNumber, pair.seasonNumber),
											eq(episodes.episodeNumber, pair.episodeNumber)
										)
									)
									.limit(1)
							).at(0)?.hasFile === true
						: (
								await db
									.select({ id: episodeFiles.id })
									.from(episodeFiles)
									.where(eq(episodeFiles.seriesId, media.seriesId as string))
									.limit(1)
							).length > 0;
			if (!hasLibraryFile) {
				result.skipped.push({ hash: pair.hash, reason: 'no_library_file' });
				continue;
			}

			const found = this.findDownloadByHash(clientDownloads, hashLower);
			if (!found) {
				result.skipped.push({
					hash: pair.hash,
					reason: fetchFailed ? 'client_unreachable' : 'not_in_client'
				});
				continue;
			}

			const { client, download } = found;
			if (!this.isManagedCategory(client, download)) {
				result.skipped.push({ hash: pair.hash, reason: 'foreign_category' });
				continue;
			}
			if (!(await this.isAcceptableContent(client, download))) {
				result.skipped.push({ hash: pair.hash, reason: 'unsupported_filetype' });
				continue;
			}

			// Attaching records a fully-seeding torrent: partial content
			// cannot back a seeding-imported marker.
			if (download.progress < 1) {
				result.skipped.push({ hash: pair.hash, reason: 'incomplete' });
				continue;
			}

			const now = new Date().toISOString();
			if (trackedIds.has(hashLower)) {
				result.skipped.push({ hash: pair.hash, reason: 'already_tracked' });
				continue;
			}
			// Claim the hash so a duplicate pair later in this batch skips
			// instead of inserting a second row.
			trackedIds.add(hashLower);

			const queueId = await this.createLinkedQueueRow({
				client,
				download,
				movieId: media.movieId,
				seriesId: media.seriesId,
				seasonNumber: pair.seasonNumber,
				status: 'seeding-imported',
				importedAt: now,
				origin: 'unmatched_track'
			});
			const linkedItem = await this.getQueueItem(queueId);
			if (linkedItem) {
				this.emit('queue:added', linkedItem);
				this.emitSSE('queue:added', linkedItem);
			}

			await db.insert(downloadHistory).values({
				downloadClientId: client.id,
				downloadClientName: client.name,
				downloadId: download.hash,
				infoHash: download.hash,
				title: download.name,
				protocol: 'torrent',
				movieId: media.movieId,
				seriesId: media.seriesId,
				seasonNumber: pair.seasonNumber ?? null,
				status: 'imported',
				statusReason: 'Tracked from Unmatched tab after import wizard',
				size: download.size || null,
				grabbedAt: now,
				completedAt: now,
				importedAt: now
			});

			result.tracked.push({ hash: download.hash, queueId });
			logger.info(
				{ hash: download.hash, mediaType: pair.mediaType, tmdbId: pair.tmdbId, queueId },
				'Tracked unmatched download after import'
			);
		}

		return result;
	}

	/**
	 * Client status → queue status mirror for enrolled rows. Every client
	 * status has a queue equivalent except 'error', which becomes 'failed'.
	 */
	private mirrorUnmatchedStatus(status: DownloadInfo['status']): QueueStatus {
		switch (status) {
			case 'error':
				return 'failed';
			default:
				return status;
		}
	}

	/**
	 * Enroll an unmatched download for monitor-driven import. The wizard
	 * matched it, but its files live inside a managed root so the wizard
	 * cannot execute the import itself. Enrollment creates a normal tracked
	 * row at the mirrored live status; the monitor's ImportService moves the
	 * files on completion. No history marker until the import lands.
	 * Matches new to the library are added automatically (unmonitored, no
	 * search — the file is already in hand) when rootFolderId is provided.
	 */
	async enrollUnmatchedDownloads(
		pairs: {
			hash: string;
			mediaType: 'movie' | 'tv';
			tmdbId: number;
			seasonNumber?: number | null;
			rootFolderId?: string | null;
		}[]
	): Promise<{
		enrolled: { hash: string; queueId: string }[];
		skipped: { hash: string; reason: string }[];
	}> {
		const result: {
			enrolled: { hash: string; queueId: string }[];
			skipped: { hash: string; reason: string }[];
		} = { enrolled: [], skipped: [] };

		const { byClient: clientDownloads, fetchFailed } =
			await this.fetchClientDownloadIndex('enroll');
		if (pairs.length === 0 || clientDownloads.size === 0) return result;

		const trackedIds = await this.fetchTrackedIds();

		for (const pair of pairs.slice(0, 100)) {
			const hashLower = pair.hash?.trim().toLowerCase();
			if (
				!hashLower ||
				(pair.mediaType !== 'movie' && pair.mediaType !== 'tv') ||
				!Number.isInteger(pair.tmdbId)
			) {
				result.skipped.push({ hash: pair.hash, reason: 'invalid_pair' });
				continue;
			}

			// Verify the torrent itself before touching the library: a
			// vanished, foreign or already-tracked hash must never leave a
			// stray library row behind.
			const found = this.findDownloadByHash(clientDownloads, hashLower);
			if (!found) {
				result.skipped.push({
					hash: pair.hash,
					reason: fetchFailed ? 'client_unreachable' : 'not_in_client'
				});
				continue;
			}

			const { client, download } = found;
			if (!this.isManagedCategory(client, download)) {
				result.skipped.push({ hash: pair.hash, reason: 'foreign_category' });
				continue;
			}
			if (!(await this.isAcceptableContent(client, download))) {
				result.skipped.push({ hash: pair.hash, reason: 'unsupported_filetype' });
				continue;
			}

			if (trackedIds.has(hashLower)) {
				result.skipped.push({ hash: pair.hash, reason: 'already_tracked' });
				continue;
			}
			trackedIds.add(hashLower);

			let media = await this.findMediaByTmdbId(pair.mediaType, pair.tmdbId);
			if (!media) {
				// New to the library: add it unmonitored (the file is in
				// hand — monitoring would only trigger a redundant grab).
				if (!pair.rootFolderId) {
					result.skipped.push({ hash: pair.hash, reason: 'not_in_library' });
					continue;
				}
				try {
					// Lazy-loaded: the add modules pull a heavy graph (TMDB,
					// naming, metadata) that must not weigh down this
					// module's import — see the recovery suite timeout.
					if (pair.mediaType === 'movie') {
						const { addMovieToLibrary } = await import('#lib/server/library/add/add-movie.js');
						await addMovieToLibrary({
							tmdbId: pair.tmdbId,
							rootFolderId: pair.rootFolderId,
							monitored: false,
							minimumAvailability: 'released',
							availabilityDelay: 0,
							searchOnAdd: false,
							wantsSubtitles: true
						});
					} else {
						const { addSeriesToLibrary } = await import('#lib/server/library/add/add-series.js');
						await addSeriesToLibrary({
							tmdbId: pair.tmdbId,
							rootFolderId: pair.rootFolderId,
							monitored: false,
							seasonFolder: true,
							seriesType: 'standard',
							monitorType: 'none',
							monitorNewItems: 'all',
							monitorSpecials: false,
							searchOnAdd: false,
							wantsSubtitles: true
						});
					}
				} catch (error) {
					logger.warn(
						{
							hash: pair.hash,
							tmdbId: pair.tmdbId,
							error: error instanceof Error ? error.message : String(error)
						},
						'Auto-add for unmatched enroll failed'
					);
					result.skipped.push({ hash: pair.hash, reason: 'add_failed' });
					continue;
				}
				media = await this.findMediaByTmdbId(pair.mediaType, pair.tmdbId);
				if (!media) {
					result.skipped.push({ hash: pair.hash, reason: 'add_failed' });
					continue;
				}
			}

			const status = this.mirrorUnmatchedStatus(download.status);
			const queueId = await this.createLinkedQueueRow({
				client,
				download,
				movieId: media.movieId,
				seriesId: media.seriesId,
				seasonNumber: pair.seasonNumber,
				status,
				errorMessage:
					status === 'failed'
						? (download.errorMessage ?? 'Reported as error by download client')
						: null,
				origin: 'unmatched_enroll'
			});
			const enrolledItem = await this.getQueueItem(queueId);
			if (enrolledItem) {
				this.emit('queue:added', enrolledItem);
				this.emitSSE('queue:added', enrolledItem);
			}

			result.enrolled.push({ hash: download.hash, queueId });
			logger.info(
				{ hash: download.hash, mediaType: pair.mediaType, tmdbId: pair.tmdbId, queueId, status },
				'Enrolled unmatched download for monitor import'
			);
		}

		return result;
	}
}

// Singleton getter - preferred way to access the service
export function getDownloadMonitor(): DownloadMonitorService {
	return DownloadMonitorService.getInstance();
}

// Reset singleton (for testing)
export async function resetDownloadMonitor(): Promise<void> {
	await DownloadMonitorService.resetInstance();
}

// Backward-compatible export (prefer getDownloadMonitor())
export const downloadMonitor = DownloadMonitorService.getInstance();
