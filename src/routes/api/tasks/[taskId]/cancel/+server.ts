/**
 * Task Cancel Endpoint
 *
 * POST /api/tasks/[taskId]/cancel
 *
 * Cancels a running task. The task will stop at the next safe checkpoint
 * and preserve any work completed before cancellation.
 */

import type { RequestHandler } from './$types';
import { getUnifiedTaskById } from '#lib/server/tasks/UnifiedTaskRegistry.js';
import { taskHistoryService } from '#lib/server/tasks/TaskHistoryService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'TaskCancelAPI' });

export const POST: RequestHandler = async ({ params }) => {
	const { taskId } = params;

	// Validate task exists in registry
	const taskDef = getUnifiedTaskById(taskId);
	if (!taskDef) {
		return Response.json({ success: false, error: `Task '${taskId}' not found` }, { status: 404 });
	}

	// Check if task is running
	if (!taskHistoryService.isTaskRunning(taskId)) {
		return Response.json(
			{ success: false, error: `Task '${taskId}' is not running` },
			{ status: 400 }
		);
	}

	logger.info({ taskId }, '[TaskCancelAPI] Cancelling task');

	try {
		const cancelled = await taskHistoryService.cancelTask(taskId);

		if (cancelled) {
			logger.info({ taskId }, '[TaskCancelAPI] Task cancelled successfully');
			return Response.json({ success: true, message: `Task '${taskId}' cancelled` });
		} else {
			return Response.json(
				{ success: false, error: `Failed to cancel task '${taskId}'` },
				{ status: 500 }
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to cancel task';
		logger.error({ taskId, error: message }, '[TaskCancelAPI] Error cancelling task');
		return Response.json({ success: false, error: message }, { status: 500 });
	}
};
