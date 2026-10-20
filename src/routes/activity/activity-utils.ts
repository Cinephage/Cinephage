/**
 * Pure utility functions for the Activity page.
 *
 * These are stateless helpers extracted from +page.svelte so they
 * can be tested in isolation and reused by sub-components.
 */

import type {
	ActivityFilters as FiltersType,
	ActivityStatus,
	UnifiedActivity
} from '#lib/types/activity.js';
import { isActiveActivity } from '#lib/types/activity.js';
import {
	ACTIVE_TAB_STATUSES,
	BASE_FILTERS,
	HISTORY_TAB_STATUSES,
	type ActivityTab,
	type QueueCardStats
} from './activity-constants.js';

// ── Filter helpers ────────────────────────────────────────────────────

export function createDefaultFilters(): FiltersType {
	return { ...BASE_FILTERS };
}

export function getAllowedStatuses(tab: ActivityTab): NonNullable<FiltersType['status']>[] {
	return tab === 'active' ? ACTIVE_TAB_STATUSES : HISTORY_TAB_STATUSES;
}

export function normalizeFiltersForTab(nextFilters: FiltersType, tab: ActivityTab): FiltersType {
	const normalized = { ...nextFilters };
	const status = normalized.status ?? 'all';
	if (!getAllowedStatuses(tab).includes(status)) {
		normalized.status = 'all';
	}

	if (tab === 'active') {
		normalized.includeNoResults = undefined;
	}

	return normalized;
}

// ── Activity classification ───────────────────────────────────────────

export function isHistoryActivity(activity: UnifiedActivity): boolean {
	const isHistoryRow =
		activity.id.startsWith('history-') ||
		activity.id.startsWith('monitoring-') ||
		activity.id.startsWith('task-');
	if (!isHistoryRow) return false;

	return true;
}

export function isQueueActivityId(activityId: string): boolean {
	return activityId.startsWith('queue-');
}

// ── Normalization ─────────────────────────────────────────────────────

export function normalizeActivityStatus(status: unknown): ActivityStatus {
	switch (status) {
		case 'imported':
		case 'streaming':
		case 'downloading':
		case 'seeding':
		case 'paused':
		case 'failed':
		case 'search_error':
		case 'rejected':
		case 'removed':
		case 'no_results':
		case 'searching':
			return status;
		default:
			return 'downloading';
	}
}

export function normalizeActivity(activity: Partial<UnifiedActivity>): UnifiedActivity | null {
	if (!activity.id) return null;

	// Infer activitySource from id prefix if not provided
	const activitySource =
		activity.activitySource ??
		(activity.id.startsWith('queue-')
			? 'queue'
			: activity.id.startsWith('monitoring-')
				? 'monitoring'
				: activity.id.startsWith('task-')
					? 'task'
					: 'download_history');

	return {
		id: activity.id,
		activitySource,
		taskType: activity.taskType,
		mediaType: activity.mediaType === 'episode' ? 'episode' : 'movie',
		mediaId: activity.mediaId ?? '',
		mediaTitle: activity.mediaTitle ?? 'Unknown',
		mediaYear: activity.mediaYear ?? null,
		seriesId: activity.seriesId,
		seriesTitle: activity.seriesTitle,
		seasonNumber: activity.seasonNumber,
		episodeNumber: activity.episodeNumber,
		episodeIds: activity.episodeIds,
		releaseTitle: activity.releaseTitle ?? null,
		quality: activity.quality ?? null,
		releaseGroup: activity.releaseGroup ?? null,
		size: activity.size ?? null,
		indexerId: activity.indexerId ?? null,
		indexerName: activity.indexerName ?? null,
		protocol: activity.protocol ?? null,
		downloadClientId: activity.downloadClientId ?? null,
		downloadClientName: activity.downloadClientName ?? null,
		status: normalizeActivityStatus(activity.status),
		queueStatus: activity.queueStatus,
		statusReason: activity.statusReason,
		downloadProgress: activity.downloadProgress,
		isUpgrade: activity.isUpgrade ?? false,
		oldScore: activity.oldScore,
		newScore: activity.newScore,
		timeline: Array.isArray(activity.timeline) ? activity.timeline : [],
		startedAt: activity.startedAt ?? new Date().toISOString(),
		completedAt: activity.completedAt ?? null,
		lastAttemptAt: activity.lastAttemptAt ?? null,
		queueItemId: activity.queueItemId,
		downloadHistoryId: activity.downloadHistoryId,
		monitoringHistoryId: activity.monitoringHistoryId,
		importedPath: activity.importedPath
	};
}

