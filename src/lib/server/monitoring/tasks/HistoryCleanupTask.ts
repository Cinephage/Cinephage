/**
 * History Cleanup Task
 *
 * Automatically purges old history entries based on the user-configured retention period.
 * Cleans up:
 * - monitoring_history (activity records)
 * - download_history (download records)
 * - task_history (task execution records)
 * - subtitle_history (subtitle download/upgrade records)
 *
 * Runs daily (default: every 24 hours) to keep the database lean.
 */

import { db } from '#lib/server/db/index.js';
import { subtitleHistory } from '#lib/server/db/schema.js';
import { lt } from 'drizzle-orm';
import { ActivityService } from '#lib/server/activity/ActivityService.js';
import { getTaskHistoryService } from '#lib/server/tasks/TaskHistoryService.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';

const logger = createChildLogger({ module: 'HistoryCleanupTask', logDomain: 'monitoring' });

/**
 * Default retention period for task history (days).
 * Activity history uses the user-configured setting from ActivityService.
 */
const DEFAULT_TASK_HISTORY_RETENTION_DAYS = 30;

/**
 * Execute history cleanup task.
 * Purges old records from all history tables based on retention settings.
 *
 * @param ctx - Execution context for cancellation support
 */
export async function executeHistoryCleanupTask(
	ctx: TaskExecutionContext | null
): Promise<TaskResult> {
	const executedAt = new Date();
	logger.info('[HistoryCleanupTask] Starting automated history cleanup');

	let totalDeleted = 0;
	const errors = 0;

	try {
		ctx?.checkCancelled();

		// 1. Clean up activity history (monitoring_history + download_history)
		// Uses the user-configured retention setting
		const activityService = ActivityService.getInstance();
		const retentionDays = await activityService.getRetentionDays();

		logger.info(
			{ retentionDays },
			'[HistoryCleanupTask] Purging activity history older than retention period'
		);

		const activityResult = await activityService.purgeHistoryOlderThan(retentionDays);
		totalDeleted += activityResult.totalDeleted;

		if (activityResult.totalDeleted > 0) {
			logger.info(
				{
					deletedDownloadHistory: activityResult.deletedDownloadHistory,
					deletedMonitoringHistory: activityResult.deletedMonitoringHistory,
					cutoff: activityResult.cutoff
				},
				'[HistoryCleanupTask] Activity history purged'
			);
		}

		ctx?.checkCancelled();

		// 2. Clean up task history (task_history table)
		const taskHistoryService = getTaskHistoryService();
		const taskHistoryDeleted = await taskHistoryService.cleanupOldHistory(
			DEFAULT_TASK_HISTORY_RETENTION_DAYS
		);
		totalDeleted += taskHistoryDeleted;

		if (taskHistoryDeleted > 0) {
			logger.info({ deletedCount: taskHistoryDeleted }, '[HistoryCleanupTask] Task history purged');
		}

		ctx?.checkCancelled();

		// 3. Clean up subtitle history
		const subtitleCutoff = new Date();
		subtitleCutoff.setDate(subtitleCutoff.getDate() - retentionDays);
		const subtitleCutoffIso = subtitleCutoff.toISOString();

		const deletedSubtitleHistory = await db
			.delete(subtitleHistory)
			.where(lt(subtitleHistory.createdAt, subtitleCutoffIso))
			.returning({ id: subtitleHistory.id });

		const subtitleDeleted = deletedSubtitleHistory.length;
		totalDeleted += subtitleDeleted;

		if (subtitleDeleted > 0) {
			logger.info(
				{ deletedCount: subtitleDeleted },
				'[HistoryCleanupTask] Subtitle history purged'
			);
		}

		logger.info(
			{
				totalDeleted,
				retentionDays,
				activityDeleted: activityResult.totalDeleted,
				taskHistoryDeleted,
				subtitleHistoryDeleted: subtitleDeleted
			},
			'[HistoryCleanupTask] History cleanup completed'
		);

		return {
			taskType: 'historyCleanup',
			itemsProcessed: totalDeleted,
			itemsGrabbed: 0,
			errors,
			executedAt
		};
	} catch (error) {
		logger.error({ err: error }, '[HistoryCleanupTask] History cleanup failed');
		throw error;
	}
}
