/**
 * Task History Service
 *
 * Manages task execution history and prevents concurrent task runs.
 * Tracks when tasks started, completed, failed, and their results.
 */

import { db } from '#lib/server/db/index.js';
import { taskHistory } from '#lib/server/db/schema.js';
import { eq, desc, inArray, sql, and, ne, lt } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import type { TaskHistoryEntry } from '#lib/types/task.js';
import { TaskExecutionContext } from './TaskExecutionContext.js';

const logger = createChildLogger({ module: 'TaskHistoryService' });

/**
 * Service for managing task execution history
 */
class TaskHistoryService {
	private static instance: TaskHistoryService | null = null;

	/** In-memory set of currently running task IDs */
	private runningTasks: Set<string> = new Set();

	/** AbortControllers for running tasks (for cancellation support) */
	private abortControllers: Map<string, { controller: AbortController; historyId: string }> =
		new Map();

	private constructor() {}

	static getInstance(): TaskHistoryService {
		if (!TaskHistoryService.instance) {
			TaskHistoryService.instance = new TaskHistoryService();
		}
		return TaskHistoryService.instance;
	}

	/** Reset the singleton instance (for testing) */
	static resetInstance(): void {
		TaskHistoryService.instance = null;
	}

	/**
	 * Start tracking a task execution.
	 * Creates a history entry with status='running' and an AbortController for cancellation.
	 *
	 * @throws Error if the task is already running
	 */
	async startTask(taskId: string): Promise<string> {
		if (this.runningTasks.has(taskId)) {
			throw new Error(`Task '${taskId}' is already running`);
		}

		this.runningTasks.add(taskId);

		// Create AbortController for cancellation support
		const controller = new AbortController();

		const [entry] = await db
			.insert(taskHistory)
			.values({
				taskId,
				status: 'running'
			})
			.returning({ id: taskHistory.id });

		// Store controller with historyId so we can cancel the correct entry
		this.abortControllers.set(taskId, { controller, historyId: entry.id });

		logger.info({ taskId, historyId: entry.id }, '[TaskHistoryService] Task started');

		return entry.id;
	}

	/**
	 * Start a task and create an execution context.
	 * This is the preferred way to start tasks as it provides a context
	 * with built-in cancellation support.
	 *
	 * @throws Error if the task is already running
	 */
	async createExecutionContext(taskId: string): Promise<TaskExecutionContext> {
		const historyId = await this.startTask(taskId);
		const signal = this.getAbortSignal(taskId);

		if (!signal) {
			// This should never happen since startTask creates the controller
			throw new Error(`No abort signal available for task '${taskId}'`);
		}

		return new TaskExecutionContext(taskId, historyId, signal);
	}

	/**
	 * Mark a task as completed with its results.
	 */
	async completeTask(historyId: string, results: Record<string, unknown>): Promise<void> {
		const [entry] = await db
			.update(taskHistory)
			.set({
				status: 'completed',
				results,
				completedAt: new Date().toISOString()
			})
			.where(eq(taskHistory.id, historyId))
			.returning({ taskId: taskHistory.taskId });

		if (entry) {
			this.runningTasks.delete(entry.taskId);
			this.abortControllers.delete(entry.taskId);
			logger.info({ historyId, taskId: entry.taskId }, '[TaskHistoryService] Task completed');
		}
	}

	/**
	 * Mark a task as failed with error messages.
	 */
	async failTask(historyId: string, errors: string[]): Promise<void> {
		const [entry] = await db
			.update(taskHistory)
			.set({
				status: 'failed',
				errors,
				completedAt: new Date().toISOString()
			})
			.where(eq(taskHistory.id, historyId))
			.returning({ taskId: taskHistory.taskId });

		if (entry) {
			this.runningTasks.delete(entry.taskId);
			this.abortControllers.delete(entry.taskId);
			logger.error(
				{
					historyId,
					taskId: entry.taskId,
					errors
				},
				'[TaskHistoryService] Task failed'
			);
		}
	}

