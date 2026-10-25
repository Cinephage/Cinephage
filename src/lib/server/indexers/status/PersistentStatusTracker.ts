/**
 * Persistent Indexer Status Tracker.
 *
 * Stores indexer health, failures, and backoff state in the database
 * to survive restarts. Uses an in-memory cache for performance with
 * periodic persistence to SQLite.
 */

import { eq, inArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { indexerStatus, indexers } from '#lib/server/db/schema.js';
import {
	type IndexerStatus,
	type FailureRecord,
	type StatusTrackerConfig,
	type HealthStatus,
	DEFAULT_STATUS_CONFIG,
	createDefaultStatus,
	nextUtcMidnight
} from './types';
import { BackoffCalculator } from './BackoffCalculator';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });

/** Database row type */
type IndexerStatusRow = typeof indexerStatus.$inferSelect;

/** Interval for persisting dirty entries to database */
const PERSIST_INTERVAL_MS = 5_000; // 5 seconds

/**
 * Persistent status tracker with database backing.
 *
 * Uses a write-through cache:
 * - Reads: Check memory cache first, then database
 * - Writes: Update memory immediately, queue for database persist
 */
export class PersistentStatusTracker {
	private cache: Map<string, IndexerStatus> = new Map();
	private responseTimes: Map<string, number[]> = new Map();
	private dirty: Set<string> = new Set();
	private backoffCalculator: BackoffCalculator;
	private persistInterval: ReturnType<typeof setInterval> | null = null;
	private initialized = false;

	constructor(private config: StatusTrackerConfig = DEFAULT_STATUS_CONFIG) {
		this.backoffCalculator = new BackoffCalculator(
			config.baseBackoffMs,
			config.maxBackoffMs,
			config.backoffMultiplier
		);
	}

	/**
	 * Initialize the tracker and load existing status from database.
	 */
	async init(): Promise<void> {
		if (this.initialized) return;

		try {
			// Load all status records from database
			const rows = await db.select().from(indexerStatus);

			for (const row of rows) {
				this.cache.set(row.indexerId, this.rowToStatus(row));
			}

			logger.info({ count: rows.length }, 'Loaded indexer status from database');
		} catch (error) {
			logger.warn({ err: error }, 'Failed to load indexer status from database, starting fresh');
		}

		// Start periodic persist
		this.persistInterval = setInterval(() => {
			this.persistDirty().catch((err) => {
				logger.error({ err }, 'Failed to persist indexer status');
			});
		}, PERSIST_INTERVAL_MS);

		this.initialized = true;

		// Cleanup orphaned status entries in the background
		this.cleanupOrphanedEntries().catch((err) => {
			logger.debug({ err }, 'Failed to cleanup orphaned status entries');
		});
	}

	/**
	 * Remove status entries for indexers that no longer exist in the database.
	 * This handles cleanup of test indexers or deleted indexers.
	 */
	async cleanupOrphanedEntries(): Promise<void> {
		try {
			// Get all valid indexer IDs from the indexers table
			const validIndexers = await db.select({ id: indexers.id }).from(indexers);
			const validIds = new Set(validIndexers.map((i) => i.id));

			// Find orphaned entries in cache
			const orphanedIds: string[] = [];
			for (const indexerId of this.cache.keys()) {
				if (!validIds.has(indexerId)) {
					orphanedIds.push(indexerId);
				}
			}

			if (orphanedIds.length === 0) return;

			logger.info(
				{
					count: orphanedIds.length,
					ids: orphanedIds
				},
				'Cleaning up orphaned indexer status entries'
			);

			// Remove from cache
			for (const id of orphanedIds) {
				this.cache.delete(id);
				this.responseTimes.delete(id);
				this.dirty.delete(id);
			}

			// Try to delete from database (may fail if FK already cleaned them up)
			try {
				await db.delete(indexerStatus).where(inArray(indexerStatus.indexerId, orphanedIds));
			} catch {
				// Ignore errors - entries may already be gone
			}
		} catch (error) {
			logger.debug({ err: error }, 'Error during orphaned status cleanup');
		}
	}

