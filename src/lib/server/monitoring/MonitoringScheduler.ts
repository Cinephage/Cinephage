/**
 * Monitoring Scheduler Service
 *
 * Orchestrates all automated monitoring tasks including missing content search,
 * upgrade monitoring, new episode detection, and cutoff unmet searches.
 *
 * Follows Radarr/Sonarr patterns for scheduled task execution:
 * - Uses a single polling interval (30 seconds) to check which tasks are due
 * - Persists last-run times to database (survives restarts)
 * - Tasks only run when their scheduled interval has passed, never immediately on startup
 * - Provides grace period after startup before any automated tasks run
 */

import { db } from '#lib/server/db/index.js';
import { monitoringSettings } from '#lib/server/db/schema.js';
import { EventEmitter } from 'events';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'monitoring' as const });
import { taskHistoryService } from '#lib/server/tasks/TaskHistoryService.js';
import { taskSettingsService } from '#lib/server/tasks/TaskSettingsService.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';
import { TaskCancelledException } from '#lib/server/tasks/TaskCancelledException.js';
import type { BackgroundService, ServiceStatus } from '#lib/server/services/background-service.js';

/**
 * Default intervals in hours for each task type
 */
const DEFAULT_INTERVALS = {
	missing: 24,
	upgrade: 168, // Weekly
	newEpisode: 1, // Hourly
	cutoffUnmet: 24,
	pendingRelease: 0.25, // Every 15 minutes
	missingSubtitles: 6, // Every 6 hours
	subtitleUpgrade: 24, // Daily
	smartListRefresh: 1, // Hourly (checks which smart lists are due based on their individual intervals)
	historyCleanup: 24, // Daily
	libraryReconcile: 6, // Every 6 hours
	requestSweep: 1, // Hourly (request TTL expiry + availability re-check)
	dbBackup: 24, // Daily
	metadataRefresh: 24 // Daily
} as const;

/**
 * Minimum interval in hours (prevent overwhelming indexers)
 */
const MIN_INTERVAL_HOURS = 0.25; // 15 minutes

/**
 * Scheduler poll interval in milliseconds (how often to check for due tasks)
 * Following Sonarr pattern of 30 seconds
 */
const SCHEDULER_POLL_INTERVAL_MS = 30 * 1000;

/**
 * Grace period after startup before any automated tasks run (in milliseconds)
 * Allows the application to fully initialize before hammering indexers
 */
const DEFAULT_STARTUP_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

function getStartupGracePeriodMs(): number {
	const envValue = process.env.MONITORING_STARTUP_GRACE_MINUTES;
	if (!envValue) {
		return DEFAULT_STARTUP_GRACE_PERIOD_MS;
	}

	const parsed = Number(envValue);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return DEFAULT_STARTUP_GRACE_PERIOD_MS;
	}

	return Math.round(parsed * 60 * 1000);
}

const STARTUP_GRACE_PERIOD_MS = getStartupGracePeriodMs();

/**
 * When to trigger subtitle search during import
 */
export type SubtitleSearchTrigger = 'immediate' | 'after_metadata' | 'both';

/**
 * Monitoring settings interface
 */
export interface MonitoringSettings {
	missingSearchIntervalHours: number;
	upgradeSearchIntervalHours: number;
	newEpisodeCheckIntervalHours: number;
	cutoffUnmetSearchIntervalHours: number;
	autoReplaceEnabled: boolean;
	searchOnMonitorEnabled: boolean;
	// Subtitle monitoring settings
	missingSubtitlesIntervalHours: number;
	subtitleUpgradeIntervalHours: number;
	subtitleSearchOnImportEnabled: boolean;
	subtitleSearchTrigger: SubtitleSearchTrigger;
	// Download behavior
	stalledDownloadTimeoutMinutes: number;
	stalledDownloadProgressThreshold: number;
	// Blocklist duration (hours) for auto-removed stalled releases; 0 = permanent
	stalledDownloadBlocklistHours: number;
}

/**
 * Task execution result
 */
export interface TaskResult {
	taskType: string;
	itemsProcessed: number;
	itemsGrabbed: number;
	errors: number;
	executedAt: Date;
}

/**
 * Monitoring status response
 */
export interface MonitoringStatus {
	tasks: {
		missing: TaskStatus;
		upgrade: TaskStatus;
		newEpisode: TaskStatus;
		cutoffUnmet: TaskStatus;
		pendingRelease: TaskStatus;
		missingSubtitles: TaskStatus;
		subtitleUpgrade: TaskStatus;
		smartListRefresh: TaskStatus;
		historyCleanup: TaskStatus;
		'library-reconcile': TaskStatus;
		dbBackup: TaskStatus;
		'metadata-refresh': TaskStatus;
		'request-sweep': TaskStatus;
	};
}

interface TaskStatus {
	lastRunTime: Date | null;
	nextRunTime: Date | null;
	intervalHours: number;
	isRunning: boolean;
}

