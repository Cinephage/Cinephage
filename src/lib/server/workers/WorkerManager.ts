/**
 * WorkerManager
 * Central registry and coordinator for all task workers.
 * Handles spawning, tracking, concurrency limits, and cleanup.
 */

import { EventEmitter } from 'events';
import { logger } from '#lib/logging/index.js';
import { TaskWorker } from './TaskWorker.js';
import type {
	WorkerType,
	WorkerEvent,
	WorkerManagerConfig,
	WorkerState,
	WorkerLogEntry
} from './types.js';
import { DEFAULT_WORKER_CONFIG } from './types.js';

/**
 * Error thrown when concurrency limit is reached.
 */
export class ConcurrencyLimitError extends Error {
	constructor(
		public readonly workerType: WorkerType,
		public readonly limit: number,
		public readonly current: number
	) {
		super(
			`Concurrency limit reached for ${workerType} workers: ${current}/${limit}. ` +
				`Please wait for existing workers to complete.`
		);
		this.name = 'ConcurrencyLimitError';
	}
}

/**
 * Worker manager singleton.
 */
class WorkerManagerImpl extends EventEmitter {
	private workers = new Map<string, TaskWorker>();
	private config: WorkerManagerConfig;
	private cleanupTimer?: ReturnType<typeof setInterval>;

	constructor(config: Partial<WorkerManagerConfig> = {}) {
		super();
		this.config = { ...DEFAULT_WORKER_CONFIG, ...config };
		this.startCleanupTimer();
	}

	/**
	 * Start the cleanup timer for auto-removing completed workers.
	 */
	private startCleanupTimer(): void {
		if (this.config.cleanupAfterMs <= 0) return;

		// Check every minute
		this.cleanupTimer = setInterval(() => {
			this.cleanupCompleted();
		}, 60_000);

		// Don't prevent process exit
		if (this.cleanupTimer.unref) {
			this.cleanupTimer.unref();
		}
	}

	/**
	 * Clean up completed workers that have exceeded the cleanup threshold.
	 */
	private cleanupCompleted(): void {
		const now = Date.now();
		const toRemove: string[] = [];

		for (const [id, worker] of this.workers) {
			if (!worker.isActive && worker.completedAt) {
				const age = now - worker.completedAt.getTime();
				if (age >= this.config.cleanupAfterMs) {
					toRemove.push(id);
				}
			}
		}

		for (const id of toRemove) {
			this.workers.delete(id);
			this.emitEvent({ type: 'removed', workerId: id });
			logger.debug(
				{
					logDomain: 'system',
					workerId: id
				},
				`Cleaned up completed worker`
			);
		}
	}

	/**
	 * Emit a worker event to all listeners.
	 */
	private emitEvent(event: WorkerEvent): void {
		this.emit('worker', event);
	}

	/**
	 * Count active workers of a given type.
	 */
	private countActive(type: WorkerType): number {
		let count = 0;
		for (const worker of this.workers.values()) {
			if (worker.type === type && worker.isActive) {
				count++;
			}
		}
		return count;
	}

	/**
	 * Spawn a new worker.
	 * Throws ConcurrencyLimitError if limit is reached.
	 * Returns the worker after adding it to the registry.
	 */
	spawn<T extends TaskWorker>(worker: T): T {
		const limit = this.config.maxConcurrent[worker.type];
		const current = this.countActive(worker.type);

		if (limit > 0 && current >= limit) {
			throw new ConcurrencyLimitError(worker.type, limit, current);
		}

		this.workers.set(worker.id, worker);
		this.emitEvent({ type: 'spawned', workerId: worker.id, workerType: worker.type });

		logger.info(
			{
				logDomain: 'system',
				workerId: worker.id,
				workerType: worker.type
			},
			`Worker spawned`
		);

		return worker;
	}

	/**
	 * Spawn and immediately start a worker.
	 * The returned promise resolves when the worker completes.
	 */
	async spawnAndRun<T extends TaskWorker>(worker: T): Promise<T> {
		this.spawn(worker);
		this.emitEvent({ type: 'started', workerId: worker.id });

		await worker.run();

		if (worker.status === 'completed') {
			this.emitEvent({ type: 'completed', workerId: worker.id });
		} else if (worker.status === 'failed') {
			this.emitEvent({
				type: 'failed',
				workerId: worker.id,
				error: worker.error?.message || 'Unknown error'
			});
		} else if (worker.status === 'cancelled') {
			this.emitEvent({ type: 'cancelled', workerId: worker.id });
		}

		return worker;
	}

