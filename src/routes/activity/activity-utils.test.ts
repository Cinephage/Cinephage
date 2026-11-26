import { describe, expect, it } from 'vitest';
import type { UnifiedActivity } from '#lib/types/activity.js';
import {
	createDefaultFilters,
	matchesActivityFilters,
	parseQueueStats,
	upsertActivityInList
} from './activity-utils.js';

function activity(id: string, overrides: Partial<UnifiedActivity> = {}): UnifiedActivity {
	return {
		id,
		activitySource: 'queue',
		mediaType: 'movie',
		mediaId: `movie-${id}`,
		mediaTitle: `Movie ${id}`,
		mediaYear: 2025,
		releaseTitle: `Movie.${id}.2025.1080p.WEB-DL-GRP`,
		quality: null,
		releaseGroup: 'GRP',
		size: null,
		indexerId: null,
		indexerName: null,
		protocol: 'torrent',
		status: 'downloading',
		isUpgrade: false,
		timeline: [],
		startedAt: '2026-11-20T00:00:00.000Z',
		completedAt: null,
		...overrides
	};
}

describe('parseQueueStats', () => {
	it('puts importing rows under Downloading so Total is the sum of the tiles', () => {
		const stats = parseQueueStats({
			totalCount: 5,
			downloadingCount: 2,
			importingCount: 1,
			seedingCount: 1,
			pausedCount: 1,
			failedCount: 4
		} as Parameters<typeof parseQueueStats>[0]);

		expect(stats.downloadingCount).toBe(3);
		expect(stats.totalCount).toBe(stats.downloadingCount + stats.seedingCount + stats.pausedCount);
		expect(stats.failedCount).toBe(4);
	});

	it('reads server card stats, which have no importing count, unchanged', () => {
		const stats = parseQueueStats({
			totalCount: 4,
			downloadingCount: 2,
			seedingCount: 1,
			pausedCount: 1,
			failedCount: 0
		});

		expect(stats).toEqual({
			totalCount: 4,
			downloadingCount: 2,
			seedingCount: 1,
			pausedCount: 1,
			failedCount: 0
		});
	});
});

describe('matchesActivityFilters', () => {
	it('keeps importing rows under the downloading filter on the Active tab', () => {
		const filters = { ...createDefaultFilters(), status: 'downloading' as const };

		expect(matchesActivityFilters(activity('queue-1'), filters, 'active')).toBe(true);
		expect(
			matchesActivityFilters(activity('queue-2', { status: 'importing' }), filters, 'active')
		).toBe(true);
		expect(
			matchesActivityFilters(activity('queue-3', { status: 'seeding' }), filters, 'active')
		).toBe(false);
	});
});

describe('upsertActivityInList', () => {
	const filters = createDefaultFilters();

	it('adds a new active row and asks for the counts to be re-read', () => {
		const list = [activity('queue-1')];

		const result = upsertActivityInList(list, 1, activity('queue-2'), filters, 'active');

		expect(result.activities.map((a) => a.id)).toEqual(['queue-2', 'queue-1']);
		expect(result.total).toBe(2);
		expect(result.membershipChanged).toBe(true);
	});

	it('updates a known row in place without a refresh', () => {
		const list = [activity('queue-1')];

		const result = upsertActivityInList(
			list,
			1,
			activity('queue-1', { status: 'importing' }),
			filters,
			'active'
		);

		expect(result.activities).toBe(list);
		expect(result.activities[0].status).toBe('importing');
		expect(result.total).toBe(1);
		expect(result.membershipChanged).toBe(false);
	});

	it('drops a row that leaves the tab and asks for a refresh', () => {
		const list = [activity('queue-1'), activity('queue-2')];

		const result = upsertActivityInList(
			list,
			2,
			activity('queue-1', { status: 'imported' }),
			filters,
			'active'
		);

		expect(result.activities.map((a) => a.id)).toEqual(['queue-2']);
		expect(result.total).toBe(1);
		expect(result.membershipChanged).toBe(true);
	});

	it('ignores a new row that does not belong to the tab', () => {
		const list = [activity('queue-1')];

		const result = upsertActivityInList(
			list,
			1,
			activity('history-1', { activitySource: 'download_history', status: 'failed' }),
			filters,
			'active'
		);

		expect(result.activities).toBe(list);
		expect(result.total).toBe(1);
		expect(result.membershipChanged).toBe(false);
	});

	it('removes history rows the queue row now stands for', () => {
		const list = [
			activity('history-1', { activitySource: 'download_history', queueItemId: 'q-1' }),
			activity('queue-q-1', { queueItemId: 'q-1' })
		];

		const result = upsertActivityInList(
			list,
			2,
			activity('queue-q-1', { queueItemId: 'q-1', status: 'importing' }),
			filters,
			'active'
		);

		expect(result.activities.map((a) => a.id)).toEqual(['queue-q-1']);
		expect(result.total).toBe(1);
		expect(result.membershipChanged).toBe(true);
	});
});
