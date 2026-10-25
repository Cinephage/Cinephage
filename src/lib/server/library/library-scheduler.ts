/**
 * Library Scheduler Service
 *
 * Manages periodic library scans and coordinates startup initialization.
 * Provides centralized control over library scanning operations.
 */

import { db } from '#lib/server/db/index.js';
import { librarySettings, libraryScanHistory, rootFolders, series } from '#lib/server/db/schema.js';
import { eq, desc, and } from 'drizzle-orm';
import { diskScanService, type ScanResult } from './disk-scan.js';
import { mediaMatcherService } from './media-matcher.js';
import { libraryWatcherService } from './library-watcher.js';
import { getImportService } from '#lib/server/downloadClients/import/ImportService.js';
import { scheduleReconcileRootFolder } from '#lib/server/subtitles/services/subtitle-reconcile-hooks.js';
import { EventEmitter } from 'events';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'scans' as const });
import type { BackgroundService, ServiceStatus } from '#lib/server/services/background-service.js';

/**
 * Default scan interval in hours
 */
const DEFAULT_SCAN_INTERVAL_HOURS = 12;

/**
 * Minimum scan interval in hours
 */
const MIN_SCAN_INTERVAL_HOURS = 1;

/**
 * LibrarySchedulerService - Coordinate library scanning operations
 *
 * Implements BackgroundService for lifecycle management via ServiceManager.
 */
export class LibrarySchedulerService extends EventEmitter implements BackgroundService {
	private static instance: LibrarySchedulerService | null = null;

	readonly name = 'LibraryScheduler';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;

	private scanInterval: NodeJS.Timeout | null = null;
	private isInitialized = false;
	private lastScanTime: Date | null = null;

	private constructor() {
		super();
	}

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	static getInstance(): LibrarySchedulerService {
		if (!LibrarySchedulerService.instance) {
			LibrarySchedulerService.instance = new LibrarySchedulerService();
		}
		return LibrarySchedulerService.instance;
	}

	/** Reset the singleton instance (for testing) */
	static async resetInstance(): Promise<void> {
		if (LibrarySchedulerService.instance) {
			await LibrarySchedulerService.instance.stop();
			LibrarySchedulerService.instance = null;
		}
	}

	/**
	 * Get configured scan interval in hours
	 */
	private async getScanIntervalHours(): Promise<number> {
		const setting = await db
			.select()
			.from(librarySettings)
			.where(eq(librarySettings.key, 'scan_interval_hours'))
			.limit(1);

		if (setting.length > 0) {
			const hours = parseInt(setting[0].value);
			if (!isNaN(hours) && hours >= MIN_SCAN_INTERVAL_HOURS) {
				return hours;
			}
		}

		return DEFAULT_SCAN_INTERVAL_HOURS;
	}

	/**
	 * Check if scan on startup is enabled
	 */
	private async shouldScanOnStartup(): Promise<boolean> {
		const setting = await db
			.select()
			.from(librarySettings)
			.where(eq(librarySettings.key, 'scan_on_startup'))
			.limit(1);

		if (setting.length > 0) {
			return setting[0].value === 'true';
		}

		// Default to true
		return true;
	}

	/**
	 * Start the scheduler (non-blocking)
	 * Implements BackgroundService.start()
	 */
	start(): void {
		if (this.isInitialized || this._status === 'starting') {
			logger.debug('[LibraryScheduler] Already initialized or starting');
			return;
		}

		this._status = 'starting';
		logger.info('[LibraryScheduler] Starting...');

		// Run initialization in background
		setImmediate(() => {
			this.initialize()
				.then(() => {
					this._status = 'ready';
				})
				.catch((err) => {
					this._error = err instanceof Error ? err : new Error(String(err));
					this._status = 'error';
					logger.error({ err: this._error }, '[LibraryScheduler] Failed to initialize');
				});
		});
	}