	/**
	 * Shutdown: persist all dirty entries and stop interval.
	 */
	async shutdown(): Promise<void> {
		if (this.persistInterval) {
			clearInterval(this.persistInterval);
			this.persistInterval = null;
		}

		await this.persistDirty();
		this.initialized = false;
	}

	/**
	 * Initialize status for an indexer.
	 */
	async initialize(indexerId: string, enabled: boolean, priority: number = 25): Promise<void> {
		await this.ensureInitialized();

		if (!this.cache.has(indexerId)) {
			const status = createDefaultStatus(indexerId, enabled, priority);
			this.cache.set(indexerId, status);
			this.markDirty(indexerId);
		}
	}

	/**
	 * Get current status for an indexer.
	 */
	async getStatus(indexerId: string): Promise<IndexerStatus> {
		await this.ensureInitialized();

		const cached = this.cache.get(indexerId);
		if (cached) return cached;

		// Try loading from database
		try {
			const [row] = await db
				.select()
				.from(indexerStatus)
				.where(eq(indexerStatus.indexerId, indexerId));

			if (row) {
				const status = this.rowToStatus(row);
				this.cache.set(indexerId, status);
				return status;
			}
		} catch (error) {
			logger.debug({ indexerId, err: error }, 'Failed to load status from database');
		}

		// Create default
		const status = createDefaultStatus(indexerId);
		this.cache.set(indexerId, status);
		return status;
	}

	/**
	 * Get status synchronously (from cache only).
	 */
	getStatusSync(indexerId: string): IndexerStatus {
		return this.cache.get(indexerId) ?? createDefaultStatus(indexerId);
	}

	/**
	 * Get all statuses.
	 */
	async getAllStatuses(): Promise<IndexerStatus[]> {
		await this.ensureInitialized();
		return Array.from(this.cache.values());
	}

	/**
	 * Record a successful request.
	 */
	async recordSuccess(indexerId: string, responseTimeMs?: number): Promise<void> {
		const status = await this.getOrCreateStatus(indexerId);
		const previousFailures = status.consecutiveFailures;

		status.totalRequests++;
		status.lastSuccess = new Date();

		// Re-enable if it was auto-disabled
		if (status.isDisabled) {
			status.isDisabled = false;
			status.disabledAt = undefined;
			status.disabledUntil = undefined;
			status.disabledReason = undefined;
			logger.info({ indexerId }, 'Indexer re-enabled after success');
		}

		// Recover gradually instead of instantly flipping healthy after one success.
		// This avoids masking intermittent/recent connectivity issues.
		status.consecutiveFailures = previousFailures > 0 ? Math.max(0, previousFailures - 1) : 0;
		status.health = this.calculateHealth(status);

		// Track response time
		if (responseTimeMs !== undefined) {
			this.trackResponseTime(indexerId, responseTimeMs);
			status.avgResponseTime = this.calculateAvgResponseTime(indexerId);
		}

		this.markDirty(indexerId);
	}

	/**
	 * Record a failed request.
	 */
	async recordFailure(indexerId: string, message: string, requestUrl?: string): Promise<void> {
		const status = await this.getOrCreateStatus(indexerId);
		const now = new Date();

		status.totalRequests++;
		status.totalFailures++;
		const lastFailureAt = status.lastFailure?.getTime();
		const shouldIncrementConsecutive =
			!lastFailureAt || now.getTime() - lastFailureAt >= this.config.minFailureIncrementIntervalMs;
		if (shouldIncrementConsecutive) {
			status.consecutiveFailures++;
		}
		status.lastFailure = now;

		// Add to recent failures
		const failure: FailureRecord = {
			timestamp: new Date(),
			message,
			requestUrl
		};
		status.recentFailures.unshift(failure);
		if (status.recentFailures.length > this.config.maxRecentFailures) {
			status.recentFailures.pop();
		}

		// Check if should auto-disable
		if (status.consecutiveFailures >= this.config.failuresBeforeDisable) {
			this.disableIndexer(status);
		}

		status.health = this.calculateHealth(status);
		this.markDirty(indexerId);
	}

