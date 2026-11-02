/**
 * Task Execution Context
 *
 * Provides cancellation-aware utilities for task execution.
 * All long-running tasks should use this context to ensure
 * consistent and reliable cancellation support.
 */

import { TaskCancelledException } from './TaskCancelledException.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'TaskExecutionContext' });

export class TaskExecutionContext {
	private readonly signal: AbortSignal;
	private readonly _taskId: string;
	private readonly _historyId: string;

	constructor(taskId: string, historyId: string, signal: AbortSignal) {
		this._taskId = taskId;
		this._historyId = historyId;
		this.signal = signal;
	}

	/**
	 * Get the task ID
	 */
	get taskId(): string {
		return this._taskId;
	}

	/**
	 * Get the history ID for this execution
	 */
	get historyId(): string {
		return this._historyId;
	}

	/**
	 * Get the raw AbortSignal for passing to external APIs
	 */
	get abortSignal(): AbortSignal {
		return this.signal;
	}

	/**
	 * Check if the task has been cancelled
	 */
	get isCancelled(): boolean {
		return this.signal.aborted;
	}

	/**
	 * Check if cancelled and throw TaskCancelledException if so.
	 * Call this at strategic points in your task.
	 */
	checkCancelled(): void {
		if (this.signal.aborted) {
			logger.info({ taskId: this._taskId }, '[TaskExecutionContext] Task cancelled');
			throw new TaskCancelledException(this._taskId);
		}
	}

	/**
	 * Iterate over items with automatic cancellation checks.
	 * Checks for cancellation before yielding each item.
	 *
	 * @example
	 * for await (const movie of ctx.iterate(movies)) {
	 *   await processMovie(movie);
	 * }
	 */
	async *iterate<T>(items: Iterable<T>): AsyncGenerator<T, void, undefined> {
		for (const item of items) {
			this.checkCancelled();
			yield item;
		}
	}

	/**
	 * Iterate over a Map with automatic cancellation checks.
	 *
	 * @example
	 * for await (const [key, value] of ctx.iterateMap(myMap)) {
	 *   await process(key, value);
	 * }
	 */
	async *iterateMap<K, V>(map: Map<K, V>): AsyncGenerator<[K, V], void, undefined> {
		for (const entry of map) {
			this.checkCancelled();
			yield entry;
		}
	}

	/**
	 * Cancellation-aware delay for rate limiting.
	 * Resolves after the specified time or rejects immediately if cancelled.
	 *
	 * @example
	 * await ctx.delay(500); // Rate limit between operations
	 */
	async delay(ms: number): Promise<void> {
		return new Promise((resolve, reject) => {
			// If already cancelled, reject immediately
			if (this.signal.aborted) {
				reject(new TaskCancelledException(this._taskId));
				return;
			}

			const timeout = setTimeout(() => {
				this.signal.removeEventListener('abort', onAbort);
				resolve();
			}, ms);

			const onAbort = () => {
				clearTimeout(timeout);
				reject(new TaskCancelledException(this._taskId));
			};

			this.signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	/**
	 * Run an operation with a cancellation check before execution.
	 * Useful for wrapping individual async operations.
	 *
	 * @example
	 * const result = await ctx.run(() => fetchData());
	 */
	async run<T>(operation: () => Promise<T>): Promise<T> {
		this.checkCancelled();
		return operation();
	}

	/**
	 * Run multiple operations in parallel with cancellation support.
	 * Checks for cancellation before starting.
	 *
	 * @example
	 * const results = await ctx.runAll([
	 *   () => fetchMovies(),
	 *   () => fetchEpisodes()
	 * ]);
	 */
	async runAll<T>(operations: Array<() => Promise<T>>): Promise<T[]> {
		this.checkCancelled();
		return Promise.all(operations.map((op) => op()));
	}

	/**
	 * Process items in batches with cancellation support and optional delay between batches.
	 *
	 * @example
	 * await ctx.processBatched(items, 10, async (batch) => {
	 *   await Promise.all(batch.map(item => processItem(item)));
	 * }, 1000); // 1 second delay between batches
	 */
	async processBatched<T>(
		items: T[],
		batchSize: number,
		processor: (batch: T[]) => Promise<void>,
		delayMs?: number
	): Promise<void> {
		for (let i = 0; i < items.length; i += batchSize) {
			this.checkCancelled();

			const batch = items.slice(i, i + batchSize);
			await processor(batch);

			// Delay between batches if specified and not the last batch
			if (delayMs && i + batchSize < items.length) {
				await this.delay(delayMs);
			}
		}
	}
}

/**
 * Create a TaskExecutionContext for a task.
 * This is the preferred way to create a context.
 */
export function createTaskContext(
	taskId: string,
	historyId: string,
	signal: AbortSignal
): TaskExecutionContext {
	return new TaskExecutionContext(taskId, historyId, signal);
}
