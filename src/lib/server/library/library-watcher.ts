/**
 * Library Watcher Service
 *
 * Watches root folders for filesystem changes using @parcel/watcher.
 * Triggers incremental scans when files are added, removed, or changed.
 *
 * @parcel/watcher (not chokidar) is used deliberately: chokidar creates one
 * native watch per FILE in addition to one per directory (confirmed by
 * reading chokidar's handler.js - _handleFile and _handleDir both call
 * _watchWithNodeFs, which maps 1:1 to fs.watch/inotify_add_watch). For a
 * large ~10k+ file library that exhausts fs.inotify.max_user_watches. Linux inotify
 * already reports create/modify/delete of files within a watched directory
 * through that single directory-level watch, so a per-file watch is
 * unnecessary. @parcel/watcher's native backend (inotify/FSEvents/
 * ReadDirectoryChangesW depending on platform) watches at the directory
 * level only, which is the structural fix.
 */

import { promises as fsPromises } from 'node:fs';
import watcher, { type AsyncSubscription, type Event as ParcelEvent } from '@parcel/watcher';
import { db } from '#lib/server/db/index.js';
import { rootFolders, librarySettings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { diskScanService } from './disk-scan.js';
import { libraryOperationLock } from './library-operation-lock.js';
import { mediaMatcherService } from './media-matcher.js';
import { scheduleReconcileRootFolder } from '#lib/server/subtitles/services/subtitle-reconcile-hooks.js';
import { isVideoFile } from './media-info.js';
import { EventEmitter } from 'events';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'scans' as const });

const DEBOUNCE_TIME = 5000;

const NETWORK_FS_TYPES = new Set([
	'nfs',
	'nfs4',
	'cifs',
	'smbfs',
	'smb2',
	'fuse.sshfs',
	'fuse.rclone',
	'fuse.s3fs',
	'glusterfs',
	'davfs',
	'overlay' // Docker bind mounts from Windows hosts appear as overlay
]);

async function detectFilesystemType(targetPath: string): Promise<string | null> {
	try {
		const mounts = await fsPromises.readFile('/proc/mounts', 'utf8');
		let bestLength = 0;
		let bestFsType: string | null = null;
		for (const line of mounts.split('\n')) {
			const parts = line.split(' ');
			if (parts.length < 3) continue;
			const mountPoint = parts[1];
			const fsType = parts[2];
			if (
				(targetPath === mountPoint || targetPath.startsWith(mountPoint + '/')) &&
				mountPoint.length > bestLength
			) {
				bestLength = mountPoint.length;
				bestFsType = fsType;
			}
		}
		return bestFsType;
	} catch {
		return null;
	}
}

interface FileChange {
	type: 'add' | 'change' | 'unlink';
	path: string;
	rootFolderId: string;
	timestamp: number;
}

/**
 * @parcel/watcher's `ignore` option rejects RegExp entries that carry flags
 * ("RegExp ignore patterns must not have flags" - its native matcher has no
 * concept of them), so a flagged /i pattern throws synchronously inside
 * subscribe() rather than just being case-sensitive. Case-fold each literal
 * character into a [xX] class instead, producing an equivalent flagless
 * pattern chokidar's /i regexes can't express here.
 */
function caseInsensitiveLiteral(literal: string): string {
	return literal
		.split('')
		.map((ch) => {
			const lower = ch.toLowerCase();
			const upper = ch.toUpperCase();
			if (lower === upper) return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			return `[${lower}${upper}]`;
		})
		.join('');
}

// Same set chokidar's `ignored` used, minus the two /i flags @parcel/watcher can't accept.
// Exported so tests can assert every RegExp here stays flagless.
export const IGNORED_PATTERNS = [
	/(^|[/\\])\../,
	/node_modules/,
	/@eaDir/,
	new RegExp(caseInsensitiveLiteral('#recycle')),
	new RegExp(caseInsensitiveLiteral('$RECYCLE.BIN'))
];

