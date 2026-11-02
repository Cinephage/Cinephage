/**
 * Task Enabled API
 *
 * PUT /api/tasks/[taskId]/enabled - Enable or disable a task
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getUnifiedTaskById } from '#lib/server/tasks/UnifiedTaskRegistry.js';
import { taskSettingsService } from '#lib/server/tasks/TaskSettingsService.js';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { z } from 'zod';

const bodySchema = z.object({
	enabled: z.boolean()
});

/**
 * PUT /api/tasks/[taskId]/enabled
 *
 * Enable or disable a task.
 * Disabled tasks will not run automatically.
 *
 * Body: { enabled: boolean }
 */
export const PUT: RequestHandler = async ({ params, request }) => {
	const { taskId } = params;

	// Verify task exists
	const task = getUnifiedTaskById(taskId);
	if (!task) {
		throw error(404, `Task '${taskId}' not found`);
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
		throw error(400, parseResult.error.issues[0]?.message ?? 'Invalid enabled value');
	}

	const { enabled } = parseResult.data;

	// Update the setting using TaskSettingsService
	try {
		await taskSettingsService.setTaskEnabled(taskId, enabled);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Failed to update task state';
		throw error(400, message);
	}

	// Emit settings change event for SSE clients
	monitoringScheduler.emit('taskSettingsUpdated', { taskId, enabled });

	return Response.json({
		success: true,
		taskId,
		enabled
	});
};
