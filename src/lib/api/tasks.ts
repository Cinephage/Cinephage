import type { TaskHistoryEntry } from '#lib/types/task.js';

import { apiGet, apiPost, apiPut } from './client.js';

/** A unified task definition plus its runtime status (GET /api/tasks). */
export interface TasksResponse {
	tasks: Array<{
		id: string;
		name: string;
		description: string;
		category: 'scheduled' | 'maintenance';
		runEndpoint: string;
		intervalKey?: string;
		defaultIntervalHours?: number;
		minIntervalHours?: number;
		intervalEditable?: boolean;
		lastRunTime: string | null;
		nextRunTime: string | null;
		intervalHours: number | null;
		isRunning: boolean;
		enabled: boolean;
	}>;
}

/** Response of PUT /api/tasks/:taskId/enabled. */
export interface TaskEnabledResponse {
	taskId: string;
	enabled: boolean;
}

/** Response of PUT /api/tasks/:taskId/interval. */
export interface TaskIntervalResponse {
	taskId: string;
	intervalHours: number;
}

/**
 * Response of POST /api/tasks/:taskId/run. Beyond historyId the endpoint
 * spreads the task endpoint's own arbitrary JSON result into the payload.
 */
export interface TaskRunResponse {
	historyId: string;
	[key: string]: unknown;
}

/** Response of GET /api/tasks/:taskId/history. */
export interface TaskHistoryResponse {
	taskId: string;
	history: TaskHistoryEntry[];
	pagination: {
		limit: number;
		offset: number;
		total: number;
		hasMore: boolean;
	};
}

/** Response of POST /api/tasks/:taskId/cancel. */
export interface TaskCancelResponse {
	message: string;
}

export async function getTasks() {
	return apiGet<TasksResponse>('/api/tasks');
}

export async function setTaskEnabled(taskId: string, enabled: boolean) {
	return apiPut<TaskEnabledResponse>(`/api/tasks/${taskId}/enabled`, { enabled });
}

export async function setTaskInterval(taskId: string, intervalHours: number) {
	return apiPut<TaskIntervalResponse>(`/api/tasks/${taskId}/interval`, { intervalHours });
}

export async function runTask(taskId: string) {
	return apiPost<TaskRunResponse>(`/api/tasks/${taskId}/run`);
}

export async function getTaskHistory(taskId: string, limit?: number, offset?: number) {
	const params: Record<string, string> = {};
	if (limit !== undefined) params.limit = String(limit);
	if (offset !== undefined) params.offset = String(offset);
	return apiGet<TaskHistoryResponse>(`/api/tasks/${taskId}/history`, params);
}

export async function cancelTask(taskId: string) {
	return apiPost<TaskCancelResponse>(`/api/tasks/${taskId}/cancel`);
}
