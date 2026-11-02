/**
 * TaskWorker Base Class
 * Abstract base class for all worker types.
 * Provides common functionality for logging, status tracking, and lifecycle management.
 */

import { randomUUID } from 'node:crypto';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
import type { WorkerType, WorkerStatus, WorkerLogEntry, WorkerState } from './types.js';
import { workerTypeToLogCategory, DEFAULT_WORKER_CONFIG } from './types.js';

/**
 * Abstract base class for task workers.
 * Subclasses must implement the execute() method.
 */
export abstract class TaskWorker<
	TMetadata extends Record<string, unknown> = Record<string, unknown>
> {
	readonly id: string;
	abstract readonly type: WorkerType;

	protected _status: WorkerStatus = 'pending';
	protected _progress = 0;
	protected _error?: Error;
	protected _logs: WorkerLogEntry[] = [];
	protected _metadata: TMetadata;

	readonly createdAt: Date;
	protected _startedAt?: Date;
	protected _completedAt?: Date;

	private readonly maxLogs: number;
	private abortController: AbortController;

	constructor(metadata: TMetadata) {
		this.id = randomUUID();
		this.createdAt = new Date();
		this._metadata = metadata;
		this.maxLogs = DEFAULT_WORKER_CONFIG.maxLogsPerWorker;
		this.abortController = new AbortController();
	}

	/**
	 * Current worker status.
	 */
	get status(): WorkerStatus {
		return this._status;
	}

	/**
	 * Current progress (0-100).
	 */
	get progress(): number {
		return this._progress;
	}

	/**
	 * Error if worker failed.
	 */
	get error(): Error | undefined {
		return this._error;
	}

	/**
	 * Worker metadata.
	 */
	get metadata(): TMetadata {
		return this._metadata;
	}

	/**
	 * When the worker started executing.
	 */
	get startedAt(): Date | undefined {
		return this._startedAt;
	}

	/**
	 * When the worker completed (success, failure, or cancelled).
	 */
	get completedAt(): Date | undefined {
		return this._completedAt;
	}

	/**
	 * In-memory log buffer (most recent entries).
	 */
	get logs(): readonly WorkerLogEntry[] {
		return this._logs;
	}

	/**
	 * Abort signal for cancellation support.
	 */
	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/**
	 * Check if worker is still active (not completed/failed/cancelled).
	 */
	get isActive(): boolean {
		return this._status === 'pending' || this._status === 'running';
	}

	/**
	 * Log a message. Writes to both in-memory buffer and file logger.
	 */
	log(level: WorkerLogEntry['level'], message: string, data?: Record<string, unknown>): void {
		const entry: WorkerLogEntry = {
			timestamp: new Date(),
			level,
			message,
			data
		};

		// Add to in-memory buffer (with rotation)
		this._logs.push(entry);
		if (this._logs.length > this.maxLogs) {
			this._logs.shift();
		}

		// Write to file and console logger
		const logCategory = workerTypeToLogCategory(this.type);
		logger[level](message, {
			logCategory,
			workerId: this.id,
			workerType: this.type,
			...data
		});
	}

	/**
	 * Update progress (0-100).
	 */
	setProgress(progress: number): void {
		this._progress = Math.max(0, Math.min(100, progress));
	}

	/**
	 * Update metadata.
	 */
	updateMetadata(updates: Partial<TMetadata>): void {
		this._metadata = { ...this._metadata, ...updates };
	}

	/**
	 * Get serializable state for API responses.
	 */
	getState(): WorkerState {
		return {
			id: this.id,
			type: this.type,
			status: this._status,
			progress: this._progress,
			createdAt: this.createdAt,
			startedAt: this._startedAt,
			completedAt: this._completedAt,
			error: this._error?.message,
			metadata: this._metadata as Record<string, unknown>
		};
	}

	/**
	 * Start the worker execution.
	 * Called by WorkerManager - do not call directly.
	 */
	async run(): Promise<void> {
		if (this._status !== 'pending') {
			throw new Error(`Cannot start worker in ${this._status} state`);
		}

		this._status = 'running';
		this._startedAt = new Date();
		this.log('info', `Worker started`, { workerId: this.id });

		try {
			await this.execute();

			if (this._status === 'running') {
				// Only mark complete if not already cancelled
				this._status = 'completed';
				this._progress = 100;
				this._completedAt = new Date();
				this.log('info', `Worker completed successfully`, {
					durationMs: this._completedAt.getTime() - this._startedAt.getTime()
				});
			}
		} catch (error) {
			if (this.abortController.signal.aborted) {
				this._status = 'cancelled';
				this.log('info', `Worker cancelled`);
			} else {
				this._status = 'failed';
				this._error = error instanceof Error ? error : new Error(String(error));
				this.log('error', `Worker failed: ${this._error.message}`, {
					error: this._error.message,
					stack: this._error.stack
				});
			}
			this._completedAt = new Date();
		}
	}

	/**
	 * Cancel the worker execution.
	 */
	cancel(): void {
		if (!this.isActive) return;

		this.abortController.abort();
		this._status = 'cancelled';
		this._completedAt = new Date();
		this.log('info', `Worker cancelled by request`);
	}

	/**
	 * Abstract method that subclasses must implement.
	 * This is where the actual work happens.
	 */
	protected abstract execute(): Promise<void>;

	/**
	 * Helper to throw if cancellation was requested.
	 * Call this periodically in long-running execute() methods.
	 */
	protected throwIfCancelled(): void {
		if (this.abortController.signal.aborted) {
			throw new Error('Worker cancelled');
		}
	}
}