	/**
	 * Record a request rejected by the indexer's own API quota (daily/hourly
	 * request limit, rate limit, etc). Unlike recordFailure, this disables the
	 * indexer immediately and for a much longer window (until the next UTC
	 * day boundary, a reasonable default reset point) than the generic failure backoff,
	 * which would otherwise keep re-hitting the same exhausted quota within a minute.
	 */
	async recordQuotaExceeded(
		indexerId: string,
		message: string,
		requestUrl?: string
	): Promise<void> {
		const status = await this.getOrCreateStatus(indexerId);
		const now = new Date();

		status.totalRequests++;
		status.totalFailures++;
		status.lastFailure = now;

		const failure: FailureRecord = { timestamp: now, message, requestUrl };
		status.recentFailures.unshift(failure);
		if (status.recentFailures.length > this.config.maxRecentFailures) {
			status.recentFailures.pop();
		}

		status.isDisabled = true;
		status.disabledAt = now;
		status.disabledUntil = nextUtcMidnight(now);
		status.disabledReason = 'quota_exceeded';
		status.health = 'disabled';

		logger.warn(
			{
				indexerId,
				message,
				disabledUntil: status.disabledUntil.toISOString()
			},
			'Indexer auto-disabled: API quota exceeded'
		);

		this.markDirty(indexerId);
	}

	/**
	 * Manually enable an indexer.
	 */
	async enable(indexerId: string): Promise<void> {
		const status = await this.getOrCreateStatus(indexerId);
		status.isEnabled = true;
		status.isDisabled = false;
		status.disabledAt = undefined;
		status.disabledUntil = undefined;
		status.disabledReason = undefined;
		status.consecutiveFailures = 0;
		status.health = this.calculateHealth(status);
		this.markDirty(indexerId);
	}

	/**
	 * Manually disable an indexer.
	 */
	async disable(indexerId: string): Promise<void> {
		const status = await this.getOrCreateStatus(indexerId);
		status.isEnabled = false;
		status.disabledReason = 'manual';
		status.health = 'disabled';
		this.markDirty(indexerId);
	}

	/**
	 * Update priority for an indexer.
	 */
	async setPriority(indexerId: string, priority: number): Promise<void> {
		const status = await this.getOrCreateStatus(indexerId);
		status.priority = priority;
		this.markDirty(indexerId);
	}

	/**
	 * Check if an indexer can be used.
	 */
	canUse(indexerId: string): boolean {
		const status = this.getStatusSync(indexerId);

		if (!status.isEnabled) return false;
		if (!status.isDisabled) return true;

		// Check if backoff period has passed
		if (status.disabledUntil && new Date() >= status.disabledUntil) {
			// Reset for retry
			status.isDisabled = false;
			if (status.disabledReason === 'quota_exceeded') {
				// A quota reset isn't a sign the indexer was ever unhealthy -
				// go straight back to healthy instead of lingering in "warning".
				status.consecutiveFailures = 0;
			} else {
				// Keep failure history in warning state after backoff so status does not
				// jump directly back to healthy without sustained successful requests.
				status.consecutiveFailures = Math.max(2, Math.floor(status.consecutiveFailures / 2));
			}
			status.disabledReason = undefined;
			status.health = this.calculateHealth(status);
			this.markDirty(indexerId);
			logger.info({ indexerId }, 'Indexer backoff period expired, re-enabling for retry');
			return true;
		}

		return false;
	}

	/**
	 * Get time until indexer can be retried (ms), or 0 if ready.
	 */
	getWaitTime(indexerId: string): number {
		const status = this.getStatusSync(indexerId);

		if (!status.isDisabled || !status.disabledUntil) return 0;

		const waitMs = status.disabledUntil.getTime() - Date.now();
		return Math.max(0, waitMs);
	}

	/**
	 * Reset status for an indexer.
	 */
	async reset(indexerId: string): Promise<void> {
		const status = this.getStatusSync(indexerId);
		const enabled = status.isEnabled;
		const priority = status.priority;

		this.cache.set(indexerId, createDefaultStatus(indexerId, enabled, priority));
		this.responseTimes.delete(indexerId);
		this.markDirty(indexerId);
	}