// ── Sorting ───────────────────────────────────────────────────────────

export function compareActivityPriority(a: UnifiedActivity, b: UnifiedActivity): number {
	const aPriority = a.status === 'downloading' || a.status === 'seeding' ? 0 : 1;
	const bPriority = b.status === 'downloading' || b.status === 'seeding' ? 0 : 1;
	return aPriority - bPriority;
}

export function getSortValue(activity: UnifiedActivity, field: string): string | number {
	switch (field) {
		case 'time': {
			// For completed items, sort by completion time
			if (
				activity.completedAt &&
				(activity.status === 'imported' ||
					activity.status === 'streaming' ||
					activity.status === 'removed' ||
					activity.status === 'rejected' ||
					activity.status === 'no_results' ||
					activity.status === 'search_error')
			) {
				return activity.completedAt;
			}
			// For failed/search_error items, use the most recent attempt time if available
			if (
				(activity.status === 'failed' || activity.status === 'search_error') &&
				activity.lastAttemptAt
			) {
				return activity.lastAttemptAt;
			}
			// For active items, use startedAt
			return activity.startedAt;
		}
		case 'media':
			return activity.mediaTitle.toLowerCase();
		case 'size':
			return activity.size || 0;
		case 'status':
			return activity.status;
		case 'release':
			return activity.releaseTitle?.toLowerCase() || '';
		default:
			return activity.startedAt;
	}
}

export function sortActivitiesList(
	list: UnifiedActivity[],
	field: string,
	direction: 'asc' | 'desc'
): UnifiedActivity[] {
	return [...list].sort((a, b) => {
		const priorityComparison = compareActivityPriority(a, b);
		if (priorityComparison !== 0) {
			return priorityComparison;
		}

		const aVal = getSortValue(a, field);
		const bVal = getSortValue(b, field);

		let comparison = 0;
		if (aVal < bVal) comparison = -1;
		if (aVal > bVal) comparison = 1;

		if (comparison === 0) {
			const aTime = new Date(a.startedAt).getTime();
			const bTime = new Date(b.startedAt).getTime();
			comparison = aTime < bTime ? -1 : aTime > bTime ? 1 : 0;
		}

		return direction === 'asc' ? comparison : -comparison;
	});
}

// ── Queue stats parsing ───────────────────────────────────────────────

export function readQueueStatsNumber(value: unknown): number {
	const numeric = typeof value === 'number' ? value : Number(value ?? 0);
	return Number.isFinite(numeric) ? numeric : 0;
}

export function parseQueueStats(
	rawStats: Partial<QueueCardStats> | null | undefined
): QueueCardStats {
	return {
		totalCount: readQueueStatsNumber(rawStats?.totalCount),
		downloadingCount: readQueueStatsNumber(rawStats?.downloadingCount),
		seedingCount: readQueueStatsNumber(rawStats?.seedingCount),
		pausedCount: readQueueStatsNumber(rawStats?.pausedCount),
		failedCount: readQueueStatsNumber(rawStats?.failedCount)
	};
}

export function createDefaultQueueCardStats(): QueueCardStats {
	return {
		totalCount: 0,
		downloadingCount: 0,
		seedingCount: 0,
		pausedCount: 0,
		failedCount: 0
	};
}

// ── URL query string builder ──────────────────────────────────────────

export function buildFilterQueryString(f: FiltersType, tab: ActivityTab): string {
	const params = new URLSearchParams();
	params.set('tab', tab);
	if (f.status !== 'all') params.set('status', f.status!);
	if (f.mediaType !== 'all') params.set('mediaType', f.mediaType!);
	if (f.search) params.set('search', f.search);
	if (f.protocol !== 'all') params.set('protocol', f.protocol!);
	if (f.indexer) params.set('indexer', f.indexer);
	if (f.releaseGroup) params.set('releaseGroup', f.releaseGroup);
	if (f.resolution) params.set('resolution', f.resolution);
	if (f.isUpgrade) params.set('isUpgrade', 'true');
	if (f.includeNoResults) params.set('includeNoResults', 'true');
	if (f.downloadClientId) params.set('downloadClientId', f.downloadClientId);
	if (f.startDate) params.set('startDate', f.startDate);
	if (f.endDate) params.set('endDate', f.endDate);
	return params.toString();
}