/**
 * MonitoringScheduler - Coordinate all monitoring tasks
 *
 * Uses a polling-based scheduler (like Sonarr) instead of individual timers:
 * - Single 30-second interval checks which tasks are due
 * - Persists last-run times to database
 * - Grace period after startup before running any automated tasks
 *
 * Implements BackgroundService for lifecycle management via ServiceManager.
 */
export class MonitoringScheduler extends EventEmitter implements BackgroundService {
	private static instance: MonitoringScheduler | null = null;

	readonly name = 'MonitoringScheduler';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;

	private schedulerTimer: NodeJS.Timeout | null = null;
	private lastRunTimes: Map<string, Date> = new Map();
	private taskIntervals: Map<string, number> = new Map(); // interval in hours
	private runningTasks: Set<string> = new Set();
	private isInitialized = false;
	private startupTime: Date | null = null;

	private constructor() {
		super();
	}

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	static getInstance(): MonitoringScheduler {
		if (!MonitoringScheduler.instance) {
			MonitoringScheduler.instance = new MonitoringScheduler();
		}
		return MonitoringScheduler.instance;
	}

	/** Reset the singleton instance (for testing) */
	static async resetInstance(): Promise<void> {
		if (MonitoringScheduler.instance) {
			await MonitoringScheduler.instance.stop();
			MonitoringScheduler.instance = null;
		}
	}

	/**
	 * Load last-run times from database
	 */
	private async loadLastRunTimes(): Promise<void> {
		const settings = await db.select().from(monitoringSettings);
		const settingsMap = new Map(settings.map((s) => [s.key, s.value]));

		const taskTypes = [
			'missing',
			'upgrade',
			'newEpisode',
			'cutoffUnmet',
			'pendingRelease',
			'missingSubtitles',
			'subtitleUpgrade',
			'smartListRefresh',
			'historyCleanup',
			'dbBackup',
			// Restore persisted last-run times for the registry-based tasks
			// too, or they re-run right after every restart.
			'library-reconcile',
			'metadata-refresh',
			'request-sweep'
		];
		for (const taskType of taskTypes) {
			// First try to load from task_settings (new system)
			const taskSettingsLastRun = await taskSettingsService.getLastRunTime(taskType);
			if (taskSettingsLastRun) {
				const date = new Date(taskSettingsLastRun);
				if (!isNaN(date.getTime())) {
					this.lastRunTimes.set(taskType, date);
					logger.debug(
						{
							taskType,
							lastRunTime: date.toISOString()
						},
						`[MonitoringScheduler] Loaded last run time for ${taskType} from task_settings`
					);
					continue;
				}
			}

			// Fall back to legacy monitoring_settings
			const key = `last_run_${taskType}`;
			const value = settingsMap.get(key);
			if (value) {
				const date = new Date(value);
				if (!isNaN(date.getTime())) {
					this.lastRunTimes.set(taskType, date);
					logger.debug(
						{
							taskType,
							lastRunTime: date.toISOString()
						},
						`[MonitoringScheduler] Loaded last run time for ${taskType} from monitoring_settings`
					);
				}
			}
		}
	}

	/**
	 * Save last-run time to database
	 */
	private async saveLastRunTime(taskType: string, time: Date): Promise<void> {
		const key = `last_run_${taskType}`;
		try {
			// Save to legacy monitoring_settings for backward compatibility
			await db
				.insert(monitoringSettings)
				.values({ key, value: time.toISOString() })
				.onConflictDoUpdate({ target: monitoringSettings.key, set: { value: time.toISOString() } });

			// Also update task_settings for new system
			await taskSettingsService.recordTaskRun(taskType);

			logger.debug(
				{
					taskType,
					key,
					time: time.toISOString()
				},
				`[MonitoringScheduler] Saved last run time for ${taskType}`
			);
		} catch (error) {
			logger.error(
				{
					err: error,
					taskType,
					key,
					time: time.toISOString()
				},
				`[MonitoringScheduler] Failed to save last run time for ${taskType}`
			);
			throw error;
		}
	}

