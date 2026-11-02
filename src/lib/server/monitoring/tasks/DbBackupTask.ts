import { sqlite } from '#lib/server/db/index.js';
import { dbBackupService } from '#lib/server/db/DbBackupService.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';

const logger = createChildLogger({ module: 'DbBackupTask', logDomain: 'monitoring' });

export async function executeDbBackupTask(ctx: TaskExecutionContext | null): Promise<TaskResult> {
	const executedAt = new Date();
	logger.info('[DbBackupTask] Starting scheduled database backup');

	const settings = await dbBackupService.getSettings();
	if (!settings.enabled) {
		logger.info('[DbBackupTask] Scheduled backups disabled — skipping');
		return { taskType: 'dbBackup', itemsProcessed: 0, itemsGrabbed: 0, errors: 0, executedAt };
	}

	ctx?.checkCancelled();

	const { sizeBytes } = await dbBackupService.runScheduledBackup(sqlite);

	logger.info({ sizeBytes }, '[DbBackupTask] Scheduled database backup complete');
	return { taskType: 'dbBackup', itemsProcessed: 1, itemsGrabbed: 0, errors: 0, executedAt };
}
