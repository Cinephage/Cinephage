import type { RequestHandler } from './$types';
import { createSSEStream } from '#lib/server/sse.js';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { mediaResolver } from '#lib/server/activity/index.js';
import { activityStreamEvents } from '#lib/server/activity/ActivityStreamEvents.js';
import type { UnifiedActivity, ActivityStatus } from '#lib/types/activity.js';
import type { ActivityRefreshEvent } from '#lib/types/sse/events/activity-events.js';
import { createChildLogger } from '#lib/logging/index.js';
import { mapQueueStatus, projectQueueActivity } from '#lib/server/activity/projectors.js';

const logger = createChildLogger({ module: 'ActivityStreamApi', logDomain: 'monitoring' });

interface QueueItem {
	id: string;
	downloadClientId?: string | null;
	title: string;
	movieId?: string | null;
	seriesId?: string | null;
	episodeIds?: string[] | null;
	seasonNumber?: number | null;
	status: string;
	progress?: number;
	size?: number | null;
	indexerId?: string | null;
	indexerName?: string | null;
	protocol?: string | null;
	quality?: { resolution?: string; source?: string; codec?: string; hdr?: string } | null;
	releaseGroup?: string | null;
	addedAt: string;
	startedAt?: string | null;
	completedAt?: string | null;
	lastAttemptAt?: string | null;
	errorMessage?: string | null;
	isUpgrade?: boolean;
}

function isQueueItem(value: unknown): value is QueueItem {
	if (!value || typeof value !== 'object') return false;
	const maybe = value as Partial<QueueItem>;
	return typeof maybe.id === 'string' && typeof maybe.title === 'string';
}

function getQueueItemFromPayload(payload: unknown): QueueItem | null {
	if (isQueueItem(payload)) return payload;

	if (payload && typeof payload === 'object' && 'queueItem' in payload) {
		const wrapped = (payload as { queueItem?: unknown }).queueItem;
		if (isQueueItem(wrapped)) return wrapped;
	}

	return null;
}

function getQueueErrorFromPayload(payload: unknown): string | undefined {
	if (!payload || typeof payload !== 'object') return undefined;
	const maybeError = (payload as { error?: unknown }).error;
	return typeof maybeError === 'string' ? maybeError : undefined;
}

const mapQueueStatusToActivityStatus = mapQueueStatus;

/**
 * Server-Sent Events endpoint for real-time activity updates
 *
 * Events emitted:
 * - activity:new - New activity started (download grabbed)
 * - activity:updated - Activity status/progress changed
 * - activity:completed - Activity completed (imported/failed)
 */
