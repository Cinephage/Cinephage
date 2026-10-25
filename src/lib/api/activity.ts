import type { ActivitySummary, UnifiedActivity } from '#lib/types/activity.js';

import { apiGet, apiPost, apiPut, apiDelete } from './client.js';

/** Response of GET /api/activity. */
export interface ActivityListResponse {
	activities: UnifiedActivity[];
	total: number;
	hasMore: boolean;
	summary: ActivitySummary | null;
	failedCount: number;
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
