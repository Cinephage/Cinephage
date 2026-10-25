/**
 * EPG Scheduler Service
 *
 * Manages automatic EPG sync and cleanup on a schedule.
 * Follows BackgroundService pattern for lifecycle management.
 */

import { EventEmitter } from 'events';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'EpgScheduler' });
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import type { BackgroundService, ServiceStatus } from '#lib/server/services/background-service.js';
import { getEpgService } from './EpgService';
import { getEpgSyncState } from './EpgSyncState';
import { liveTvEvents } from '../LiveTvEvents';

/**
 * Default settings
 */
const DEFAULT_SYNC_INTERVAL_HOURS = 6;
const DEFAULT_CLEANUP_INTERVAL_HOURS = 1;
const DEFAULT_RETENTION_HOURS = 48;

/**
 * Scheduler poll interval in milliseconds
 */
const SCHEDULER_POLL_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * Grace period after startup before any automated tasks run (in milliseconds)
 * Reduced to 30 seconds to allow EPG data to appear sooner for users.
 * Can be overridden via EPG_STARTUP_GRACE_MS environment variable.
 */
const STARTUP_GRACE_PERIOD_MS = parseInt(process.env.EPG_STARTUP_GRACE_MS || '30000', 10); // Default 30 seconds

/**
 * Settings keys
 */
const SETTINGS_KEYS = {
	lastSyncAt: 'epg_last_sync_at',
	lastCleanupAt: 'epg_last_cleanup_at',
	syncIntervalHours: 'epg_sync_interval_hours',
	retentionHours: 'epg_retention_hours'
};

export class EpgScheduler extends EventEmitter implements BackgroundService {
	private static instance: EpgScheduler | null = null;

	readonly name = 'EpgScheduler';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;

	private schedulerTimer: NodeJS.Timeout | null = null;
	private isInitialized = false;
	private startupTime: Date | null = null;
	private isSyncing = false;
	private isCleaningUp = false;

	private constructor() {
		super();
	}

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	static getInstance(): EpgScheduler {
		if (!EpgScheduler.instance) {
			EpgScheduler.instance = new EpgScheduler();
		}
		return EpgScheduler.instance;
	}

	/**
	 * Start the scheduler (non-blocking)
	 */
	start(): void {
		if (this.isInitialized) {
			logger.warn('Already initialized');
			return;
		}

		this._status = 'starting';
		setImmediate(() => this.initialize());
	}

	/**
	 * Stop the scheduler
	 */
	async stop(): Promise<void> {
		logger.info('Stopping');

		if (this.schedulerTimer) {
			clearInterval(this.schedulerTimer);
			this.schedulerTimer = null;
		}

		this.isInitialized = false;
		this._status = 'pending';
	}

	/**
	 * Initialize the scheduler
	 */
	private initialize(): void {
		try {
			this.startupTime = new Date();

			logger.info(
				{
					pollInterval: SCHEDULER_POLL_INTERVAL_MS,
					graceMinutes: STARTUP_GRACE_PERIOD_MS / 60000
				},
				'Starting'
			);

			// Start the polling timer
			this.schedulerTimer = setInterval(() => this.checkDueTasks(), SCHEDULER_POLL_INTERVAL_MS);

			this.isInitialized = true;
			this._status = 'ready';

			logger.info('Ready');
			this.emit('ready');
		} catch (error) {
			this._error = error instanceof Error ? error : new Error(String(error));
			this._status = 'error';
			logger.error({ err: this._error }, 'Failed to initialize');
		}
	}

	/**
	 * Check for due tasks and execute them
	 */
	private async checkDueTasks(): Promise<void> {
		// Check if we're still in grace period
		const inGracePeriod =
			this.startupTime && Date.now() - this.startupTime.getTime() < STARTUP_GRACE_PERIOD_MS;

		// Allow first-ever sync even during grace period (for better first-run experience)
		const neverSynced = !this.getSetting(SETTINGS_KEYS.lastSyncAt);

		if (inGracePeriod && !neverSynced) {
			return;
		}

		// Check sync task
		if (!this.isSyncing && this.isSyncDue()) {
			this.runSync();
		}

		// Check cleanup task (only after grace period)
		if (!inGracePeriod && !this.isCleaningUp && this.isCleanupDue()) {
			this.runCleanup();
		}
	}

	/**
	 * Check if EPG sync is due
	 */
	private isSyncDue(): boolean {
		const lastSyncAt = this.getSetting(SETTINGS_KEYS.lastSyncAt);
		if (!lastSyncAt) {
			return true; // Never synced
		}

		const intervalHours = this.getIntervalHours();
		const lastSync = new Date(lastSyncAt);
		const nextSync = new Date(lastSync.getTime() + intervalHours * 60 * 60 * 1000);

		return new Date() >= nextSync;
	}

	/**
	 * Check if cleanup is due
	 */
	private isCleanupDue(): boolean {
		const lastCleanupAt = this.getSetting(SETTINGS_KEYS.lastCleanupAt);
		if (!lastCleanupAt) {
			return true; // Never cleaned up
		}

		const lastCleanup = new Date(lastCleanupAt);
		const nextCleanup = new Date(
			lastCleanup.getTime() + DEFAULT_CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000
		);

		return new Date() >= nextCleanup;
	}