export class LibraryWatcherService extends EventEmitter {
	private static instance: LibraryWatcherService;
	private subscriptions: Map<string, AsyncSubscription> = new Map();
	private pendingChanges: Map<string, FileChange> = new Map();
	private processTimeout: NodeJS.Timeout | null = null;
	private enabled = false;
	private rootFolderMap: Map<string, string> = new Map();
	// Suppress duplicate ENOSPC warnings per folder (events can keep arriving after the first).
	private enospcWarned: Set<string> = new Set();

	private constructor() {
		super();
	}

	static getInstance(): LibraryWatcherService {
		if (!LibraryWatcherService.instance) {
			LibraryWatcherService.instance = new LibraryWatcherService();
		}
		return LibraryWatcherService.instance;
	}

	private async isWatchingEnabled(): Promise<boolean> {
		const setting = await db
			.select()
			.from(librarySettings)
			.where(eq(librarySettings.key, 'watch_enabled'))
			.limit(1);

		if (setting.length > 0) {
			return setting[0].value === 'true';
		}

		return true;
	}

	async initialize(): Promise<void> {
		const watchEnabled = await this.isWatchingEnabled();
		if (!watchEnabled) {
			logger.info('[LibraryWatcher] Filesystem watching is disabled');
			return;
		}

		const folders = await db.select().from(rootFolders);

		for (const folder of folders) {
			await this.watchFolder(folder.id, folder.path);
		}

		this.enabled = true;
		logger.info({ folderCount: folders.length }, '[LibraryWatcher] Initialized watchers');
	}

	async shutdown(): Promise<void> {
		for (const [folderId, subscription] of this.subscriptions) {
			await subscription.unsubscribe();
			logger.debug({ folderId }, '[LibraryWatcher] Stopped watching folder');
		}

		this.subscriptions.clear();
		this.rootFolderMap.clear();
		this.pendingChanges.clear();
		this.enospcWarned.clear();

		if (this.processTimeout) {
			clearTimeout(this.processTimeout);
			this.processTimeout = null;
		}

		this.enabled = false;
	}

	async watchFolder(folderId: string, folderPath: string): Promise<void> {
		if (this.subscriptions.has(folderId)) {
			await this.subscriptions.get(folderId)?.unsubscribe();
		}

		this.rootFolderMap.set(folderPath, folderId);
		this.enospcWarned.delete(folderId);

		const fsType = await detectFilesystemType(folderPath);
		if (fsType !== null) {
			if (NETWORK_FS_TYPES.has(fsType)) {
				logger.warn(
					{ folderId, folderPath, fsType },
					'[LibraryWatcher] Path is on a network filesystem: inotify-based watching may not function reliably over this mount type; scan-on-change may miss events'
				);
			} else {
				logger.info({ folderId, folderPath, fsType }, '[LibraryWatcher] Filesystem type detected');
			}
		}

		try {
			const subscription = await watcher.subscribe(
				folderPath,
				(err, events) => this.handleParcelEvents(folderId, folderPath, err, events),
				{ ignore: IGNORED_PATTERNS }
			);
			this.subscriptions.set(folderId, subscription);
			logger.info({ folderId, folderPath }, '[LibraryWatcher] Watching folder');
		} catch (error) {
			this.handleWatchError(folderId, folderPath, error);
		}
	}

