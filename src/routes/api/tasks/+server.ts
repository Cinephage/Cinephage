/**
 * Unified Tasks API
 *
 * GET /api/tasks - Returns all tasks with their current status
 */

import type { RequestHandler } from './$types';
import {
	UNIFIED_TASK_DEFINITIONS,
	type UnifiedTask,
	type UnifiedTaskDefinition
} from '#lib/server/tasks/UnifiedTaskRegistry.js';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { taskHistoryService } from '#lib/server/tasks/TaskHistoryService.js';
import { taskSettingsService } from '#lib/server/tasks/TaskSettingsService.js';

/**
 * GET /api/tasks
 *
 * Returns all unified tasks with their current status including:
 * - Task definitions (name, description, category)
 * - Runtime status (lastRunTime, nextRunTime, intervalHours, isRunning, enabled)
 */
export const GET: RequestHandler = async () => {
	// Get monitoring status for scheduled tasks
	const monitoringStatus = await monitoringScheduler.getStatus();

	// Build unified task list with status
	const tasks: UnifiedTask[] = await Promise.all(
		UNIFIED_TASK_DEFINITIONS.map(async (def: UnifiedTaskDefinition) => {
			// Get settings from TaskSettingsService
			const settings = await taskSettingsService.getTaskSettings(def.id);
			const enabled = settings?.enabled ?? true;

			if (def.category === 'scheduled') {
				// Get status from MonitoringScheduler
				const taskKey = def.id as keyof typeof monitoringStatus.tasks;
				const status = monitoringStatus.tasks[taskKey];

				return {
					...def,
					lastRunTime: status?.lastRunTime?.toISOString() ?? null,
					nextRunTime: status?.nextRunTime?.toISOString() ?? null,
					intervalHours:
						settings?.intervalHours ?? status?.intervalHours ?? def.defaultIntervalHours ?? null,
					isRunning: status?.isRunning ?? false,
					enabled
				};
			} else {
				// Get status from TaskHistoryService for maintenance tasks
				const lastRun = await taskHistoryService.getLastRunForTask(def.id);
				const isRunning = taskHistoryService.isTaskRunning(def.id);

				return {
					...def,
					lastRunTime: lastRun?.completedAt ?? lastRun?.startedAt ?? null,
					nextRunTime: null, // Manual tasks don't have scheduled next runs
					intervalHours: null, // Manual tasks don't have intervals
					isRunning,
					enabled
				};
			}
		})
	);

	return Response.json({
		success: true,
		tasks
	});
};