export function buildActivityApiQueryString(
	f: FiltersType,
	tab: ActivityTab,
	options: { limit?: number; offset?: number } = {}
): string {
	const params = new URLSearchParams(buildFilterQueryString(f, tab));
	params.delete('tab');
	params.set('scope', tab);
	if (options.limit !== undefined) params.set('limit', String(options.limit));
	if (options.offset !== undefined) params.set('offset', String(options.offset));
	return params.toString();
}

function getActivityFilterTime(activity: UnifiedActivity): number {
	const candidate = activity.lastAttemptAt || activity.completedAt || activity.startedAt;
	const time = new Date(candidate).getTime();
	return Number.isFinite(time) ? time : 0;
}

export function matchesActivityFilters(
	activity: UnifiedActivity,
	filters: FiltersType,
	tab: ActivityTab
): boolean {
	const inScope = tab === 'active' ? isActiveActivity(activity) : !isActiveActivity(activity);
	if (!inScope) return false;

	const status = filters.status ?? 'all';
	if (status !== 'all') {
		if (status === 'success') {
			if (activity.status !== 'imported') return false;
		} else if (activity.status !== status) {
			return false;
		}
	}

	if (filters.mediaType === 'movie' && activity.mediaType !== 'movie') return false;
	if (filters.mediaType === 'tv' && activity.mediaType !== 'episode') return false;

	if (filters.protocol && filters.protocol !== 'all' && activity.protocol !== filters.protocol) {
		return false;
	}

	if (filters.indexer) {
		if ((activity.indexerName ?? '').toLowerCase() !== filters.indexer.toLowerCase()) return false;
	}

	if (filters.downloadClientId && activity.downloadClientId !== filters.downloadClientId) {
		return false;
	}

	if (filters.search) {
		const searchLower = filters.search.toLowerCase();
		const matchesSearch =
			activity.mediaTitle.toLowerCase().includes(searchLower) ||
			activity.releaseTitle?.toLowerCase().includes(searchLower) ||
			activity.seriesTitle?.toLowerCase().includes(searchLower) ||
			activity.releaseGroup?.toLowerCase().includes(searchLower) ||
			activity.indexerName?.toLowerCase().includes(searchLower);
		if (!matchesSearch) return false;
	}

	if (filters.releaseGroup) {
		if (!activity.releaseGroup?.toLowerCase().includes(filters.releaseGroup.toLowerCase())) {
			return false;
		}
	}

	if (filters.resolution) {
		if (activity.quality?.resolution?.toLowerCase() !== filters.resolution.toLowerCase()) {
			return false;
		}
	}

	if (filters.isUpgrade !== undefined && activity.isUpgrade !== filters.isUpgrade) {
		return false;
	}

	if (tab === 'history' && !filters.includeNoResults && activity.status === 'no_results') {
		return false;
	}

	const activityTime = getActivityFilterTime(activity);
	if (filters.startDate) {
		const startTime = new Date(filters.startDate).getTime();
		if (Number.isFinite(startTime) && activityTime < startTime) return false;
	}
	if (filters.endDate) {
		const endTime = new Date(`${filters.endDate}T23:59:59.999`).getTime();
		if (Number.isFinite(endTime) && activityTime > endTime) return false;
	}

	return true;
}

// ── Queue action error parsing ────────────────────────────────────────

export async function getQueueActionErrorMessage(
	response: Response,
	fallback: string
): Promise<string> {
	let message = fallback;
	try {
		const payload = await response.json();
		if (payload?.message && typeof payload.message === 'string') {
			message = payload.message;
		} else if (payload?.error && typeof payload.error === 'string') {
			message = payload.error;
		}
	} catch {
		// Ignore JSON parse errors and fall back to default message.
	}
	return message;
}