	/**
	 * Reset all status data.
	 */
	async resetAll(): Promise<void> {
		this.cache.clear();
		this.responseTimes.clear();
		this.dirty.clear();

		try {
			await db.delete(indexerStatus);
			logger.info('Cleared all indexer status from database');
		} catch (error) {
			logger.error({ err: error }, 'Failed to clear indexer status from database');
		}
	}

	/**
	 * Remove status for an indexer.
	 */
	async remove(indexerId: string): Promise<void> {
		this.cache.delete(indexerId);
		this.responseTimes.delete(indexerId);
		this.dirty.delete(indexerId);

		try {
			await db.delete(indexerStatus).where(eq(indexerStatus.indexerId, indexerId));
		} catch (error) {
			logger.debug({ indexerId, err: error }, 'Failed to remove indexer status from database');
		}
	}

	/**
	 * Force persist all dirty entries now.
	 */
	async flush(): Promise<void> {
		await this.persistDirty();
	}

	// ===== Private Methods =====

	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) {
			await this.init();
		}
	}

	private async getOrCreateStatus(indexerId: string): Promise<IndexerStatus> {
		await this.ensureInitialized();

		let status = this.cache.get(indexerId);
		if (!status) {
			status = createDefaultStatus(indexerId);
			this.cache.set(indexerId, status);
		}
		return status;
	}

	private markDirty(indexerId: string): void {
		this.dirty.add(indexerId);
	}

	private async persistDirty(): Promise<void> {
		if (this.dirty.size === 0) return;

		const indexerIds = Array.from(this.dirty);
		this.dirty.clear();

		for (const indexerId of indexerIds) {
			const status = this.cache.get(indexerId);
			if (!status) continue;

			try {
				await db
					.insert(indexerStatus)
					.values(this.statusToRow(status))
					.onConflictDoUpdate({
						target: indexerStatus.indexerId,
						set: {
							health: status.health,
							consecutiveFailures: status.consecutiveFailures,
							totalRequests: status.totalRequests,
							totalFailures: status.totalFailures,
							isDisabled: status.isDisabled,
							disabledAt: status.disabledAt?.toISOString() ?? null,
							disabledUntil: status.disabledUntil?.toISOString() ?? null,
							disabledReason: status.disabledReason ?? null,
							lastSuccess: status.lastSuccess?.toISOString() ?? null,
							lastFailure: status.lastFailure?.toISOString() ?? null,
							avgResponseTime: status.avgResponseTime ?? null,
							recentFailures: status.recentFailures.map((f) => ({
								timestamp: f.timestamp.toISOString(),
								message: f.message,
								requestUrl: f.requestUrl
							})),
							updatedAt: new Date().toISOString()
						}
					});
			} catch (error) {
				// Check if this is a foreign key constraint error (indexer was deleted)
				// The LibsqlError has the code in error.cause.code
				const errorMessage = error instanceof Error ? error.message : String(error);
				const errorCause = (error as { cause?: { code?: string } })?.cause;
				const isForeignKeyError =
					errorMessage.includes('FOREIGN KEY constraint failed') ||
					errorMessage.includes('SQLITE_CONSTRAINT_FOREIGNKEY') ||
					errorCause?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY';

				if (isForeignKeyError) {
					// Indexer no longer exists in the database - remove from cache
					logger.debug(
						{
							indexerId
						},
						'Removing orphaned indexer status (indexer no longer exists)'
					);
					this.cache.delete(indexerId);
					this.responseTimes.delete(indexerId);
					// Don't re-add to dirty - just let it go
				} else {
					logger.debug({ indexerId, err: error }, 'Failed to persist indexer status');
					// Re-add to dirty set to try again for transient errors
					this.dirty.add(indexerId);
				}
			}
		}
	}

	private disableIndexer(status: IndexerStatus): void {
		const backoffMs = this.backoffCalculator.calculate(status.consecutiveFailures);

		status.isDisabled = true;
		status.disabledAt = new Date();
		status.disabledUntil = new Date(Date.now() + backoffMs);
		status.disabledReason = 'consecutive_failures';
		status.health = 'disabled';

		logger.warn(
			{
				indexerId: status.indexerId,
				consecutiveFailures: status.consecutiveFailures,
				backoffMs,
				disabledUntil: status.disabledUntil.toISOString()
			},
			'Indexer auto-disabled due to failures'
		);
	}

	private calculateHealth(status: IndexerStatus): HealthStatus {
		if (!status.isEnabled) return 'disabled';
		if (status.isDisabled) return 'disabled';
		const failingThreshold = Math.max(2, this.config.failuresBeforeDisable - 1);
		if (status.consecutiveFailures >= failingThreshold) return 'failing';
		if (status.consecutiveFailures >= 2) return 'warning';
		return 'healthy';
	}

	private trackResponseTime(indexerId: string, ms: number): void {
		let times = this.responseTimes.get(indexerId);
		if (!times) {
			times = [];
			this.responseTimes.set(indexerId, times);
		}
		times.push(ms);
		// Keep last 100 response times
		if (times.length > 100) {
			times.shift();
		}
	}

	private calculateAvgResponseTime(indexerId: string): number | undefined {
		const times = this.responseTimes.get(indexerId);
		if (!times || times.length === 0) return undefined;
		return Math.round(times.reduce((a, b) => a + b, 0) / times.length);
	}

	private rowToStatus(row: IndexerStatusRow): IndexerStatus {
		return {
			indexerId: row.indexerId,
			isEnabled: true, // Enabled status comes from indexers table
			isDisabled: row.isDisabled ?? false,
			disabledAt: row.disabledAt ? new Date(row.disabledAt) : undefined,
			disabledUntil: row.disabledUntil ? new Date(row.disabledUntil) : undefined,
			disabledReason: (row.disabledReason as IndexerStatus['disabledReason']) ?? undefined,
			health: (row.health as HealthStatus) ?? 'healthy',
			consecutiveFailures: row.consecutiveFailures ?? 0,
			recentFailures: (row.recentFailures ?? []).map((f) => ({
				timestamp: new Date(f.timestamp),
				message: f.message,
				requestUrl: f.requestUrl
			})),
			lastSuccess: row.lastSuccess ? new Date(row.lastSuccess) : undefined,
			lastFailure: row.lastFailure ? new Date(row.lastFailure) : undefined,
			totalRequests: row.totalRequests ?? 0,
			totalFailures: row.totalFailures ?? 0,
			avgResponseTime: row.avgResponseTime ?? undefined,
			priority: 25 // Priority comes from indexers table
		};
	}

	private statusToRow(status: IndexerStatus): typeof indexerStatus.$inferInsert {
		return {
			indexerId: status.indexerId,
			health: status.health,
			consecutiveFailures: status.consecutiveFailures,
			totalRequests: status.totalRequests,
			totalFailures: status.totalFailures,
			isDisabled: status.isDisabled,
			disabledAt: status.disabledAt?.toISOString() ?? null,
			disabledUntil: status.disabledUntil?.toISOString() ?? null,
			disabledReason: status.disabledReason ?? null,
			lastSuccess: status.lastSuccess?.toISOString() ?? null,
			lastFailure: status.lastFailure?.toISOString() ?? null,
			avgResponseTime: status.avgResponseTime ?? null,
			recentFailures: status.recentFailures.map((f) => ({
				timestamp: f.timestamp.toISOString(),
				message: f.message,
				requestUrl: f.requestUrl
			})),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		};
	}
}

/** Singleton instance */
let persistentTrackerInstance: PersistentStatusTracker | null = null;

/**
 * Get the singleton persistent status tracker.
 */
export function getPersistentStatusTracker(config?: StatusTrackerConfig): PersistentStatusTracker {
	if (!persistentTrackerInstance) {
		persistentTrackerInstance = new PersistentStatusTracker(config);
	}
	return persistentTrackerInstance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetPersistentStatusTracker(): void {
	if (persistentTrackerInstance) {
		persistentTrackerInstance.shutdown().catch((error) => {
			logger.warn(
				{
					err: error
				},
				'Error during status tracker shutdown'
			);
		});
	}
	persistentTrackerInstance = null;
}
