import type { ActivitySummary, UnifiedActivity } from '#lib/types/activity.js';
import type {
	SearchActivityItem,
	SearchItemDetail
} from '#lib/server/activity/activity-transformers.js';

import { apiGet, apiPost, apiPut, apiDelete } from './client.js';

/** Response of GET /api/activity. */
export interface ActivityListResponse {
	activities: UnifiedActivity[];
	total: number;
	hasMore: boolean;
	summary: ActivitySummary | null;
	failedCount: number;
}

/** Response of GET /api/monitoring/search-activity. */
export interface SearchActivityListResponse {
	items: SearchActivityItem[];
	total: number;
	maxConsecutiveFailures: number;
	globallyPaused: boolean;
}

/** Response of GET /api/monitoring/search-activity/item. */
export interface SearchItemDetailResponse {
	item: SearchItemDetail;
}

/** Response of GET /api/activity/settings. */
export interface ActivitySettingsResponse {
	retentionDays: number;
	defaultRetentionDays: number;
	maxRetentionDays: number;
}

export async function getActivity(filters: Record<string, string>) {
	return apiGet<ActivityListResponse>('/api/activity', filters);
}

export async function getSearchActivity(filters: Record<string, string> = {}) {
	return apiGet<SearchActivityListResponse>('/api/monitoring/search-activity', filters);
}

export async function resetSearchFailures(movieIds: string[], episodeIds: string[]) {
	return apiPost('/api/monitoring/search-activity/reset-failures', { movieIds, episodeIds });
}

export async function getSearchItemDetail(target: { movieId?: string; episodeId?: string }) {
	const params: Record<string, string> = {};
	if (target.movieId) params.movieId = target.movieId;
	if (target.episodeId) params.episodeId = target.episodeId;
	return apiGet<SearchItemDetailResponse>('/api/monitoring/search-activity/item', params);
}

export async function setSearchItemPaused(
	movieIds: string[],
	episodeIds: string[],
	paused: boolean
) {
	return apiPost('/api/monitoring/search-activity/pause', { movieIds, episodeIds, paused });
}

export async function setGlobalSearchPaused(paused: boolean) {
	return apiPost('/api/monitoring/search-activity/global-pause', { paused });
}

export async function deleteActivity(activityIds: string[]) {
	return apiDelete('/api/activity', { activityIds });
}

export async function getActivitySettings() {
	return apiGet<ActivitySettingsResponse>('/api/activity/settings');
}

export async function setRetentionDays(retentionDays: number) {
	return apiPut<ActivitySettingsResponse>('/api/activity/settings', { retentionDays });
}

export async function purgeHistory(
	action: 'older_than_retention' | 'all',
	options?: { removeFromClient?: boolean }
) {
	return apiPost('/api/activity/settings', {
		action,
		removeFromClient: options?.removeFromClient ?? false
	});
}
