/**
 * Server-Sent Events endpoint for real-time task status updates
 *
 * GET /api/tasks/stream
 *
 * Events emitted:
 * - task:started     - A task began execution (scheduled or manual)
 * - task:completed   - A task finished successfully
 * - task:failed      - A task encountered an error
 * - task:cancelled   - A running task was cancelled
 * - task:updated     - Task settings changed (enabled, interval, etc.)
 */

import type { RequestHandler } from './$types';
import { createSSEStream } from '#lib/server/sse.js';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { taskSettingsService } from '#lib/server/tasks/TaskSettingsService.js';
import { taskHistoryService } from '#lib/server/tasks/TaskHistoryService.js';
import type { TaskResult } from '#lib/server/monitoring/MonitoringScheduler.js';
import type { TaskHistoryEntry } from '#lib/types/task.js';

/**
 * SSE event payload types
 */
export interface TaskStartedEvent {
	taskId: string;
	startedAt: string;
}

export interface TaskCompletedEvent {
	taskId: string;
	completedAt: string;
	lastRunTime: string;
	nextRunTime: string | null;
	result?: {
		itemsProcessed: number;
		itemsGrabbed: number;
		errors: number;
	};
	historyEntry?: TaskHistoryEntry;
}

export interface TaskFailedEvent {
	taskId: string;
	completedAt: string;
	error: string;
	historyEntry?: TaskHistoryEntry;
}

export interface TaskCancelledEvent {
	taskId: string;
	cancelledAt: string;
}

export interface TaskUpdatedEvent {
	taskId: string;
	enabled?: boolean;
	intervalHours?: number;
	nextRunTime?: string | null;
}

export interface TaskStreamEvents {
	'task:started': TaskStartedEvent;
	'task:completed': TaskCompletedEvent;
	'task:failed': TaskFailedEvent;
	'task:cancelled': TaskCancelledEvent;
	'task:updated': TaskUpdatedEvent;
}

/**
 * Helper to compute the next run time after a task completes.
 * Reads the interval from settings, calculates based on completion time.
 */
async function getNextRunTimeForTask(taskId: string, completionTime: Date): Promise<string | null> {
	const interval = await taskSettingsService.getTaskInterval(taskId);
	if (interval === null) return null;
	return new Date(completionTime.getTime() + interval * 60 * 60 * 1000).toISOString();
}

/**
 * Fetch the latest history entry for a completed task
 */
async function getCompletedHistoryEntry(taskType: string): Promise<TaskHistoryEntry | undefined> {
	try {
		const lastRun = await taskHistoryService.getLastRunForTask(taskType);
		if (lastRun && lastRun.status === 'completed') {
			return lastRun;
		}
	} catch {
		// Non-critical: skip history entry
	}
	return undefined;
}

/**
 * Fetch the latest history entry for a failed task
 */
async function getFailedHistoryEntry(
	taskType: string,
	_error: unknown
): Promise<TaskHistoryEntry | undefined> {
	try {
		const lastRun = await taskHistoryService.getLastRunForTask(taskType);
		if (lastRun && lastRun.status === 'failed') {
			return lastRun;
		}
	} catch {
		// Non-critical: skip history entry
	}
	return undefined;
}