	/**
	 * Initialize the scheduler and start background operations
	 */
	async initialize(): Promise<void> {
		if (this.isInitialized) {
			logger.debug('[LibraryScheduler] Already initialized');
			return;
		}

		logger.info('[LibraryScheduler] Initializing...');

		// Add error listener to prevent unhandled error crashes
		libraryWatcherService.on('error', (data) => {
			logger.error({ data }, '[LibraryScheduler] LibraryWatcher error');
			// Emit to scheduler's own events for monitoring
			this.emit('watcherError', data);
		});

		// Initialize the filesystem watcher in background (don't block startup)
		libraryWatcherService.initialize().catch((error) => {
			logger.error({ err: error }, '[LibraryScheduler] Failed to initialize filesystem watcher');
		});

		// Set up periodic scans (doesn't need watcher to be ready)
		await this.setupPeriodicScans();

		// Check if we should scan on startup
		const scanOnStartup = await this.shouldScanOnStartup();
		if (scanOnStartup) {
			// Get all root folders
			const allFolders = await db.select({ id: rootFolders.id }).from(rootFolders);

			// Find folders that have NEVER been successfully scanned
			const unscannedFolders: string[] = [];
			for (const folder of allFolders) {
				const wasScanned = await this.hasFolderBeenScanned(folder.id);
				if (!wasScanned) {
					unscannedFolders.push(folder.id);
				}
			}

			if (unscannedFolders.length > 0) {
				logger.info(
					{
						count: unscannedFolders.length
					},
					'[LibraryScheduler] Scanning folders that have never been scanned'
				);

				// Scan unscanned folders in background
				for (const folderId of unscannedFolders) {
					this.queueFolderScan(folderId);
				}
			} else if (allFolders.length > 0) {
				// All folders have been scanned at least once - check if periodic scan is due
				const lastScan = await this.getLastScanTime();
				const hoursSinceLastScan = lastScan
					? (Date.now() - lastScan.getTime()) / (1000 * 60 * 60)
					: Infinity;

				const scanInterval = await this.getScanIntervalHours();

				if (hoursSinceLastScan >= scanInterval) {
					logger.info('[LibraryScheduler] Periodic scan is due, starting startup scan...');
					this.runFullScan().catch((error) => {
						logger.error({ err: error }, '[LibraryScheduler] Startup scan failed');
					});
				} else {
					logger.debug(
						{
							hoursSinceLastScan: hoursSinceLastScan.toFixed(1)
						},
						'[LibraryScheduler] No startup scan needed'
					);
				}
			}
		}

		this.isInitialized = true;
		this._status = 'ready';
		logger.info('[LibraryScheduler] Initialized');
	}

	/**
	 * Stop the scheduler
	 * Implements BackgroundService.stop()
	 */
	async stop(): Promise<void> {
		logger.info('[LibraryScheduler] Stopping...');

		// Stop periodic scans
		if (this.scanInterval) {
			clearInterval(this.scanInterval);
			this.scanInterval = null;
		}

		// Stop filesystem watcher
		await libraryWatcherService.shutdown();

		this.isInitialized = false;
		this._status = 'pending';
		logger.info('[LibraryScheduler] Stopped');
	}

	/**
	 * Shutdown the scheduler (alias for stop, backward compatibility)
	 */
	async shutdown(): Promise<void> {
		return this.stop();
	}

	/**
	 * Set up periodic scan interval
	 */
	private async setupPeriodicScans(): Promise<void> {
		// Clear existing interval
		if (this.scanInterval) {
			clearInterval(this.scanInterval);
		}

		const intervalHours = await this.getScanIntervalHours();
		const intervalMs = intervalHours * 60 * 60 * 1000;

		logger.info({ intervalHours }, '[LibraryScheduler] Setting up periodic scans');

		this.scanInterval = setInterval(async () => {
			logger.info('[LibraryScheduler] Running scheduled scan...');
			try {
				await this.runFullScan();
			} catch (error) {
				logger.error({ err: error }, '[LibraryScheduler] Scheduled scan failed');
			}
		}, intervalMs);
	}

