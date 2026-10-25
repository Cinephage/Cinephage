/**
 * Task Interval API
 *
 * PUT /api/tasks/[taskId]/interval - Updates the interval for a scheduled task
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getUnifiedTaskById,
	isScheduledTask,
	isIntervalEditable
} from '#lib/server/tasks/UnifiedTaskRegistry.js';
import { taskSettingsService } from '#lib/server/tasks/TaskSettingsService.js';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { z } from 'zod';

const bodySchema = z.object({
	intervalHours: z.number().positive()
});

/**
 * PUT /api/tasks/[taskId]/interval
 *
 * Updates the interval for a scheduled task.
 * Only works for scheduled tasks with editable intervals.
 *
 * Body: { intervalHours: number }
 */
export const PUT: RequestHandler = async ({ params, request }) => {
	const { taskId } = params;

	// Verify task exists
	const task = getUnifiedTaskById(taskId);
	if (!task) {
		throw error(404, `Task '${taskId}' not found`);
	}

	// Verify it's a scheduled task
	if (!isScheduledTask(taskId)) {
		throw error(400, `Task '${taskId}' is not a scheduled task`);
	}

	// Verify interval is editable
	if (!isIntervalEditable(taskId)) {
		throw error(400, `Task '${taskId}' interval cannot be edited`);
	}

	// Parse body
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const parseResult = bodySchema.safeParse(body);
	if (!parseResult.success) {
		throw error(400, parseResult.error.issues[0]?.message ?? 'Invalid interval');
	}

	const { intervalHours } = parseResult.data;

	// Validate minimum interval
	const minInterval = task.minIntervalHours ?? 0.25;
	if (intervalHours < minInterval) {
		throw error(
			400,
			`Interval must be at least ${minInterval} hours (${minInterval * 60} minutes)`
		);
	}

	// Update the setting using TaskSettingsService
	try {
		await taskSettingsService.setTaskInterval(taskId, intervalHours);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Failed to update interval';
		throw error(400, message);
	}

	// Get the updated next run time to send to SSE clients
	const nextRunTime = await taskSettingsService.getNextRunTime(taskId);

	// Emit settings change event for SSE clients
	monitoringScheduler.emit('taskSettingsUpdated', {
		taskId,
		intervalHours,
		nextRunTime
	});

	return Response.json({
		success: true,
		taskId,
		intervalHours
	});
};