	/**
	 * Get the most recent completed or failed run for a task.
	 */
	async getLastRunForTask(taskId: string): Promise<TaskHistoryEntry | null> {
		const [entry] = await db
			.select()
			.from(taskHistory)
			.where(eq(taskHistory.taskId, taskId))
			.orderBy(desc(taskHistory.startedAt))
			.limit(1);

		if (!entry) return null;

		return {
			id: entry.id,
			taskId: entry.taskId,
			status: entry.status as 'running' | 'completed' | 'failed' | 'cancelled',
			results: entry.results,
			errors: entry.errors,
			startedAt: entry.startedAt!,
			completedAt: entry.completedAt
		};
	}

	/**
	 * Get recent task history across all tasks.
	 */
	async getRecentHistory(limit: number = 20): Promise<TaskHistoryEntry[]> {
		const entries = await db
			.select()
			.from(taskHistory)
			.orderBy(desc(taskHistory.startedAt))
			.limit(limit);

		return entries.map((entry) => ({
			id: entry.id,
			taskId: entry.taskId,
			status: entry.status as 'running' | 'completed' | 'failed' | 'cancelled',
			results: entry.results,
			errors: entry.errors,
			startedAt: entry.startedAt!,
			completedAt: entry.completedAt
		}));
	}

	/**
	 * Check if a task is currently running.
	 */
	isTaskRunning(taskId: string): boolean {
		return this.runningTasks.has(taskId);
	}

	/**
	 * Get the AbortSignal for a running task.
	 * Tasks should check this signal periodically to support cancellation.
	 */
	getAbortSignal(taskId: string): AbortSignal | undefined {
		return this.abortControllers.get(taskId)?.controller.signal;
	}

	/**
	 * Cancel a running task.
	 * Aborts the task's AbortController and marks it as cancelled in the database.
	 *
	 * @returns true if task was cancelled, false if task was not running
	 */
	async cancelTask(taskId: string): Promise<boolean> {
		const controllerData = this.abortControllers.get(taskId);
		if (!controllerData || !this.runningTasks.has(taskId)) {
			return false;
		}

		// Abort the controller to signal cancellation
		controllerData.controller.abort();

		// Update the specific history entry we created when starting this task
		await db
			.update(taskHistory)
			.set({
				status: 'cancelled',
				completedAt: new Date().toISOString()
			})
			.where(eq(taskHistory.id, controllerData.historyId));

		logger.info(
			{
				taskId,
				historyId: controllerData.historyId
			},
			'[TaskHistoryService] Task cancelled'
		);

		// Clean up in-memory state
		this.runningTasks.delete(taskId);
		this.abortControllers.delete(taskId);

		return true;
	}

	/**
	 * Clean up stale "running" entries on startup.
	 * This handles cases where the server crashed while a task was running.
	 */
	async cleanupStaleRunning(): Promise<void> {
		const staleEntries = await db
			.update(taskHistory)
			.set({
				status: 'failed',
				errors: ['Server restarted while task was running'],
				completedAt: new Date().toISOString()
			})
			.where(eq(taskHistory.status, 'running'))
			.returning({ id: taskHistory.id, taskId: taskHistory.taskId });

		if (staleEntries.length > 0) {
			logger.warn(
				{
					count: staleEntries.length,
					tasks: staleEntries.map((e) => e.taskId)
				},
				'[TaskHistoryService] Cleaned up stale running tasks'
			);
		}

		// Clear in-memory state
		this.runningTasks.clear();
		this.abortControllers.clear();
	}