	/**
	 * Handles both the initial subscribe() rejection and later async errors
	 * delivered via the subscribe() callback (e.g. a nested directory created
	 * after subscription pushes past the watch-descriptor limit).
	 */
	private handleWatchError(folderId: string, folderPath: string, error: unknown): void {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') {
			if (!this.enospcWarned.has(folderId)) {
				this.enospcWarned.add(folderId);
				logger.warn(
					{ folderId, folderPath },
					'[LibraryWatcher] ENOSPC: system inotify watch limit reached. ' +
						'Increase fs.inotify.max_user_watches (e.g. echo 524288 | sudo tee /proc/sys/fs/inotify/max_user_watches), ' +
						'or disable "Watch filesystem for changes" in Settings and rely on scheduled scans instead.'
				);
			}
			// ENOSPC is not recoverable by the scheduler; suppress re-emit to avoid log spam.
			return;
		}
		logger.error({ err: error, folderId }, '[LibraryWatcher] Error in folder');
		this.emit('error', { folderId, error });
	}

	private handleParcelEvents(
		folderId: string,
		folderPath: string,
		err: Error | null,
		events: ParcelEvent[]
	): void {
		if (err) {
			this.handleWatchError(folderId, folderPath, err);
			return;
		}

		for (const event of events) {
			const type = event.type === 'create' ? 'add' : event.type === 'delete' ? 'unlink' : 'change';
			this.handleFileEvent(type, event.path, folderId);
		}
	}

	async unwatchFolder(folderId: string): Promise<void> {
		const subscription = this.subscriptions.get(folderId);
		if (subscription) {
			await subscription.unsubscribe();
			this.subscriptions.delete(folderId);
			this.enospcWarned.delete(folderId);

			for (const [path, id] of this.rootFolderMap) {
				if (id === folderId) {
					this.rootFolderMap.delete(path);
					break;
				}
			}

			logger.debug({ folderId }, '[LibraryWatcher] Stopped watching folder');
		}
	}

	private handleFileEvent(
		type: 'add' | 'change' | 'unlink',
		path: string,
		rootFolderId: string
	): void {
		if (!isVideoFile(path)) {
			return;
		}

		logger.debug({ type, path }, '[LibraryWatcher] File event');

		this.pendingChanges.set(path, {
			type,
			path,
			rootFolderId,
			timestamp: Date.now()
		});

		if (this.processTimeout) {
			clearTimeout(this.processTimeout);
		}

		this.processTimeout = setTimeout(() => {
			this.processPendingChanges();
		}, DEBOUNCE_TIME);
	}

	private requeue(changes: FileChange[]): void {
		for (const change of changes) {
			this.pendingChanges.set(change.path, change);
		}

		if (this.processTimeout) {
			clearTimeout(this.processTimeout);
		}

		this.processTimeout = setTimeout(() => {
			this.processPendingChanges();
		}, DEBOUNCE_TIME);
	}

	private async processPendingChanges(): Promise<void> {
		if (this.pendingChanges.size === 0) {
			return;
		}

		const changesByFolder = new Map<string, FileChange[]>();

		for (const [, change] of this.pendingChanges) {
			const existing = changesByFolder.get(change.rootFolderId) || [];
			existing.push(change);
			changesByFolder.set(change.rootFolderId, existing);
		}

		this.pendingChanges.clear();

		for (const [folderId, changes] of changesByFolder) {
			logger.info({ folderId, changeCount: changes.length }, '[LibraryWatcher] Processing changes');

			try {
				if (diskScanService.scanning || libraryOperationLock.isLocked) {
					logger.debug(
						{ changeCount: changes.length },
						'[LibraryWatcher] Scan or rename in progress, re-queueing changes'
					);
					this.requeue(changes);
					continue;
				}

				await diskScanService.scanRootFolder(folderId);

				await mediaMatcherService.processAllUnmatched();

				// Best-effort: reconcile subtitle sidecars for the scanned folder.
				// Fire and forget so a subtitle problem cannot fail the watcher cycle.
				scheduleReconcileRootFolder(folderId).catch((error) => {
					logger.warn(
						{ err: error, folderId },
						'[LibraryWatcher] Subtitle reconciliation hook failed'
					);
				});

				this.emit('processed', { folderId, changes: changes.length });
			} catch (error) {
				logger.error({ err: error, ...{ folderId } }, '[LibraryWatcher] Error processing changes');
				this.emit('error', { folderId, error });

				// Re-queue only when the failure is transient (scan/lock contention).
				// Permanent errors (e.g. root folder deleted) would otherwise loop forever.
				if (diskScanService.scanning || libraryOperationLock.isLocked) {
					this.requeue(changes);
				}
			}
		}
	}

	getStatus(): { enabled: boolean; watchedFolders: string[] } {
		return {
			enabled: this.enabled,
			watchedFolders: Array.from(this.subscriptions.keys())
		};
	}

	async refresh(): Promise<void> {
		await this.shutdown();
		await this.initialize();
	}
}

export const libraryWatcherService = LibraryWatcherService.getInstance();
