/**
 * Task SSE Event Types
 *
 * Shared types for the /api/tasks/stream endpoint
 */

import type { TaskHistoryEntry } from '#lib/types/task.js';

/**
 * task:started event - A task began execution
 */
export interface TaskStartedEvent {
	taskId: string;
	startedAt: string;
}

/**
 * task:completed event - A task finished successfully
 */
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

/**
 * task:failed event - A task encountered an error
 */
export interface TaskFailedEvent {
	taskId: string;
	completedAt: string;
	error: string;
	historyEntry?: TaskHistoryEntry;
}

/**
 * task:cancelled event - A running task was cancelled
 */
export interface TaskCancelledEvent {
	taskId: string;
	cancelledAt: string;
}

/**
 * task:updated event - Task settings changed
 */
export interface TaskUpdatedEvent {
	taskId: string;
	enabled?: boolean;
	intervalHours?: number;
	nextRunTime?: string | null;
}

/**
 * All events for the tasks stream endpoint
 */
export interface TaskStreamEvents {
	'task:started': TaskStartedEvent;
	'task:completed': TaskCompletedEvent;
	'task:failed': TaskFailedEvent;
	'task:cancelled': TaskCancelledEvent;
	'task:updated': TaskUpdatedEvent;
}
