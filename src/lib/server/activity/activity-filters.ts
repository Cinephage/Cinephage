import {
	isActiveActivity,
	type UnifiedActivity,
	type ActivityFilters,
	type ActivitySortOptions,
	type ActivityScope,
	type ActivitySummary
} from '#lib/types/activity.js';

export const DEFAULT_ACTIVITY_RETENTION_DAYS = 90;
export const MAX_ACTIVITY_RETENTION_DAYS = 90;
const MIN_ACTIVITY_RETENTION_DAYS = 1;

export function parseRetentionDays(value: unknown): number {
	const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(numeric)) {
		return DEFAULT_ACTIVITY_RETENTION_DAYS;
	}

	return Math.max(MIN_ACTIVITY_RETENTION_DAYS, Math.min(MAX_ACTIVITY_RETENTION_DAYS, numeric));
}

export function compareActivityPriority(a: UnifiedActivity, b: UnifiedActivity): number {
	const aPriority = a.status === 'downloading' || a.status === 'seeding' ? 0 : 1;
	const bPriority = b.status === 'downloading' || b.status === 'seeding' ? 0 : 1;
	return aPriority - bPriority;
}

export function sortActivities(activities: UnifiedActivity[], sort: ActivitySortOptions): void {
	activities.sort((a, b) => {
		const priorityComparison = compareActivityPriority(a, b);
		if (priorityComparison !== 0) {
			return priorityComparison;
		}

		let comparison = 0;

		switch (sort.field) {
			case 'time':
				comparison = new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
				break;
			case 'media':
				comparison = a.mediaTitle.localeCompare(b.mediaTitle);
				break;
			case 'size':
				comparison = (b.size || 0) - (a.size || 0);
				break;
			case 'status':
				comparison = a.status.localeCompare(b.status);
				break;
		}

		if (comparison === 0) {
			comparison = new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
		}

		return sort.direction === 'asc' ? -comparison : comparison;
	});
}

export function withoutStatusFilter(filters: ActivityFilters): ActivityFilters {
	if (!filters.status || filters.status === 'all') {
		return filters;
	}

	return {
		...filters,
		status: 'all'
	};
}

export function applyRequestedStatusFilter(
	activities: UnifiedActivity[],
	filters: ActivityFilters
): UnifiedActivity[] {
	const status = filters.status ?? 'all';
	if (status === 'all') return activities;

	switch (status) {
		case 'success':
			return activities.filter((activity) => activity.status === 'imported');
		case 'downloading':
		case 'importing':
			return activities.filter((activity) => activity.status === status);
		case 'failed':
		case 'search_error':
		case 'seeding':
		case 'paused':
		case 'removed':
		case 'rejected':
		case 'no_results':
			return activities.filter((activity) => activity.status === status);
		default:
			return activities;
	}
}

export function createEmptySummary(): ActivitySummary {
	return {
		totalCount: 0,
		downloadingCount: 0,
		importingCount: 0,
		seedingCount: 0,
		pausedCount: 0,
		failedCount: 0
	};
}

export function buildActivitySummary(activeActivities: UnifiedActivity[]): ActivitySummary {
	const summary = createEmptySummary();

	for (const activity of activeActivities) {
		summary.totalCount += 1;
		switch (activity.status) {
			case 'seeding':
				summary.seedingCount += 1;
				break;
			case 'paused':
				summary.pausedCount += 1;
				break;
			case 'failed':
				summary.failedCount += 1;
				break;
			case 'importing':
				summary.importingCount += 1;
				break;
			default:
				summary.downloadingCount += 1;
				break;
		}
	}

	return summary;
}

export function applyFilters(
	activities: UnifiedActivity[],
	filters: ActivityFilters,
	scope: ActivityScope = 'all'
): UnifiedActivity[] {
	let filtered = activities;

	if (scope === 'active') {
		filtered = filtered.filter((activity) => isActiveActivity(activity));
	} else if (scope === 'history') {
		filtered = filtered.filter((activity) => !isActiveActivity(activity));
	}

	if (filters.search) {
		const searchLower = filters.search.toLowerCase();
		filtered = filtered.filter(
			(a) =>
				a.mediaTitle.toLowerCase().includes(searchLower) ||
				a.releaseTitle?.toLowerCase().includes(searchLower) ||
				a.seriesTitle?.toLowerCase().includes(searchLower) ||
				a.releaseGroup?.toLowerCase().includes(searchLower) ||
				a.indexerName?.toLowerCase().includes(searchLower)
		);
	}

	if (filters.releaseGroup) {
		filtered = filtered.filter((a) =>
			a.releaseGroup?.toLowerCase().includes(filters.releaseGroup!.toLowerCase())
		);
	}

	if (filters.resolution) {
		filtered = filtered.filter(
			(a) => a.quality?.resolution?.toLowerCase() === filters.resolution?.toLowerCase()
		);
	}

	if (filters.isUpgrade !== undefined) {
		filtered = filtered.filter((a) => a.isUpgrade === filters.isUpgrade);
	}

	return filtered;
}