	/**
	 * Run a full scan of all root folders
	 */
	async runFullScan(): Promise<ScanResult[]> {
		if (diskScanService.scanning) {
			logger.debug('[LibraryScheduler] Scan already in progress');
			return [];
		}

		this.emit('scanStart', { type: 'full' });

		try {
			// Scan all root folders
			const results = await diskScanService.scanAll();
			const failedScans = results.filter((result) => !result.success);
			if (failedScans.length > 0) {
				throw new Error(this.formatFailedScanMessage(failedScans));
			}

			// Process unmatched files
			logger.info('[LibraryScheduler] Processing unmatched files...');
			await mediaMatcherService.processAllUnmatched();

			// Update series stats (cached episode counts)
			await this.updateAllSeriesStats();
			this.lastScanTime = new Date();

			// Best-effort subtitle reconciliation for the scanned folders. Fire and
			// forget so a subtitle failure can never block or fail the scan.
			for (const result of results) {
				scheduleReconcileRootFolder(result.rootFolderId).catch((error) => {
					logger.warn(
						{ err: error, rootFolderId: result.rootFolderId },
						'[LibraryScheduler] Subtitle reconciliation hook failed'
					);
				});
			}

			this.emit('scanComplete', { type: 'full', results });
			return results;
		} catch (error) {
			this.emit('scanError', { type: 'full', error });
			throw error;
		}
	}

	/**
	 * Run a scan for a specific root folder
	 */
	async runFolderScan(rootFolderId: string): Promise<ScanResult> {
		if (diskScanService.scanning) {
			throw new Error('A scan is already in progress');
		}

		this.emit('scanStart', { type: 'folder', rootFolderId });

		try {
			const result = await diskScanService.scanRootFolder(rootFolderId);
			if (!result.success) {
				throw new Error(result.error || `Scan failed for ${result.rootFolderPath}`);
			}

			// Update series stats (cached episode counts)
			await this.updateAllSeriesStats();
			this.lastScanTime = new Date();

			// Best-effort subtitle reconciliation for the scanned folder.
			scheduleReconcileRootFolder(rootFolderId).catch((error) => {
				logger.warn(
					{ err: error, rootFolderId },
					'[LibraryScheduler] Subtitle reconciliation hook failed'
				);
			});

			this.emit('scanComplete', { type: 'folder', rootFolderId, result });
			return result;
		} catch (error) {
			this.emit('scanError', { type: 'folder', rootFolderId, error });
			throw error;
		}
	}

	/**
	 * Get the last scan time from database
	 */
	private async getLastScanTime(): Promise<Date | null> {
		const lastScan = await db
			.select({ completedAt: libraryScanHistory.completedAt })
			.from(libraryScanHistory)
			.where(eq(libraryScanHistory.status, 'completed'))
			.orderBy(desc(libraryScanHistory.completedAt))
			.limit(1);

		if (lastScan.length > 0 && lastScan[0].completedAt) {
			return new Date(lastScan[0].completedAt);
		}

		return null;
	}

	/**
	 * Check if a folder has ever had a successful scan
	 */
	async hasFolderBeenScanned(rootFolderId: string): Promise<boolean> {
		const result = await db
			.select({ id: libraryScanHistory.id })
			.from(libraryScanHistory)
			.where(
				and(
					eq(libraryScanHistory.rootFolderId, rootFolderId),
					eq(libraryScanHistory.status, 'completed')
				)
			)
			.limit(1);

		return result.length > 0;
	}

	/**
	 * Queue a scan for a specific folder (non-blocking).
	 * If a scan is already running, the request is skipped (periodic scan will catch it).
	 */
	queueFolderScan(rootFolderId: string): void {
		if (diskScanService.scanning) {
			logger.debug(
				{
					rootFolderId
				},
				'[LibraryScheduler] Scan already in progress, folder will be caught on next scan'
			);
			return;
		}

		this.runFolderScan(rootFolderId).catch((error) => {
			logger.error({ err: error, rootFolderId }, '[LibraryScheduler] Queued folder scan failed');
		});
	}