	/**
	 * Get monitoring settings from database
	 */
	async getSettings(): Promise<MonitoringSettings> {
		const settings = await db.select().from(monitoringSettings);

		const settingsMap = new Map(settings.map((s) => [s.key, s.value]));

		return {
			missingSearchIntervalHours: parseFloat(
				settingsMap.get('missing_search_interval_hours') || String(DEFAULT_INTERVALS.missing)
			),
			upgradeSearchIntervalHours: parseFloat(
				settingsMap.get('upgrade_search_interval_hours') || String(DEFAULT_INTERVALS.upgrade)
			),
			newEpisodeCheckIntervalHours: parseFloat(
				settingsMap.get('new_episode_check_interval_hours') || String(DEFAULT_INTERVALS.newEpisode)
			),
			cutoffUnmetSearchIntervalHours: parseFloat(
				settingsMap.get('cutoff_unmet_search_interval_hours') ||
					String(DEFAULT_INTERVALS.cutoffUnmet)
			),
			autoReplaceEnabled: settingsMap.get('auto_replace_enabled') !== 'false',
			searchOnMonitorEnabled: settingsMap.get('search_on_monitor_enabled') !== 'false',
			// Subtitle settings
			missingSubtitlesIntervalHours: parseFloat(
				settingsMap.get('missing_subtitles_interval_hours') ||
					String(DEFAULT_INTERVALS.missingSubtitles)
			),
			subtitleUpgradeIntervalHours: parseFloat(
				settingsMap.get('subtitle_upgrade_interval_hours') ||
					String(DEFAULT_INTERVALS.subtitleUpgrade)
			),
			subtitleSearchOnImportEnabled:
				settingsMap.get('subtitle_search_on_import_enabled') !== 'false',
			subtitleSearchTrigger:
				(settingsMap.get('subtitle_search_trigger') as SubtitleSearchTrigger) || 'after_metadata',
			stalledDownloadTimeoutMinutes: parseFloat(
				settingsMap.get('stalled_download_timeout_minutes') || '60'
			),
			stalledDownloadProgressThreshold: parseFloat(
				settingsMap.get('stalled_download_progress_threshold') || '1'
			),
			stalledDownloadBlocklistHours: parseFloat(
				settingsMap.get('stalled_download_blocklist_hours') || '72'
			)
		};
	}

	/**
	 * Update monitoring settings
	 */
	async updateSettings(settings: Partial<MonitoringSettings>): Promise<void> {
		const updates: Array<{ key: string; value: string }> = [];

		if (settings.missingSearchIntervalHours !== undefined) {
			updates.push({
				key: 'missing_search_interval_hours',
				value: String(settings.missingSearchIntervalHours)
			});
		}
		if (settings.upgradeSearchIntervalHours !== undefined) {
			updates.push({
				key: 'upgrade_search_interval_hours',
				value: String(settings.upgradeSearchIntervalHours)
			});
		}
		if (settings.newEpisodeCheckIntervalHours !== undefined) {
			updates.push({
				key: 'new_episode_check_interval_hours',
				value: String(settings.newEpisodeCheckIntervalHours)
			});
		}
		if (settings.cutoffUnmetSearchIntervalHours !== undefined) {
			updates.push({
				key: 'cutoff_unmet_search_interval_hours',
				value: String(settings.cutoffUnmetSearchIntervalHours)
			});
		}
		if (settings.autoReplaceEnabled !== undefined) {
			updates.push({ key: 'auto_replace_enabled', value: String(settings.autoReplaceEnabled) });
		}
		if (settings.searchOnMonitorEnabled !== undefined) {
			updates.push({
				key: 'search_on_monitor_enabled',
				value: String(settings.searchOnMonitorEnabled)
			});
		}
		// Subtitle settings
		if (settings.missingSubtitlesIntervalHours !== undefined) {
			updates.push({
				key: 'missing_subtitles_interval_hours',
				value: String(settings.missingSubtitlesIntervalHours)
			});
		}
		if (settings.subtitleUpgradeIntervalHours !== undefined) {
			updates.push({
				key: 'subtitle_upgrade_interval_hours',
				value: String(settings.subtitleUpgradeIntervalHours)
			});
		}
		if (settings.subtitleSearchOnImportEnabled !== undefined) {
			updates.push({
				key: 'subtitle_search_on_import_enabled',
				value: String(settings.subtitleSearchOnImportEnabled)
			});
		}
		if (settings.subtitleSearchTrigger !== undefined) {
			updates.push({
				key: 'subtitle_search_trigger',
				value: settings.subtitleSearchTrigger
			});
		}
		if (settings.stalledDownloadTimeoutMinutes !== undefined) {
			updates.push({
				key: 'stalled_download_timeout_minutes',
				value: String(settings.stalledDownloadTimeoutMinutes)
			});
		}
		if (settings.stalledDownloadProgressThreshold !== undefined) {
			updates.push({
				key: 'stalled_download_progress_threshold',
				value: String(settings.stalledDownloadProgressThreshold)
			});
		}
		if (settings.stalledDownloadBlocklistHours !== undefined) {
			updates.push({
				key: 'stalled_download_blocklist_hours',
				value: String(settings.stalledDownloadBlocklistHours)
			});
		}

		// Insert or update each setting
		for (const { key, value } of updates) {
			await db
				.insert(monitoringSettings)
				.values({ key, value })
				.onConflictDoUpdate({ target: monitoringSettings.key, set: { value } });
		}

		// If intervals changed, restart scheduler
		if (Object.keys(settings).some((k) => k.includes('Interval'))) {
			await this.restart();
		}

		this.emit('settingsUpdated', settings);
	}

