import type { downloadQueue, downloadHistory, monitoringHistory } from '#lib/server/db/schema.js';

// Export inferred types from Drizzle schema
export type DownloadQueueRecord = typeof downloadQueue.$inferSelect;
export type DownloadHistoryRecord = typeof downloadHistory.$inferSelect;
export type MonitoringHistoryRecord = typeof monitoringHistory.$inferSelect;

export interface MoveTaskRecord {
	id: string;
	taskId: string;
	status: 'running' | 'completed' | 'failed' | 'cancelled';
	results: Record<string, unknown> | null;
	errors: string[] | null;
	startedAt: string | null;
	completedAt: string | null;
}