	/**
	 * Update cached episode counts for all series.
	 * Called after scans to ensure season/series counts are accurate.
	 */
	private async updateAllSeriesStats(): Promise<void> {
		const allSeries = await db.select({ id: series.id }).from(series);
		if (allSeries.length === 0) return;

		logger.info({ count: allSeries.length }, '[LibraryScheduler] Updating series stats...');

		const importService = getImportService();
		for (const s of allSeries) {
			await importService.updateSeriesStats(s.id);
			// Yield between series to keep the event loop responsive.
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		logger.info('[LibraryScheduler] Series stats updated');
	}

	private formatFailedScanMessage(results: ScanResult[]): string {
		const labels = results.slice(0, 3).map((result) => {
			const detail = result.error || 'Unknown error';
			return `${result.rootFolderPath}: ${detail}`;
		});
		const suffix =
			results.length > labels.length ? ` (+${results.length - labels.length} more)` : '';
		return `Library scan failed for ${results.length} root folder${results.length === 1 ? '' : 's'}: ${labels.join('; ')}${suffix}`;
	}

	/**
	 * Get scheduler status
	 */
	async getStatus(): Promise<{
		initialized: boolean;
		scanning: boolean;
		currentScanId: string | null;
		lastScanTime: Date | null;
		nextScanTime: Date | null;
		scanIntervalHours: number;
		watcherStatus: { enabled: boolean; watchedFolders: string[] };
	}> {
		const intervalHours = await this.getScanIntervalHours();
		const lastScan = this.lastScanTime || (await this.getLastScanTime());

		let nextScanTime: Date | null = null;
		if (lastScan && this.scanInterval) {
			nextScanTime = new Date(lastScan.getTime() + intervalHours * 60 * 60 * 1000);
		}

		return {
			initialized: this.isInitialized,
			scanning: diskScanService.scanning,
			currentScanId: diskScanService.activeScanId,
			lastScanTime: lastScan,
			nextScanTime,
			scanIntervalHours: intervalHours,
			watcherStatus: libraryWatcherService.getStatus()
		};
	}

	/**
	 * Update scan interval (requires restart of periodic scans)
	 */
	async setScanInterval(hours: number): Promise<void> {
		if (hours < MIN_SCAN_INTERVAL_HOURS) {
			throw new Error(`Scan interval must be at least ${MIN_SCAN_INTERVAL_HOURS} hour(s)`);
		}

		await db
			.insert(librarySettings)
			.values({ key: 'scan_interval_hours', value: hours.toString() })
			.onConflictDoUpdate({
				target: librarySettings.key,
				set: { value: hours.toString() }
			});

		// Restart periodic scans with new interval
		await this.setupPeriodicScans();
	}

	/**
	 * Enable or disable filesystem watching
	 */
	async setWatchEnabled(enabled: boolean): Promise<void> {
		await db
			.insert(librarySettings)
			.values({ key: 'watch_enabled', value: enabled.toString() })
			.onConflictDoUpdate({
				target: librarySettings.key,
				set: { value: enabled.toString() }
			});

		// Apply change immediately
		if (enabled) {
			await libraryWatcherService.initialize();
		} else {
			await libraryWatcherService.shutdown();
		}
	}

	/**
	 * Set auto-match threshold
	 */
	async setMatchThreshold(threshold: number): Promise<void> {
		if (threshold < 0 || threshold > 1) {
			throw new Error('Match threshold must be between 0 and 1');
		}

		await db
			.insert(librarySettings)
			.values({ key: 'auto_match_threshold', value: threshold.toString() })
			.onConflictDoUpdate({
				target: librarySettings.key,
				set: { value: threshold.toString() }
			});
	}

	/**
	 * Enable or disable scan on startup
	 */
	async setScanOnStartup(enabled: boolean): Promise<void> {
		await db
			.insert(librarySettings)
			.values({ key: 'scan_on_startup', value: enabled.toString() })
			.onConflictDoUpdate({
				target: librarySettings.key,
				set: { value: enabled.toString() }
			});
	}
}

// Singleton getter - preferred way to access the service
export function getLibraryScheduler(): LibrarySchedulerService {
	return LibrarySchedulerService.getInstance();
}

// Reset singleton (for testing)
export async function resetLibraryScheduler(): Promise<void> {
	await LibrarySchedulerService.resetInstance();
}

// Backward-compatible export (prefer getLibraryScheduler())
export const librarySchedulerService = LibrarySchedulerService.getInstance();