	/**
	 * Start the scheduler (non-blocking)
	 * Implements BackgroundService.start()
	 */
	start(): void {
		if (this.isInitialized || this._status === 'starting') {
			logger.debug('[MonitoringScheduler] Already initialized or starting');
			return;
		}

		this._status = 'starting';
		logger.info('[MonitoringScheduler] Starting...');

		// Run initialization in background
		setImmediate(() => {
			this.initialize()
				.then(() => {
					this._status = 'ready';
				})
				.catch((err) => {
					this._error = err instanceof Error ? err : new Error(String(err));
					this._status = 'error';
					logger.error({ err: this._error }, '[MonitoringScheduler] Failed to initialize');
				});
		});
	}

	/**
	 * Initialize the scheduler and start background tasks
	 *
	 * Uses a polling-based approach like Sonarr:
	 * - Load persisted last-run times from database
	 * - Store task intervals for reference
	 * - Start a single polling timer that checks all tasks every 30 seconds
	 * - Apply grace period before running any tasks after startup
	 */
	async initialize(): Promise<void> {
		if (this.isInitialized) {
			logger.debug('[MonitoringScheduler] Already initialized');
			return;
		}

		logger.info('[MonitoringScheduler] Initializing...');
		this.startupTime = new Date();

		// Load persisted last-run times from database
		await this.loadLastRunTimes();

		const settings = await this.getSettings();

		// Initialize default task settings if needed
		await taskSettingsService.initializeDefaults();

		// Store task intervals (validated) - check task_settings first, fall back to monitoring_settings
		const missingInterval =
			(await taskSettingsService.getTaskInterval('missing')) ?? settings.missingSearchIntervalHours;
		const upgradeInterval =
			(await taskSettingsService.getTaskInterval('upgrade')) ?? settings.upgradeSearchIntervalHours;
		const newEpisodeInterval =
			(await taskSettingsService.getTaskInterval('newEpisode')) ??
			settings.newEpisodeCheckIntervalHours;
		const cutoffUnmetInterval =
			(await taskSettingsService.getTaskInterval('cutoffUnmet')) ??
			settings.cutoffUnmetSearchIntervalHours;
		const pendingReleaseInterval =
			(await taskSettingsService.getTaskInterval('pendingRelease')) ??
			DEFAULT_INTERVALS.pendingRelease;
		const missingSubtitlesInterval =
			(await taskSettingsService.getTaskInterval('missingSubtitles')) ??
			settings.missingSubtitlesIntervalHours;
		const subtitleUpgradeInterval =
			(await taskSettingsService.getTaskInterval('subtitleUpgrade')) ??
			settings.subtitleUpgradeIntervalHours;
		const smartListRefreshInterval =
			(await taskSettingsService.getTaskInterval('smartListRefresh')) ??
			DEFAULT_INTERVALS.smartListRefresh;
		const historyCleanupInterval =
			(await taskSettingsService.getTaskInterval('historyCleanup')) ??
			DEFAULT_INTERVALS.historyCleanup;
		const libraryReconcileInterval =
			(await taskSettingsService.getTaskInterval('library-reconcile')) ??
			DEFAULT_INTERVALS.libraryReconcile;
		const dbBackupInterval =
			(await taskSettingsService.getTaskInterval('dbBackup')) ?? DEFAULT_INTERVALS.dbBackup;
		const requestSweepInterval =
			(await taskSettingsService.getTaskInterval('request-sweep')) ??
			DEFAULT_INTERVALS.requestSweep;
		const metadataRefreshInterval =
			(await taskSettingsService.getTaskInterval('metadata-refresh')) ??
			DEFAULT_INTERVALS.metadataRefresh;

		this.taskIntervals.set('missing', Math.max(missingInterval, MIN_INTERVAL_HOURS));
		this.taskIntervals.set('upgrade', Math.max(upgradeInterval, MIN_INTERVAL_HOURS));
		this.taskIntervals.set('newEpisode', Math.max(newEpisodeInterval, MIN_INTERVAL_HOURS));
		this.taskIntervals.set('cutoffUnmet', Math.max(cutoffUnmetInterval, MIN_INTERVAL_HOURS));
		this.taskIntervals.set('pendingRelease', Math.max(pendingReleaseInterval, MIN_INTERVAL_HOURS));
		this.taskIntervals.set(
			'missingSubtitles',
			Math.max(missingSubtitlesInterval, MIN_INTERVAL_HOURS)
		);
		this.taskIntervals.set(
			'subtitleUpgrade',
			Math.max(subtitleUpgradeInterval, MIN_INTERVAL_HOURS)
		);
		this.taskIntervals.set(
			'smartListRefresh',
			Math.max(smartListRefreshInterval, MIN_INTERVAL_HOURS)
		);
		this.taskIntervals.set('historyCleanup', Math.max(historyCleanupInterval, MIN_INTERVAL_HOURS));
		this.taskIntervals.set(
			'library-reconcile',
			Math.max(libraryReconcileInterval, MIN_INTERVAL_HOURS)
		);
		this.taskIntervals.set('dbBackup', Math.max(dbBackupInterval, MIN_INTERVAL_HOURS));
		this.taskIntervals.set('request-sweep', Math.max(requestSweepInterval, MIN_INTERVAL_HOURS));
		this.taskIntervals.set(
			'metadata-refresh',
			Math.max(metadataRefreshInterval, MIN_INTERVAL_HOURS)
		);

		// Log scheduled intervals
		for (const [taskType, intervalHours] of this.taskIntervals.entries()) {
			const lastRun = this.lastRunTimes.get(taskType);
			logger.info(
				{
					taskType,
					intervalHours,
					lastRunTime: lastRun?.toISOString() ?? 'never'
				},
				`[MonitoringScheduler] Task ${taskType} configured`
			);
		}

		// Start the polling scheduler (checks every 30 seconds which tasks are due)
		this.schedulerTimer = setInterval(() => {
			this.pollAndExecuteDueTasks().catch((error) => {
				logger.error({ err: error }, '[MonitoringScheduler] Error in scheduler poll');
			});
		}, SCHEDULER_POLL_INTERVAL_MS);

		this.isInitialized = true;
		this._status = 'ready';

		const gracePeriodMinutes = Math.round(STARTUP_GRACE_PERIOD_MS / 60000);
		logger.info(
			`[MonitoringScheduler] Initialized - tasks will start after ${gracePeriodMinutes} minute grace period`
		);
	}

