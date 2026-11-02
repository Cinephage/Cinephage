import type { ActivityFilters, ActivityStatus, ActivityScope } from '#lib/types/activity.js';
import type { MoveTaskRecord } from './types.js';

export function mapFilterStatusToQueueStatuses(status: string): string[] | null {
	switch (status) {
		case 'downloading':
			return [
				'downloading',
				'queued',
				'stalled',
				'awaiting',
				'completed',
				'postprocessing',
				'importing'
			];
		case 'seeding':
			return ['seeding', 'seeding-imported'];
		case 'paused':
			return ['paused'];
		case 'failed':
			return ['failed'];
		case 'success':
			return [];
		default:
			return null;
	}
}

export function mapFilterStatusToHistoryStatuses(status: string): string[] | null {
	switch (status) {
		case 'success':
			return ['imported'];
		case 'failed':
			return ['failed'];
		case 'search_error':
			return [];
		case 'removed':
			return ['removed'];
		case 'rejected':
			return ['rejected'];
		case 'downloading':
		case 'seeding':
		case 'paused':
		case 'no_results':
			return [];
		default:
			return null;
	}
}

export function mapMoveStatusesForScopeAndFilter(
	scope: ActivityScope,
	status: ActivityFilters['status'] | 'all'
): Array<'running' | 'completed' | 'failed' | 'cancelled'> {
	let base: Array<'running' | 'completed' | 'failed' | 'cancelled'>;
	if (scope === 'active') {
		base = ['running'];
	} else if (scope === 'history') {
		base = ['completed', 'failed', 'cancelled'];
	} else {
		base = ['running', 'completed', 'failed', 'cancelled'];
	}

	switch (status) {
		case 'all':
			return base;
		case 'downloading':
			return base.includes('running') ? ['running'] : [];
		case 'success':
			return base.includes('completed') ? ['completed'] : [];
		case 'failed':
			return base.includes('failed') ? ['failed'] : [];
		case 'removed':
			return base.includes('cancelled') ? ['cancelled'] : [];
		case 'seeding':
		case 'paused':
		case 'search_error':
		case 'rejected':
		case 'no_results':
		case 'streaming':
		case 'searching':
		case 'imported':
			return [];
		default:
			return base;
	}
}

export function mapMoveTaskStatus(
	status: MoveTaskRecord['status']
): Extract<ActivityStatus, 'downloading' | 'imported' | 'failed' | 'removed'> {
	switch (status) {
		case 'running':
			return 'downloading';
		case 'completed':
			return 'imported';
		case 'failed':
			return 'failed';
		case 'cancelled':
			return 'removed';
	}
}