export const GET: RequestHandler = async () => {
	return createSSEStream(async (send) => {
		// --- Scheduled task event handlers ---

		const onTaskStarted = (taskType: string) => {
			const payload: TaskStartedEvent = {
				taskId: taskType,
				startedAt: new Date().toISOString()
			};
			send('task:started', payload);
		};

		const onTaskCompleted = async (taskType: string, result: TaskResult) => {
			const completionTime = new Date();
			const nextRunTime = await getNextRunTimeForTask(taskType, completionTime);
			const historyEntry = await getCompletedHistoryEntry(taskType);

			const payload: TaskCompletedEvent = {
				taskId: taskType,
				completedAt: completionTime.toISOString(),
				lastRunTime: completionTime.toISOString(),
				nextRunTime,
				result: {
					itemsProcessed: result.itemsProcessed,
					itemsGrabbed: result.itemsGrabbed,
					errors: result.errors
				},
				historyEntry
			};
			send('task:completed', payload);
		};

		const onTaskFailed = async (taskType: string, error: unknown) => {
			const completionTime = new Date();
			const historyEntry = await getFailedHistoryEntry(taskType, error);

			const payload: TaskFailedEvent = {
				taskId: taskType,
				completedAt: completionTime.toISOString(),
				error: error instanceof Error ? error.message : String(error),
				historyEntry
			};
			send('task:failed', payload);
		};

		const onTaskCancelled = (taskType: string) => {
			const payload: TaskCancelledEvent = {
				taskId: taskType,
				cancelledAt: new Date().toISOString()
			};
			send('task:cancelled', payload);
		};

		// --- Manual task event handlers ---

		const onManualTaskStarted = (taskType: string) => {
			const payload: TaskStartedEvent = {
				taskId: taskType,
				startedAt: new Date().toISOString()
			};
			send('task:started', payload);
		};

		const onManualTaskCompleted = async (taskType: string, result: TaskResult) => {
			const completionTime = new Date();
			const nextRunTime = await getNextRunTimeForTask(taskType, completionTime);
			const historyEntry = await getCompletedHistoryEntry(taskType);

			const payload: TaskCompletedEvent = {
				taskId: taskType,
				completedAt: completionTime.toISOString(),
				lastRunTime: completionTime.toISOString(),
				nextRunTime,
				result: {
					itemsProcessed: result.itemsProcessed,
					itemsGrabbed: result.itemsGrabbed,
					errors: result.errors
				},
				historyEntry
			};
			send('task:completed', payload);
		};

		const onManualTaskFailed = async (taskType: string, error: unknown) => {
			const completionTime = new Date();
			const historyEntry = await getFailedHistoryEntry(taskType, error);

			const payload: TaskFailedEvent = {
				taskId: taskType,
				completedAt: completionTime.toISOString(),
				error: error instanceof Error ? error.message : String(error),
				historyEntry
			};
			send('task:failed', payload);
		};

		const onManualTaskCancelled = (taskType: string) => {
			const payload: TaskCancelledEvent = {
				taskId: taskType,
				cancelledAt: new Date().toISOString()
			};
			send('task:cancelled', payload);
		};

		// --- Settings change event handler ---

		const onTaskSettingsUpdated = (data: {
			taskId: string;
			enabled?: boolean;
			intervalHours?: number;
			nextRunTime?: string | null;
		}) => {
			const payload: TaskUpdatedEvent = {
				taskId: data.taskId,
				enabled: data.enabled,
				intervalHours: data.intervalHours,
				nextRunTime: data.nextRunTime
			};
			send('task:updated', payload);
		};

		// Register all event handlers
		monitoringScheduler.on('taskStarted', onTaskStarted);
		monitoringScheduler.on('taskCompleted', onTaskCompleted);
		monitoringScheduler.on('taskFailed', onTaskFailed);
		monitoringScheduler.on('taskCancelled', onTaskCancelled);
		monitoringScheduler.on('manualTaskStarted', onManualTaskStarted);
		monitoringScheduler.on('manualTaskCompleted', onManualTaskCompleted);
		monitoringScheduler.on('manualTaskFailed', onManualTaskFailed);
		monitoringScheduler.on('manualTaskCancelled', onManualTaskCancelled);
		monitoringScheduler.on('taskSettingsUpdated', onTaskSettingsUpdated);

		// Return cleanup function
		return () => {
			monitoringScheduler.off('taskStarted', onTaskStarted);
			monitoringScheduler.off('taskCompleted', onTaskCompleted);
			monitoringScheduler.off('taskFailed', onTaskFailed);
			monitoringScheduler.off('taskCancelled', onTaskCancelled);
			monitoringScheduler.off('manualTaskStarted', onManualTaskStarted);
			monitoringScheduler.off('manualTaskCompleted', onManualTaskCompleted);
			monitoringScheduler.off('manualTaskFailed', onManualTaskFailed);
			monitoringScheduler.off('manualTaskCancelled', onManualTaskCancelled);
			monitoringScheduler.off('taskSettingsUpdated', onTaskSettingsUpdated);
		};
	});
};