	/**
	 * Poll for due tasks and execute them
	 * Called every 30 seconds by the scheduler timer
	 */
	private async pollAndExecuteDueTasks(): Promise<void> {
		// Check startup grace period
		if (this.startupTime) {
			const timeSinceStartup = Date.now() - this.startupTime.getTime();
			if (timeSinceStartup < STARTUP_GRACE_PERIOD_MS) {
				// Still in grace period, skip
				return;
			}
		}

		const now = new Date();

		// Copy taskIntervals to avoid race condition if settings updated during iteration
		const tasksToCheck = Array.from(this.taskIntervals.entries());

		for (const [taskType, intervalHours] of tasksToCheck) {
			// Skip if already running (atomic check before starting)
			if (this.runningTasks.has(taskType)) {
				continue;
			}

			// Check if task is enabled
			const isEnabled = await taskSettingsService.isTaskEnabled(taskType);
			if (!isEnabled) {
				logger.debug(`[MonitoringScheduler] Task ${taskType} is disabled, skipping`);
				continue;
			}

			const lastRunTime = this.lastRunTimes.get(taskType);
			const intervalMs = intervalHours * 60 * 60 * 1000;

			// Calculate if task is due
			let isDue: boolean;
			if (!lastRunTime) {
				// Never run before - run it (but we're past grace period)
				isDue = true;
				logger.debug(`[MonitoringScheduler] Task ${taskType} has never run, marking as due`);
			} else {
				const timeSinceLastRun = now.getTime() - lastRunTime.getTime();
				isDue = timeSinceLastRun >= intervalMs;

				if (isDue) {
					const hoursSince = (timeSinceLastRun / (1000 * 60 * 60)).toFixed(1);
					logger.debug(
						`[MonitoringScheduler] Task ${taskType} is due (${hoursSince}h since last run)`
					);
				}
			}

			if (isDue) {
				// Mark as running BEFORE firing to prevent race condition
				// The executeTask method will handle cleanup in finally block
				if (this.runningTasks.has(taskType)) {
					// Double-check in case another poll started it
					continue;
				}
				this.runningTasks.add(taskType);

				// Execute task in background (don't await to allow parallel execution)
				this.executeTaskInternal(taskType).catch((error) => {
					logger.error(`[MonitoringScheduler] Task ${taskType} failed`, error);
				});
			}
		}
	}

	/**
	 * Stop the scheduler
	 * Implements BackgroundService.stop()
	 */
	async stop(): Promise<void> {
		logger.info('[MonitoringScheduler] Stopping...');

		// Clear the polling timer
		if (this.schedulerTimer) {
			clearInterval(this.schedulerTimer);
			this.schedulerTimer = null;
		}

		// Remove all event listeners to prevent memory leaks
		this.removeAllListeners();

		this.isInitialized = false;
		this.startupTime = null;
		this._status = 'pending';
		logger.info('[MonitoringScheduler] Stopped');
	}

	/**
	 * Shutdown the scheduler (alias for stop, backward compatibility)
	 */
	async shutdown(): Promise<void> {
		return this.stop();
	}

	/**
	 * Restart the scheduler (re-initialize with new settings)
	 */
	private async restart(): Promise<void> {
		await this.shutdown();
		this.isInitialized = false;
		await this.initialize();
	}

