import { describe, expect, it } from 'vitest';

import { isActiveActivity, type UnifiedActivity } from '#lib/types/activity.js';
import { buildActivitySummary } from './activity-filters.js';
import { mapQueueStatus, projectQueueActivity } from './projectors.js';
import { mapFilterStatusToQueueStatuses } from './status-mappers.js';

function projectWithQueueStatus(status: string): UnifiedActivity {
	return projectQueueActivity(
		{
			id: `queue-${status}`,
			title: 'Some.Movie.2026.1080p.WEB-DL-GRP',
			status,
			progress: 1
		},
		{ mediaType: 'movie', mediaId: '', mediaTitle: 'Some Movie', mediaYear: 2026 }
	);
}

describe('mapQueueStatus', () => {
	it('maps pre-transfer and transfer states to downloading', () => {
		expect(mapQueueStatus('queued')).toBe('downloading');
		expect(mapQueueStatus('downloading')).toBe('downloading');
		expect(mapQueueStatus('stalled')).toBe('downloading');
	});

	it('maps post-download pipeline states to importing instead of downloading', () => {
		expect(mapQueueStatus('completed')).toBe('importing');
		expect(mapQueueStatus('postprocessing')).toBe('importing');
		expect(mapQueueStatus('importing')).toBe('importing');
	});

	it('keeps terminal and torrent-specific states distinct', () => {
		expect(mapQueueStatus('seeding')).toBe('seeding');
		expect(mapQueueStatus('paused')).toBe('paused');
		expect(mapQueueStatus('failed')).toBe('failed');
		expect(mapQueueStatus('imported')).toBe('imported');
		expect(mapQueueStatus('seeding-imported')).toBe('seeding');
		expect(mapQueueStatus('removed')).toBe('removed');
	});
});

describe('imported torrents still seeding', () => {
	it('keeps the queue row active and counts it as seeding', () => {
		const activity = projectWithQueueStatus('seeding-imported');
		const summary = buildActivitySummary([activity]);

		expect(activity.status).toBe('seeding');
		expect(activity.queueStatus).toBe('seeding-imported');
		expect(isActiveActivity(activity)).toBe(true);
		expect(mapFilterStatusToQueueStatuses('seeding')).toContain('seeding-imported');
		expect(summary).toMatchObject({ totalCount: 1, seedingCount: 1, downloadingCount: 0 });
	});
});

describe('post-download queue items remain active but are not "downloading"', () => {
	it.each(['completed', 'postprocessing', 'importing'])(
		'%S items stay in the active scope',
		(queueStatus) => {
			const activity = projectWithQueueStatus(queueStatus);

			expect(activity.status).toBe('importing');
			expect(isActiveActivity(activity)).toBe(true);
			expect(activity.queueStatus).toBe(queueStatus);
		}
	);
});

describe('buildActivitySummary counts importing separately from downloading', () => {
	it('does not inflate downloadingCount with finished transfers awaiting import', () => {
		const activities = [
			projectWithQueueStatus('downloading'),
			projectWithQueueStatus('completed'),
			projectWithQueueStatus('importing')
		];

		const summary = buildActivitySummary(activities);

		expect(summary.totalCount).toBe(3);
		expect(summary.downloadingCount).toBe(1);
		expect(summary.importingCount).toBe(2);
	});
});