	/**
	 * Run EPG sync
	 */
	private async runSync(): Promise<void> {
		this.isSyncing = true;
		const syncState = getEpgSyncState();
		let syncStateStarted = false;

		try {
			if (!syncState.tryStartAll()) {
				logger.info('Skipping scheduled EPG sync because another sync is already running');
				return;
			}
			syncStateStarted = true;
			logger.info('Starting scheduled EPG sync');
			liveTvEvents.emitEpgSyncStarted();

			const epgService = getEpgService();
			const results = await epgService.syncAll({
				shouldCancelAll: () => syncState.isCancelRequestedAll(),
				shouldCancelAccount: (accountId) => syncState.isCancelRequestedForAccount(accountId)
			});

			const successful = results.filter((r) => r.success).length;
			const totalAdded = results.reduce((sum, r) => sum + r.programsAdded, 0);
			const totalUpdated = results.reduce((sum, r) => sum + r.programsUpdated, 0);

			// Update last sync time
			this.setSetting(SETTINGS_KEYS.lastSyncAt, new Date().toISOString());

			logger.info(
				{
					accounts: results.length,
					successful,
					totalAdded,
					totalUpdated
				},
				'Scheduled EPG sync complete'
			);
			liveTvEvents.emitEpgSyncCompleted();

			this.emit('sync-complete', { results });
		} catch (error) {
			liveTvEvents.emitEpgSyncFailed(
				undefined,
				error instanceof Error ? error.message : 'Unknown error'
			);
			logger.error(
				{
					error: error instanceof Error ? error.message : 'Unknown error'
				},
				'Scheduled EPG sync failed'
			);
		} finally {
			this.isSyncing = false;
			if (syncStateStarted) {
				syncState.finishAll();
			}
		}
	}

	/**
	 * Run cleanup
	 */
	private async runCleanup(): Promise<void> {
		this.isCleaningUp = true;

		try {
			const epgService = getEpgService();
			const retentionHours = this.getRetentionHours();
			const deleted = epgService.cleanup(retentionHours);

			// Update last cleanup time
			this.setSetting(SETTINGS_KEYS.lastCleanupAt, new Date().toISOString());

			if (deleted > 0) {
				logger.info({ deleted }, 'EPG cleanup complete');
			}
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : 'Unknown error'
				},
				'EPG cleanup failed'
			);
		} finally {
			this.isCleaningUp = false;
		}
	}

	/**
	 * Get sync interval in hours
	 */
	private getIntervalHours(): number {
		const value = this.getSetting(SETTINGS_KEYS.syncIntervalHours);
		return value ? parseInt(value, 10) : DEFAULT_SYNC_INTERVAL_HOURS;
	}

	/**
	 * Get retention period in hours
	 */
	private getRetentionHours(): number {
		const value = this.getSetting(SETTINGS_KEYS.retentionHours);
		return value ? parseInt(value, 10) : DEFAULT_RETENTION_HOURS;
	}

	/**
	 * Get a setting from the database
	 */
	private getSetting(key: string): string | null {
		try {
			const result = db.select().from(settings).where(eq(settings.key, key)).get();
			return result?.value ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Set a setting in the database
	 */
	private setSetting(key: string, value: string): void {
		try {
			db.insert(settings)
				.values({ key, value })
				.onConflictDoUpdate({
					target: settings.key,
					set: { value }
				})
				.run();
		} catch (error) {
			logger.error({ key, error }, 'Failed to set setting');
		}
	}

	/**
	 * Get scheduler status
	 */
	getStatus(): {
		isReady: boolean;
		isSyncing: boolean;
		isCleaningUp: boolean;
		lastSyncAt: string | null;
		nextSyncAt: string | null;
		syncIntervalHours: number;
		retentionHours: number;
	} {
		const lastSyncAt = this.getSetting(SETTINGS_KEYS.lastSyncAt);
		const intervalHours = this.getIntervalHours();

		let nextSyncAt: string | null = null;
		if (lastSyncAt) {
			const lastSync = new Date(lastSyncAt);
			const nextSync = new Date(lastSync.getTime() + intervalHours * 60 * 60 * 1000);
			nextSyncAt = nextSync.toISOString();
		}

		return {
			isReady: this._status === 'ready',
			isSyncing: this.isSyncing,
			isCleaningUp: this.isCleaningUp,
			lastSyncAt,
			nextSyncAt,
			syncIntervalHours: intervalHours,
			retentionHours: this.getRetentionHours()
		};
	}

	/**
	 * Trigger immediate sync (for manual trigger)
	 */
	async triggerSync(): Promise<void> {
		if (this.isSyncing) {
			logger.warn('Sync already in progress');
			return;
		}
		await this.runSync();
	}
}

// Export singleton getter
export function getEpgScheduler(): EpgScheduler {
	return EpgScheduler.getInstance();
}