export const GET: RequestHandler = async () => {
	return createSSEStream((send) => {
		// Helper to convert queue item to activity using shared resolver
		const queueItemToActivity = async (item: QueueItem): Promise<UnifiedActivity> => {
			const mediaInfo = await mediaResolver.resolveDownloadMediaInfo({
				movieId: item.movieId,
				seriesId: item.seriesId,
				episodeIds: item.episodeIds,
				seasonNumber: item.seasonNumber
			});

			return projectQueueActivity(item, mediaInfo);
		};

		// ── Progress throttling ─────────────────────────────────────────
		// Track the last status we sent for each queue item so we can
		// distinguish progress-only updates from real status changes.
		const PROGRESS_THROTTLE_MS = 1000;
		const lastProgressSentAt = new Map<string, number>();
		const lastSentStatus = new Map<string, string>();
		let progressFlushTimer: ReturnType<typeof setTimeout> | null = null;
		const pendingProgress = new Map<
			string,
			{ id: string; progress: number; status: ActivityStatus }
		>();

		function flushPendingProgress(): void {
			progressFlushTimer = null;
			const now = Date.now();
			for (const [queueId, data] of pendingProgress) {
				send('activity:progress', data);
				lastProgressSentAt.set(queueId, now);
			}
			pendingProgress.clear();
		}

		function scheduleProgressFlush(): void {
			if (progressFlushTimer !== null) return;
			progressFlushTimer = setTimeout(flushPendingProgress, PROGRESS_THROTTLE_MS);
		}

		// Event handlers
		const onQueueAdded = async (item: unknown) => {
			try {
				const queueItem = getQueueItemFromPayload(item);
				if (!queueItem) return;
				const activity = await queueItemToActivity(queueItem);
				lastSentStatus.set(queueItem.id, queueItem.status);
				send('activity:new', activity);
			} catch (error) {
				logger.error({ err: error }, '[ActivityStream] Failed to convert queue:added to activity');
			}
		};

		const onQueueUpdated = async (item: unknown) => {
			try {
				const queueItem = getQueueItemFromPayload(item);
				if (!queueItem) return;

				const prevStatus = lastSentStatus.get(queueItem.id);
				// Treat unknown-previous-status as changed so first update for any
				// item (e.g. a failed download that recovered since page load) sends
				// a full activity payload instead of a silent progress-only event.
				const statusChanged = prevStatus === undefined || prevStatus !== queueItem.status;

				if (statusChanged) {
					// Status actually changed — send the full activity payload so
					// the client can update all fields (timeline, status, etc.)
					const activity = await queueItemToActivity(queueItem);
					lastSentStatus.set(queueItem.id, queueItem.status);
					send('activity:updated', activity);
					// Also reset throttle so next progress is sent promptly
					lastProgressSentAt.delete(queueItem.id);
					return;
				}

				// Progress-only update — throttle to avoid flooding the client.
				const now = Date.now();
				const lastSent = lastProgressSentAt.get(queueItem.id) ?? 0;

				const progressData = {
					id: `queue-${queueItem.id}`,
					progress: Math.round((queueItem.progress ?? 0) * 100),
					status: mapQueueStatusToActivityStatus(queueItem.status)
				};

				if (now - lastSent >= PROGRESS_THROTTLE_MS) {
					// Enough time passed — send immediately
					send('activity:progress', progressData);
					lastProgressSentAt.set(queueItem.id, now);
					pendingProgress.delete(queueItem.id);
				} else {
					// Too soon — buffer and schedule a flush
					pendingProgress.set(queueItem.id, progressData);
					scheduleProgressFlush();
				}

				// Track status so we detect real changes next time
				lastSentStatus.set(queueItem.id, queueItem.status);
			} catch (error) {
				logger.error(
					{ err: error },
					'[ActivityStream] Failed to convert queue:updated to activity'
				);
			}
		};

		const onQueueCompleted = async (item: unknown) => {
			try {
				const queueItem = getQueueItemFromPayload(item);
				if (!queueItem) return;
				lastSentStatus.set(queueItem.id, queueItem.status);
				const activity = await queueItemToActivity(queueItem);
				send('activity:updated', activity);
			} catch (error) {
				logger.error(
					{ err: error },
					'[ActivityStream] Failed to convert queue:completed to activity'
				);
			}
		};

		const onQueueImported = async (data: unknown) => {
			try {
				const queueItem = getQueueItemFromPayload(data);
				if (!queueItem) return;
				lastSentStatus.set(queueItem.id, queueItem.status);
				const activity = await queueItemToActivity(queueItem);
				send('activity:updated', activity);
			} catch (error) {
				logger.error(
					{ err: error },
					'[ActivityStream] Failed to convert queue:imported to activity'
				);
			}
		};

		const onQueueFailed = async (data: unknown) => {
			try {
				const queueItem = getQueueItemFromPayload(data);
				if (!queueItem) return;
				lastSentStatus.set(queueItem.id, 'failed');
				const activity = await queueItemToActivity(queueItem);
				send('activity:updated', {
					...activity,
					status: 'failed',
					statusReason: getQueueErrorFromPayload(data) ?? activity.statusReason
				});
			} catch (error) {
				logger.error({ err: error }, '[ActivityStream] Failed to convert queue:failed to activity');
			}
		};

		const onActivityRefresh = (payload: ActivityRefreshEvent) => {
			send('activity:refresh', payload);
		};

		// Seed active in-progress downloads so activity rows are visible
		// even if queue:added happened before subscribe.  Send as a single
		// batch event instead of N individual activity:new messages.
		// We also populate lastSentStatus for ALL non-terminal items (including
		// failed/paused/etc.) so that onQueueUpdated can detect status changes
		// correctly when a download recovers from a failed state.
		const sendInitialQueueItems = async () => {
			try {
				const queueItems = await downloadMonitor.getQueue();
				const seedActivities: UnifiedActivity[] = [];
				for (const queueItem of queueItems) {
					const qi = queueItem as QueueItem;
					// Always register the current status so status-change detection works
					lastSentStatus.set(qi.id, qi.status);
					// Only seed downloading/seeding items as visible activity rows
					const activity = await queueItemToActivity(qi);
					if (activity.status !== 'downloading' && activity.status !== 'seeding') continue;
					seedActivities.push(activity);
				}
				if (seedActivities.length > 0) {
					send('activity:seed', seedActivities);
				}
			} catch (error) {
				logger.error({ err: error }, '[ActivityStream] Failed to send initial queue items');
			}
		};

		void sendInitialQueueItems();

		// Register handlers
		downloadMonitor.on('queue:added', onQueueAdded);
		downloadMonitor.on('queue:updated', onQueueUpdated);
		downloadMonitor.on('queue:completed', onQueueCompleted);
		downloadMonitor.on('queue:imported', onQueueImported);
		downloadMonitor.on('queue:failed', onQueueFailed);
		activityStreamEvents.on('activity:refresh', onActivityRefresh);

		// Return cleanup function
		return () => {
			if (progressFlushTimer !== null) clearTimeout(progressFlushTimer);
			downloadMonitor.off('queue:added', onQueueAdded);
			downloadMonitor.off('queue:updated', onQueueUpdated);
			downloadMonitor.off('queue:completed', onQueueCompleted);
			downloadMonitor.off('queue:imported', onQueueImported);
			downloadMonitor.off('queue:failed', onQueueFailed);
			activityStreamEvents.off('activity:refresh', onActivityRefresh);
		};
	});
};
