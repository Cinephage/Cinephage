/**
 * Task Run Endpoint
 *
 * POST /api/tasks/[taskId]/run
 *
 * Executes a registered system task and tracks its execution in history.
 * Prevents concurrent runs of the same task.
 * Emits SSE events via monitoringScheduler for real-time UI updates.
 *
 * Designed primarily for maintenance tasks (library-scan, update-strm-urls)
 * that don't go through MonitoringScheduler's executeTaskManually flow.
 * Scheduled tasks should be run via their direct runEndpoint instead
 * (which triggers MonitoringScheduler event emission natively).
 */

import type { RequestHandler } from './$types';
import { getUnifiedTaskById } from '#lib/server/tasks/UnifiedTaskRegistry.js';
import { taskHistoryService } from '#lib/server/tasks/TaskHistoryService.js';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getRecoverableApiKeyByType } from '#lib/server/auth/index.js';

const logger = createChildLogger({ module: 'TaskRunAPI' });

/**
 * Fetch the Media Streaming API Key for a user
 */
async function getUserStreamingApiKey(userId: string): Promise<string | null> {
	try {
		const key = await getRecoverableApiKeyByType('streaming', userId);

		if (!key) {
			logger.warn({ userId }, '[TaskRunAPI] No Media Streaming API Key found for user');
			return null;
		}

		return key;
	} catch (error) {
		logger.error(
			{
				error: error instanceof Error ? error.message : 'Unknown error'
			},
			'[TaskRunAPI] Failed to fetch Media Streaming API Key'
		);
		return null;
	}
}

function getSummarySource(result: Record<string, unknown>): Record<string, unknown> {
	if (typeof result.result === 'object' && result.result !== null) {
		return result.result as Record<string, unknown>;
	}
	return result;
}

function getErrorCount(errorsValue: unknown): number {
	if (typeof errorsValue === 'number') return errorsValue;
	if (Array.isArray(errorsValue)) return errorsValue.length;
	return 0;
}

function toNumber(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

function buildResultSummary(result: Record<string, unknown>): Record<string, unknown> {
	const source = getSummarySource(result);
	const summary: Record<string, unknown> = { success: result.success };

	const numericKeys = [
		'itemsProcessed',
		'itemsGrabbed',
		'totalFiles',
		'updatedFiles',
		'filesScanned',
		'filesAdded',
		'filesUpdated',
		'filesRemoved',
		'unmatchedFiles',
		'total',
		'updated',
		'failed',
		'skipped'
	] as const;

	for (const key of numericKeys) {
		const value = toNumber(source[key]);
		if (value !== undefined) {
			summary[key] = value;
		}
	}

	const errors = getErrorCount(source.errors);
	if (errors > 0) {
		summary.errors = errors;
	}

	return summary;
}

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params, fetch, request, locals } = event;
	const { taskId } = params;

	// Validate task exists in registry
	const taskDef = getUnifiedTaskById(taskId);
	if (!taskDef) {
		return Response.json({ success: false, error: `Task '${taskId}' not found` }, { status: 404 });
	}

	// Check if task is already running
	if (taskHistoryService.isTaskRunning(taskId)) {
		return Response.json(
			{ success: false, error: `Task '${taskId}' is already running` },
			{ status: 409 }
		);
	}

	// For streaming-related tasks, fetch the Media Streaming API Key
	let streamingApiKey: string | null = null;
	if (taskDef.id === 'update-strm-urls' && locals.user) {
		streamingApiKey = await getUserStreamingApiKey(locals.user.id);
		if (!streamingApiKey) {
			return Response.json(
				{
					success: false,
					error: 'Media Streaming API Key not found. Generate API keys in Settings > System.'
				},
				{ status: 400 }
			);
		}
		logger.info(
			{
				userId: locals.user.id
			},
			'[TaskRunAPI] Retrieved Media Streaming API Key for user'
		);
	}

	logger.info({ taskId, endpoint: taskDef.runEndpoint }, '[TaskRunAPI] Starting task');

	// Start tracking the task
	let historyId: string;
	try {
		historyId = await taskHistoryService.startTask(taskId);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to start task';
		return Response.json({ success: false, error: message }, { status: 500 });
	}

	// Emit SSE event: task started
	monitoringScheduler.emit('manualTaskStarted', taskId);

	try {
		// Build request body with API key if available
		const requestBody: Record<string, unknown> = {};
		if (streamingApiKey) {
			requestBody.apiKey = streamingApiKey;
		}

		// Execute the task's endpoint
		const response = await fetch(taskDef.runEndpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				// Forward relevant headers from original request
				...(request.headers.get('cookie') ? { cookie: request.headers.get('cookie')! } : {})
			},
			body: Object.keys(requestBody).length > 0 ? JSON.stringify(requestBody) : undefined
		});

		const result = await response.json();

		if (result.success) {
			await taskHistoryService.completeTask(historyId, result);
			const summary = buildResultSummary(result as Record<string, unknown>);
			logger.info({ taskId, summary }, '[TaskRunAPI] Task completed successfully');

			// Emit SSE event: task completed
			// Build a TaskResult-compatible object for the SSE handler
			const summarySource = getSummarySource(result as Record<string, unknown>);
			monitoringScheduler.emit('manualTaskCompleted', taskId, {
				itemsProcessed: toNumber(summarySource.itemsProcessed ?? summarySource.totalFiles) ?? 0,
				itemsGrabbed: toNumber(summarySource.itemsGrabbed ?? summarySource.updatedFiles) ?? 0,
				errors: getErrorCount(summarySource.errors)
			});

			return Response.json({ success: true, historyId, ...result });
		} else {
			const errors = [result.error || 'Task endpoint returned failure'];
			await taskHistoryService.failTask(historyId, errors);
			logger.error({ taskId, errors }, '[TaskRunAPI] Task failed');

			// Emit SSE event: task failed
			monitoringScheduler.emit('manualTaskFailed', taskId, new Error(errors[0]));

			return Response.json({ success: false, historyId, ...result });
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		await taskHistoryService.failTask(historyId, [message]);
		logger.error({ taskId, error: message }, '[TaskRunAPI] Task execution error');

		// Emit SSE event: task failed
		monitoringScheduler.emit('manualTaskFailed', taskId, error);

		return Response.json({ success: false, historyId, error: message }, { status: 500 });
	}
};