	/**
	 * Execute a specific task type (internal - runningTasks already set by caller)
	 */
	private async executeTaskInternal(taskType: string): Promise<void> {
		// runningTasks is already set by pollAndExecuteDueTasks before calling this
		this.emit('taskStarted', taskType);

		logger.info({ taskType }, `[MonitoringScheduler] Executing ${taskType} task...`);

		// Create execution context (includes history tracking and cancellation support)
		let ctx: TaskExecutionContext | null = null;
		try {
			ctx = await taskHistoryService.createExecutionContext(taskType);
		} catch (historyError) {
			// Log but don't fail the task if history recording fails
			logger.warn(
				{
					taskType,
					err: historyError
				},
				`[MonitoringScheduler] Failed to create execution context for ${taskType}`
			);
		}

		try {
			// Pass context to task for cancellation support and per-item activity tracking
			const result = await this.runTask(taskType, ctx, 'automatic');
			const completionTime = new Date();

			// Record success in history
			if (ctx) {
				try {
					await taskHistoryService.completeTask(ctx.historyId, {
						itemsProcessed: result.itemsProcessed,
						itemsGrabbed: result.itemsGrabbed,
						errors: result.errors
					});
				} catch (historyError) {
					logger.warn(
						{
							taskType,
							historyId: ctx.historyId,
							err: historyError
						},
						`[MonitoringScheduler] Failed to complete history for ${taskType}`
					);
				}
			}

			// Persist to database FIRST, then update in-memory cache
			// This ensures consistency - if DB fails, we'll retry on next poll
			try {
				await this.saveLastRunTime(taskType, completionTime);
				// Only update in-memory cache after successful DB write
				this.lastRunTimes.set(taskType, completionTime);
			} catch (dbError) {
				logger.error(
					{ err: dbError, taskType },
					`[MonitoringScheduler] Failed to persist last run time for ${taskType}`
				);
				// Still emit completion but don't update in-memory cache
				// This way task will be retried on next poll
			}

			this.emit('taskCompleted', taskType, result);
			logger.info(
				{
					taskType,
					itemsGrabbed: result.itemsGrabbed,
					itemsProcessed: result.itemsProcessed
				},
				`[MonitoringScheduler] ${taskType} task completed`
			);
		} catch (error) {
			// Handle cancellation separately - don't treat as failure
			if (TaskCancelledException.isTaskCancelled(error)) {
				logger.info({ taskType }, `[MonitoringScheduler] ${taskType} task was cancelled`);
				this.emit('taskCancelled', taskType);
				// History is already marked as cancelled by cancelTask()
				return;
			}

			// Record failure in history
			if (ctx) {
				try {
					const errorMessage = error instanceof Error ? error.message : String(error);
					await taskHistoryService.failTask(ctx.historyId, [errorMessage]);
				} catch (historyError) {
					logger.warn(
						{
							taskType,
							historyId: ctx.historyId,
							err: historyError
						},
						`[MonitoringScheduler] Failed to record failure history for ${taskType}`
					);
				}
			}

			logger.error({ err: error, taskType }, `[MonitoringScheduler] ${taskType} task failed`);
			this.emit('taskFailed', taskType, error);
		} finally {
			this.runningTasks.delete(taskType);
		}
	}

	/**
	 * Run a specific task
	 * @param taskType - The type of task to run
	 * @param ctx - Optional execution context for cancellation support and activity tracking
	 */
	private async runTask(
		taskType: string,
		ctx: TaskExecutionContext | null,
		executionMode: 'automatic' | 'manual' = 'automatic'
	): Promise<TaskResult> {
		const settings = await this.getSettings();

		switch (taskType) {
			case 'missing': {
				const { executeMissingContentTask } = await import('./tasks/MissingContentTask.js');
				return await executeMissingContentTask(ctx, {
					ignoreCooldown: executionMode === 'manual',
					cooldownHours: settings.missingSearchIntervalHours
				});
			}
			case 'upgrade': {
				const { executeUpgradeMonitorTask } = await import('./tasks/UpgradeMonitorTask.js');
				return await executeUpgradeMonitorTask(ctx, {
					ignoreCooldown: executionMode === 'manual',
					cooldownHours: settings.upgradeSearchIntervalHours
				});
			}
			case 'newEpisode': {
				const { executeNewEpisodeMonitorTask } = await import('./tasks/NewEpisodeMonitorTask.js');
				return await executeNewEpisodeMonitorTask(settings.newEpisodeCheckIntervalHours, ctx);
			}
			case 'cutoffUnmet': {
				const { executeCutoffUnmetTask } = await import('./tasks/CutoffUnmetTask.js');
				return await executeCutoffUnmetTask(ctx, {
					ignoreCooldown: executionMode === 'manual',
					cooldownHours: settings.cutoffUnmetSearchIntervalHours
				});
			}
			case 'pendingRelease': {
				const { executePendingReleaseTask } = await import('./tasks/PendingReleaseTask.js');
				return await executePendingReleaseTask(ctx);
			}
			case 'missingSubtitles': {
				const { executeMissingSubtitlesTask } = await import('./tasks/MissingSubtitlesTask.js');
				return await executeMissingSubtitlesTask(ctx);
			}
			case 'subtitleUpgrade': {
				const { executeSubtitleUpgradeTask } = await import('./tasks/SubtitleUpgradeTask.js');
				return await executeSubtitleUpgradeTask(ctx);
			}
			case 'smartListRefresh': {
				const { executeSmartListRefreshTask } = await import('./tasks/SmartListRefreshTask.js');
				return await executeSmartListRefreshTask(ctx);
			}
			case 'historyCleanup': {
				const { executeHistoryCleanupTask } = await import('./tasks/HistoryCleanupTask.js');
				return await executeHistoryCleanupTask(ctx);
			}
			case 'dbBackup': {
				const { executeDbBackupTask } = await import('./tasks/DbBackupTask.js');
				return await executeDbBackupTask(ctx);
			}
			case 'library-reconcile': {
				const { executeLibraryReconcileTask } = await import('./tasks/LibraryReconcileTask.js');
				return await executeLibraryReconcileTask(ctx);
			}
			case 'metadata-refresh': {
				const { executeMetadataRefreshTask } = await import('./tasks/MetadataRefreshTask.js');
				return await executeMetadataRefreshTask(ctx);
			}
			case 'request-sweep': {
				const { executeRequestSweepTask } = await import('./tasks/RequestSweepTask.js');
				return await executeRequestSweepTask(ctx);
			}
			case 'original-language-backfill': {
				const { executeOriginalLanguageBackfillTask } =
					await import('./tasks/OriginalLanguageBackfillTask.js');
				return await executeOriginalLanguageBackfillTask(ctx);
			}
			default:
				throw new Error(`Unknown task type: ${taskType}`);
		}
	}