	/**
	 * Spawn and start a worker in the background (fire-and-forget).
	 * Errors are logged but not thrown.
	 */
	spawnInBackground<T extends TaskWorker>(worker: T): T {
		this.spawn(worker);
		this.emitEvent({ type: 'started', workerId: worker.id });

		worker
			.run()
			.then(() => {
				if (worker.status === 'completed') {
					this.emitEvent({ type: 'completed', workerId: worker.id });
				} else if (worker.status === 'failed') {
					this.emitEvent({
						type: 'failed',
						workerId: worker.id,
						error: worker.error?.message || 'Unknown error'
					});
				} else if (worker.status === 'cancelled') {
					this.emitEvent({ type: 'cancelled', workerId: worker.id });
				}
			})
			.catch((error) => {
				logger.error(
					{
						err: error,
						...{
							logDomain: 'system',
							workerId: worker.id
						}
					},
					`Background worker failed unexpectedly`
				);
			});

		return worker;
	}

	/**
	 * Get a worker by ID.
	 */
	get(id: string): TaskWorker | undefined {
		return this.workers.get(id);
	}

	/**
	 * List all workers, optionally filtered by type.
	 */
	list(type?: WorkerType): TaskWorker[] {
		const workers = Array.from(this.workers.values());
		if (type) {
			return workers.filter((w) => w.type === type);
		}
		return workers;
	}

	/**
	 * Get worker states (for API responses).
	 */
	listStates(type?: WorkerType): WorkerState[] {
		return this.list(type).map((w) => w.getState());
	}

	/**
	 * Get logs for a specific worker.
	 */
	getLogs(id: string, limit = 100): WorkerLogEntry[] {
		const worker = this.workers.get(id);
		if (!worker) return [];
		return worker.logs.slice(-limit);
	}

	/**
	 * Cancel a worker by ID.
	 */
	cancel(id: string): boolean {
		const worker = this.workers.get(id);
		if (!worker || !worker.isActive) return false;

		worker.cancel();
		this.emitEvent({ type: 'cancelled', workerId: id });
		return true;
	}

	/**
	 * Remove a completed worker from the registry.
	 */
	remove(id: string): boolean {
		const worker = this.workers.get(id);
		if (!worker) return false;

		// Can only remove completed workers
		if (worker.isActive) {
			worker.cancel();
		}

		this.workers.delete(id);
		this.emitEvent({ type: 'removed', workerId: id });
		return true;
	}

	/**
	 * Clear all completed workers.
	 */
	clearCompleted(): number {
		const toRemove: string[] = [];

		for (const [id, worker] of this.workers) {
			if (!worker.isActive) {
				toRemove.push(id);
			}
		}

		for (const id of toRemove) {
			this.workers.delete(id);
			this.emitEvent({ type: 'removed', workerId: id });
		}

		return toRemove.length;
	}

	/**
	 * Get summary statistics.
	 */
	getStats(): {
		total: number;
		byType: Record<WorkerType, { active: number; completed: number; failed: number }>;
	} {
		const stats: Record<WorkerType, { active: number; completed: number; failed: number }> = {
			stream: { active: 0, completed: 0, failed: 0 },
			import: { active: 0, completed: 0, failed: 0 },
			scan: { active: 0, completed: 0, failed: 0 },
			monitoring: { active: 0, completed: 0, failed: 0 },
			search: { active: 0, completed: 0, failed: 0 },
			'portal-scan': { active: 0, completed: 0, failed: 0 },
			'channel-sync': { active: 0, completed: 0, failed: 0 }
		};

		for (const worker of this.workers.values()) {
			if (worker.isActive) {
				stats[worker.type].active++;
			} else if (worker.status === 'completed') {
				stats[worker.type].completed++;
			} else {
				stats[worker.type].failed++;
			}
		}

		return {
			total: this.workers.size,
			byType: stats
		};
	}

	/**
	 * Get current configuration.
	 */
	getConfig(): WorkerManagerConfig {
		return { ...this.config };
	}

	/**
	 * Update configuration at runtime.
	 */
	updateConfig(updates: Partial<WorkerManagerConfig>): void {
		this.config = { ...this.config, ...updates };

		if (updates.maxConcurrent) {
			this.config.maxConcurrent = { ...this.config.maxConcurrent, ...updates.maxConcurrent };
		}

		logger.info(
			{
				logDomain: 'system',
				config: this.config
			},
			`Worker manager config updated`
		);
	}

	/**
	 * Shutdown: cancel all active workers and clear registry.
	 */
	async shutdown(): Promise<void> {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
		}

		// Cancel all active workers
		for (const worker of this.workers.values()) {
			if (worker.isActive) {
				worker.cancel();
			}
		}

		this.workers.clear();
		logger.info({ logDomain: 'system' }, `Worker manager shut down`);
	}
}

// Singleton management
let workerManagerInstance: WorkerManagerImpl | null = null;

// Singleton getter - preferred way to access the service
export function getWorkerManager(): WorkerManagerImpl {
	if (!workerManagerInstance) {
		workerManagerInstance = new WorkerManagerImpl();
	}
	return workerManagerInstance;
}

// Reset singleton (for testing)
export function resetWorkerManager(): void {
	if (workerManagerInstance) {
		workerManagerInstance.shutdown();
		workerManagerInstance = null;
	}
}

// Backward-compatible export (prefer getWorkerManager())
export const workerManager = getWorkerManager();