	/**
	 * Get history for a specific task with pagination.
	 */
	async getHistoryForTask(
		taskId: string,
		limit: number = 10,
		offset: number = 0
	): Promise<{ entries: TaskHistoryEntry[]; total: number }> {
		const [entries, countResult] = await Promise.all([
			db
				.select()
				.from(taskHistory)
				.where(eq(taskHistory.taskId, taskId))
				.orderBy(desc(taskHistory.startedAt))
				.limit(limit)
				.offset(offset),
			db
				.select({ count: sql<number>`count(*)` })
				.from(taskHistory)
				.where(eq(taskHistory.taskId, taskId))
		]);

		return {
			entries: entries.map((entry) => ({
				id: entry.id,
				taskId: entry.taskId,
				status: entry.status as 'running' | 'completed' | 'failed' | 'cancelled',
				results: entry.results,
				errors: entry.errors,
				startedAt: entry.startedAt!,
				completedAt: entry.completedAt
			})),
			total: Number(countResult[0]?.count ?? 0)
		};
	}

	/**
	 * Get history for multiple tasks at once.
	 * Returns the most recent entries for each task.
	 */
	async getHistoryForTasks(
		taskIds: string[],
		limitPerTask: number = 5
	): Promise<Map<string, TaskHistoryEntry[]>> {
		if (taskIds.length === 0) {
			return new Map();
		}

		// Get recent history for all requested tasks
		const entries = await db
			.select()
			.from(taskHistory)
			.where(inArray(taskHistory.taskId, taskIds))
			.orderBy(desc(taskHistory.startedAt))
			.limit(taskIds.length * limitPerTask * 2); // Get extra to ensure enough per task

		// Group by taskId and limit each group
		const grouped = new Map<string, TaskHistoryEntry[]>();

		for (const taskId of taskIds) {
			grouped.set(taskId, []);
		}

		for (const entry of entries) {
			const taskEntries = grouped.get(entry.taskId);
			if (taskEntries && taskEntries.length < limitPerTask) {
				taskEntries.push({
					id: entry.id,
					taskId: entry.taskId,
					status: entry.status as 'running' | 'completed' | 'failed' | 'cancelled',
					results: entry.results,
					errors: entry.errors,
					startedAt: entry.startedAt!,
					completedAt: entry.completedAt
				});
			}
		}

		return grouped;
	}

	/**
	 * Get the last completed (non-running) run for a task.
	 * Useful for showing "last successful run" even if a task is currently running.
	 */
	async getLastCompletedRunForTask(taskId: string): Promise<TaskHistoryEntry | null> {
		const [entry] = await db
			.select()
			.from(taskHistory)
			.where(and(eq(taskHistory.taskId, taskId), ne(taskHistory.status, 'running')))
			.orderBy(desc(taskHistory.startedAt))
			.limit(1);

		if (!entry) return null;

		return {
			id: entry.id,
			taskId: entry.taskId,
			status: entry.status as 'running' | 'completed' | 'failed' | 'cancelled',
			results: entry.results,
			errors: entry.errors,
			startedAt: entry.startedAt!,
			completedAt: entry.completedAt
		};
	}

	/**
	 * Clean up old history entries beyond the retention period.
	 * This removes entries from taskHistory (which cascade-deletes related monitoringHistory).
	 *
	 * @param retentionDays - Number of days to retain history (default: 30)
	 * @returns Number of entries deleted
	 */
	async cleanupOldHistory(retentionDays: number = 30): Promise<number> {
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
		const cutoffIso = cutoffDate.toISOString();

		const deletedEntries = await db
			.delete(taskHistory)
			.where(lt(taskHistory.startedAt, cutoffIso))
			.returning({ id: taskHistory.id });

		const count = deletedEntries.length;

		if (count > 0) {
			logger.info(
				{
					deletedCount: count,
					retentionDays,
					cutoffDate: cutoffIso
				},
				'[TaskHistoryService] Cleaned up old history entries'
			);
		}

		return count;
	}
}

// Singleton getter - preferred way to access the service
export function getTaskHistoryService(): TaskHistoryService {
	return TaskHistoryService.getInstance();
}

// Reset singleton (for testing)
export function resetTaskHistoryService(): void {
	TaskHistoryService.resetInstance();
}

// Backward-compatible export (prefer getTaskHistoryService())
export const taskHistoryService = TaskHistoryService.getInstance();