	/**
	 * Manually trigger a specific task
	 */
	async runMissingContentSearch(): Promise<TaskResult> {
		return await this.executeTaskManually('missing');
	}

	async runUpgradeSearch(): Promise<TaskResult> {
		return await this.executeTaskManually('upgrade');
	}

	async runNewEpisodeCheck(): Promise<TaskResult> {
		return await this.executeTaskManually('newEpisode');
	}

	async runCutoffUnmetSearch(): Promise<TaskResult> {
		return await this.executeTaskManually('cutoffUnmet');
	}

	async runPendingReleaseProcessing(): Promise<TaskResult> {
		return await this.executeTaskManually('pendingRelease');
	}

	async runMissingSubtitlesSearch(): Promise<TaskResult> {
		return await this.executeTaskManually('missingSubtitles');
	}

	async runSubtitleUpgradeSearch(): Promise<TaskResult> {
		return await this.executeTaskManually('subtitleUpgrade');
	}

	async runSmartListRefresh(): Promise<TaskResult> {
		return await this.executeTaskManually('smartListRefresh');
	}

	async runHistoryCleanup(): Promise<TaskResult> {
		return await this.executeTaskManually('historyCleanup');
	}

	async runDbBackup(): Promise<TaskResult> {
		return await this.executeTaskManually('dbBackup');
	}

	async runLibraryReconcile(): Promise<TaskResult> {
		return await this.executeTaskManually('library-reconcile');
	}

	async runMetadataRefresh(): Promise<TaskResult> {
		return await this.executeTaskManually('metadata-refresh');
	}

	async runRequestSweep(): Promise<TaskResult> {
		return await this.executeTaskManually('request-sweep');
	}

	async runOriginalLanguageBackfill(): Promise<TaskResult> {
		return await this.executeTaskManually('original-language-backfill');
	}

	private async executeTaskManually(taskType: string): Promise<TaskResult> {
		// Check if task is already running (either automatic or manual)
		if (this.runningTasks.has(taskType)) {
			logger.warn(
				{
					taskType
				},
				`[MonitoringScheduler] Cannot manually run ${taskType} - already running`
			);
			throw new Error(`Task ${taskType} is already running`);
		}

		// Mark as running to prevent concurrent execution
		this.runningTasks.add(taskType);

		logger.info({ taskType }, `[MonitoringScheduler] Manually executing ${taskType} task...`);
		this.emit('manualTaskStarted', taskType);

		// Create execution context (includes history tracking and cancellation support)
		let ctx: TaskExecutionContext | null = null;
		try {
			ctx = await taskHistoryService.createExecutionContext(taskType);
		} catch (historyError) {
			// Log but don't fail the task if history recording fails
			logger.warn(
				{
					taskType,
					err: historyError
				},
				`[MonitoringScheduler] Failed to create execution context for manual ${taskType}`
			);
		}

		try {
			// Pass context to task for cancellation support and per-item activity tracking
			const result = await this.runTask(taskType, ctx, 'manual');
			const completionTime = new Date();

			// Record success in history
			if (ctx) {
				try {
					await taskHistoryService.completeTask(ctx.historyId, {
						itemsProcessed: result.itemsProcessed,
						itemsGrabbed: result.itemsGrabbed,
						errors: result.errors
					});
				} catch (historyError) {
					logger.warn(
						{
							taskType,
							historyId: ctx.historyId,
							err: historyError
						},
						`[MonitoringScheduler] Failed to complete history for manual ${taskType}`
					);
				}
			}

			// Persist to database FIRST, then update in-memory cache (same as automatic execution)
			try {
				await this.saveLastRunTime(taskType, completionTime);
				this.lastRunTimes.set(taskType, completionTime);
			} catch (dbError) {
				logger.error(
					{ err: dbError, taskType },
					`[MonitoringScheduler] Failed to persist last run time for manual ${taskType}`
				);
				// Still continue - the task completed successfully
			}

			this.emit('manualTaskCompleted', taskType, result);
			return result;
		} catch (error) {
			// Handle cancellation separately - don't treat as failure
			if (TaskCancelledException.isTaskCancelled(error)) {
				logger.info({ taskType }, `[MonitoringScheduler] Manual ${taskType} task was cancelled`);
				this.emit('manualTaskCancelled', taskType);
				// History is already marked as cancelled by cancelTask()
				throw error; // Re-throw so caller knows it was cancelled
			}

			// Record failure in history
			if (ctx) {
				try {
					const errorMessage = error instanceof Error ? error.message : String(error);
					await taskHistoryService.failTask(ctx.historyId, [errorMessage]);
				} catch (historyError) {
					logger.warn(
						{
							taskType,
							historyId: ctx.historyId,
							err: historyError
						},
						`[MonitoringScheduler] Failed to record failure history for manual ${taskType}`
					);
				}
			}

			logger.error(
				{ err: error, taskType },
				`[MonitoringScheduler] Manual ${taskType} task failed`
			);
			this.emit('manualTaskFailed', taskType, error);
			throw error;
		} finally {
			// Always clean up running state
			this.runningTasks.delete(taskType);
		}
	}

	/**
	 * Get current monitoring status
	 */
	async getStatus(): Promise<MonitoringStatus> {
		const settings = await this.getSettings();

		// Get intervals from task_settings, fall back to monitoring_settings, then defaults
		const getTaskInterval = async (taskType: string, defaultInterval: number): Promise<number> => {
			const taskInterval = await taskSettingsService.getTaskInterval(taskType);
			if (taskInterval !== null) {
				return taskInterval;
			}
			// Fall back to in-memory interval
			return this.taskIntervals.get(taskType) ?? defaultInterval;
		};

		const getTaskStatus = async (
			taskType: string,
			defaultInterval: number
		): Promise<TaskStatus> => {
			const intervalHours = await getTaskInterval(taskType, defaultInterval);
			const lastRunTime = this.lastRunTimes.get(taskType) || null;
			const nextRunTime = lastRunTime
				? new Date(lastRunTime.getTime() + intervalHours * 60 * 60 * 1000)
				: null;

			return {
				lastRunTime,
				nextRunTime,
				intervalHours,
				isRunning: this.runningTasks.has(taskType)
			};
		};

		return {
			tasks: {
				missing: await getTaskStatus('missing', settings.missingSearchIntervalHours),
				upgrade: await getTaskStatus('upgrade', settings.upgradeSearchIntervalHours),
				newEpisode: await getTaskStatus('newEpisode', settings.newEpisodeCheckIntervalHours),
				cutoffUnmet: await getTaskStatus('cutoffUnmet', settings.cutoffUnmetSearchIntervalHours),
				pendingRelease: await getTaskStatus('pendingRelease', DEFAULT_INTERVALS.pendingRelease),
				missingSubtitles: await getTaskStatus(
					'missingSubtitles',
					settings.missingSubtitlesIntervalHours
				),
				subtitleUpgrade: await getTaskStatus(
					'subtitleUpgrade',
					settings.subtitleUpgradeIntervalHours
				),
				smartListRefresh: await getTaskStatus(
					'smartListRefresh',
					DEFAULT_INTERVALS.smartListRefresh
				),
				historyCleanup: await getTaskStatus('historyCleanup', DEFAULT_INTERVALS.historyCleanup),
				'library-reconcile': await getTaskStatus(
					'library-reconcile',
					DEFAULT_INTERVALS.libraryReconcile
				),
				dbBackup: await getTaskStatus('dbBackup', DEFAULT_INTERVALS.dbBackup),
				'metadata-refresh': await getTaskStatus(
					'metadata-refresh',
					DEFAULT_INTERVALS.metadataRefresh
				),
				'request-sweep': await getTaskStatus('request-sweep', DEFAULT_INTERVALS.requestSweep)
			}
		};
	}
}

// Singleton getter - preferred way to access the service
export function getMonitoringScheduler(): MonitoringScheduler {
	return MonitoringScheduler.getInstance();
}

// Reset singleton (for testing)
export async function resetMonitoringScheduler(): Promise<void> {
	await MonitoringScheduler.resetInstance();
}

// Backward-compatible export (prefer getMonitoringScheduler())
export const monitoringScheduler = MonitoringScheduler.getInstance();
