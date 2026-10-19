import { describe, expect, it } from 'vitest';
import type { UnifiedActivity } from '#lib/types/activity.js';
import { ActivityService } from './ActivityService';
import type { DownloadHistoryRecord, DownloadQueueRecord } from './types';
import { applyFilters, sortActivities, buildActivitySummary } from './activity-filters.js';
import { ActivityDeduplicationService } from './ActivityDeduplicationService.js';

function createActivity(id: string, overrides: Partial<UnifiedActivity> = {}): UnifiedActivity {
	return {
		id,
		activitySource: id.startsWith('queue-')
			? 'queue'
			: id.startsWith('monitoring-')
				? 'monitoring'
				: 'download_history',
		mediaType: 'movie',
		mediaId: 'movie-1',
		mediaTitle: 'Example Movie',
		mediaYear: 2025,
		releaseTitle: 'Example.Movie.2025.1080p.WEB-DL-GRP',
		quality: { resolution: '1080p', source: 'webdl', codec: 'h264' },
		releaseGroup: 'GRP',
		size: 1_000_000_000,
		indexerId: 'indexer-1',
		indexerName: 'Indexer One',
		protocol: 'usenet',
		status: 'imported',
		isUpgrade: false,
		timeline: [],
		startedAt: '2026-02-09T00:00:00.000Z',
		completedAt: null,
		...overrides
	};
}

function createHistoryRecord(
	id: string,
	overrides: Partial<DownloadHistoryRecord> = {}
): DownloadHistoryRecord {
	return {
		id,
		downloadClientId: null,
		downloadClientName: null,
		downloadId: null,
		infoHash: null,
		title: 'Example.Movie.2025.1080p.WEB-DL-GRP',
		indexerId: null,
		indexerName: null,
		protocol: 'usenet',
		movieId: null,
		seriesId: null,
		episodeIds: null,
		seasonNumber: null,
		status: 'imported',
		statusReason: null,
		size: null,
		downloadTimeSeconds: null,
		finalRatio: null,
		quality: null,
		releaseGroup: null,
		importedPath: null,
		transferMode: null,
		movieFileId: null,
		episodeFileIds: null,
		grabbedAt: '2026-02-09T00:00:00.000Z',
		completedAt: null,
		importedAt: null,
		createdAt: '2026-02-09T00:00:00.000Z',
		...overrides
	};
}

function createQueueRecord(
	id: string,
	overrides: Partial<DownloadQueueRecord> = {}
): DownloadQueueRecord {
	return {
		id,
		downloadClientId: 'client-1',
		downloadId: 'queue-download-id',
		infoHash: 'queue-info-hash',
		title: 'Example.Movie.2025.1080p.WEB-DL-GRP',
		indexerId: null,
		indexerName: null,
		downloadUrl: null,
		magnetUrl: null,
		protocol: 'usenet',
		movieId: null,
		seriesId: null,
		episodeIds: null,
		seasonNumber: null,
		status: 'downloading',
		progress: '0.5',
		size: null,
		downloadSpeed: 0,
		uploadSpeed: 0,
		eta: null,
		ratio: '0',
		clientDownloadPath: null,
		outputPath: null,
		importedPath: null,
		transferMode: null,
		quality: null,
		addedAt: '2026-02-09T00:00:00.000Z',
		startedAt: null,
		stalledSince: null,
		completedAt: null,
		importedAt: null,
		errorMessage: null,
		importAttempts: 0,
		lastAttemptAt: null,
		isAutomatic: false,
		isUpgrade: false,
		importFailed: false,
		releaseGroup: null,
		origin: null,
		...overrides
	};
}

describe('ActivityService download client filtering', () => {
	it('applyFilters ignores downloadClientId (handled by SQL)', () => {
		const activities: UnifiedActivity[] = [
			createActivity('queue-a', {
				status: 'downloading',
				downloadClientId: 'client-a'
			}),
			createActivity('history-a', {
				downloadClientId: 'client-a',
				downloadClientName: 'Client A'
			}),
			createActivity('queue-b', {
				status: 'failed',
				downloadClientId: 'client-b'
			}),
			createActivity('monitoring-no-client', {
				status: 'no_results',
				downloadClientId: null
			})
		];

		// downloadClientId filtering is now pushed to SQL.
		// applyFilters only handles JS-only filters (search, releaseGroup, resolution, isUpgrade).
		const filtered = applyFilters(activities, {
			status: 'all',
			mediaType: 'all',
			protocol: 'all',
			downloadClientId: 'client-a'
		});

		// All items pass through because applyFilters does not filter by downloadClientId
		expect(filtered.map((activity) => activity.id)).toEqual([
			'queue-a',
			'history-a',
			'queue-b',
			'monitoring-no-client'
		]);
	});
});

describe('ActivityService date filtering', () => {
	it('applyFilters ignores date filters (handled by SQL)', () => {
		const activities: UnifiedActivity[] = [
			createActivity('inside-day', { startedAt: '2026-03-07T22:15:00.000Z' }),
			createActivity('outside-day', { startedAt: '2026-03-08T00:00:00.000Z' })
		];

		// endDate filtering is now pushed to SQL (fetchHistoryItems / fetchMonitoringItems).
		// applyFilters only handles JS-only filters (search, releaseGroup, resolution, isUpgrade).
		const filtered = applyFilters(activities, {
			status: 'all',
			mediaType: 'all',
			protocol: 'all',
			endDate: '2026-03-07'
		});

		// Both items pass through because applyFilters does not filter by date
		expect(filtered.map((activity) => activity.id)).toEqual(['inside-day', 'outside-day']);
	});
});

describe('ActivityService sorting priority', () => {
	it('always keeps active downloads at the top of the list', () => {
		const activities: UnifiedActivity[] = [
			createActivity('imported-newer', {
				status: 'imported',
				startedAt: '2026-02-10T00:00:00.000Z'
			}),
			createActivity('downloading-older', {
				status: 'downloading',
				startedAt: '2026-02-08T00:00:00.000Z'
			}),
			createActivity('failed-middle', {
				status: 'failed',
				startedAt: '2026-02-09T00:00:00.000Z'
			})
		];

		sortActivities(activities, { field: 'time', direction: 'desc' });

		expect(activities.map((activity) => activity.id)).toEqual([
			'downloading-older',
			'imported-newer',
			'failed-middle'
		]);
	});
});

describe('ActivityService fallback media resolution', () => {
	it('uses parsed release title when a deleted movie no longer resolves by id', () => {
		const service = ActivityService.getInstance();
		const history = createHistoryRecord('history-movie-fallback', {
			title: 'Anaconda.2025.1080p.WEB-DL.x265-GRP',
			movieId: 'deleted-movie-id'
		});

		const activity = service.transformHistoryItem(
			history,
			{ movies: new Map(), series: new Map(), episodes: new Map() },
			[]
		);

		expect(activity).not.toBeNull();
		expect(activity?.mediaType).toBe('movie');
		expect(activity?.mediaTitle).toBe('Anaconda');
		expect(activity?.mediaId).toBe('');
	});

	it('uses parsed series title for missing series links instead of Unknown', () => {
		const service = ActivityService.getInstance();
		const history = createHistoryRecord('history-series-fallback', {
			title: 'Running.Man.S01E211.1080p.WEB-DL-GRP',
			seriesId: 'deleted-series-id',
			episodeIds: ['deleted-episode-id'],
			seasonNumber: 1
		});

		const activity = service.transformHistoryItem(
			history,
			{ movies: new Map(), series: new Map(), episodes: new Map() },
			[]
		);

		expect(activity).not.toBeNull();
		expect(activity?.mediaType).toBe('episode');
		expect(activity?.mediaTitle).toBe('Running Man S01E211');
		expect(activity?.mediaId).toBe('');
	});
});

describe('ActivityService failed activity retry linking', () => {
	it('attaches queueItemId to failed history activity when a matching failed queue item exists', () => {
		const service = ActivityService.getInstance();
		const history = createHistoryRecord('history-failed-retry-link', {
			status: 'failed',
			downloadId: 'download-123',
			statusReason: 'No video files found in download'
		});

		const activity = service.transformHistoryItem(
			history,
			{ movies: new Map(), series: new Map(), episodes: new Map() },
			[],
			new Map([['download:download-123', 'queue-abc']])
		);

		expect(activity).not.toBeNull();
		expect(activity?.queueItemId).toBe('queue-abc');
	});

	it('suppresses failed history activity when matching queue item is active after retry', () => {
		const service = ActivityService.getInstance();
		const history = createHistoryRecord('history-failed-duplicate', {
			status: 'failed',
			title: 'ONE.PIECE.S09E264.1080p.NF.WEB-DL.AAC2.0.H.264-7SPRITE7',
			seriesId: 'series-1',
			episodeIds: ['episode-264'],
			seasonNumber: 9,
			downloadId: 'old-download-id',
			grabbedAt: '2026-03-12T01:00:00.000Z'
		});
		const activeQueue = createQueueRecord('queue-active-1', {
			status: 'downloading',
			title: 'One.Piece.S09E264.1080p.NF.WEB-DL.AAC2.0.H.264-7sprite7',
			seriesId: 'series-1',
			episodeIds: ['episode-264'],
			seasonNumber: 9,
			downloadId: 'new-download-id',
			addedAt: '2026-03-12T01:00:00.000Z'
		});

		const activity = service.transformHistoryItem(
			history,
			{ movies: new Map(), series: new Map(), episodes: new Map() },
			[activeQueue],
			new Map([['download:old-download-id', 'queue-failed-stale']])
		);

		expect(activity).toBeNull();
	});

	it('suppresses duplicate when release title matches but queue row has no media linkage', () => {
		const service = ActivityService.getInstance();
		const history = createHistoryRecord('history-failed-title-fallback', {
			status: 'failed',
			title: 'One.Piece.S08.1080p.NF.WEB-DL.AAC2.0.H.264-7sprite7',
			seriesId: 'series-1',
			episodeIds: ['episode-1', 'episode-2'],
			seasonNumber: 8,
			protocol: 'usenet'
		});
		const activeQueue = createQueueRecord('queue-active-title-fallback', {
			status: 'downloading',
			title: 'One.Piece.S08.1080p.NF.WEB-DL.AAC2.0.H.264-7sprite7',
			seriesId: null,
			episodeIds: null,
			seasonNumber: null,
			protocol: 'usenet'
		});

		const activity = service.transformHistoryItem(
			history,
			{ movies: new Map(), series: new Map(), episodes: new Map() },
			[activeQueue]
		);

		expect(activity).toBeNull();
	});

	it('suppresses duplicate when queue keeps series linkage but has no episode linkage', () => {
		const service = ActivityService.getInstance();
		const history = createHistoryRecord('history-failed-series-only-queue', {
			status: 'failed',
			title: 'One.Piece.S08.1080p.NF.WEB-DL.AAC2.0.H.264-7sprite7',
			seriesId: 'series-1',
			episodeIds: ['episode-1', 'episode-2'],
			seasonNumber: 8,
			protocol: 'usenet'
		});
		const activeQueue = createQueueRecord('queue-active-series-only-queue', {
			status: 'downloading',
			title: 'One.Piece.S08.1080p.NF.WEB-DL.AAC2.0.H.264-7sprite7',
			seriesId: 'series-1',
			episodeIds: null,
			seasonNumber: null,
			protocol: 'usenet'
		});

		const activity = service.transformHistoryItem(
			history,
			{ movies: new Map(), series: new Map(), episodes: new Map() },
			[activeQueue]
		);

		expect(activity).toBeNull();
	});

	it('suppresses duplicate when download client id matches even if metadata drifts', () => {
		const service = ActivityService.getInstance();
		const history = createHistoryRecord('history-failed-downloadid-match', {
			status: 'failed',
			title: 'One.Piece.S08.1080p.NF.WEB-DL.AAC2.0.H.264-7sprite7',
			downloadId: 'client-item-123',
			seriesId: 'series-1',
			episodeIds: ['episode-1']
		});
		const activeQueue = createQueueRecord('queue-active-downloadid-match', {
			status: 'downloading',
			title: 'nzb_1718732672.nzb',
			downloadId: 'client-item-123',
			seriesId: null,
			episodeIds: null,
			seasonNumber: null
		});

		const activity = service.transformHistoryItem(
			history,
			{ movies: new Map(), series: new Map(), episodes: new Map() },
			[activeQueue]
		);

		expect(activity).toBeNull();
	});

	it('suppresses duplicate when title drifts but series and grabbed timestamp still match', () => {
		const service = ActivityService.getInstance();
		const history = createHistoryRecord('history-failed-title-drift-grabbed', {
			status: 'failed',
			title: 'One.Piece.S08.1080p.NF.WEB-DL.AAC2.0.H.264-7sprite7',
			seriesId: 'series-1',
			episodeIds: ['episode-1', 'episode-2'],
			seasonNumber: 8,
			grabbedAt: '2026-03-12T01:00:00.000Z'
		});
		const activeQueue = createQueueRecord('queue-active-title-drift-grabbed', {
			status: 'downloading',
			title: 'nzb_1718732672.nzb',
			seriesId: 'series-1',
			episodeIds: null,
			seasonNumber: null,
			addedAt: '2026-03-12T01:00:00.000Z'
		});

		const activity = service.transformHistoryItem(
			history,
			{ movies: new Map(), series: new Map(), episodes: new Map() },
			[activeQueue]
		);

		expect(activity).toBeNull();
	});
});

describe('ActivityService active dedupe', () => {
	it('prefers active queue row over failed duplicate rows for same release/media', () => {
		const duplicateFailedHistory = createActivity('history-failed-1', {
			status: 'failed',
			releaseTitle: 'One.Piece.S08.1080p.NF.WEB-DL.AAC2.0.H.264-7sprite7',
			seriesId: 'series-1',
			seasonNumber: 8,
			episodeIds: ['episode-1', 'episode-2'],
			queueItemId: 'queue-old'
		});

		const activeQueue = createActivity('queue-active-1', {
			status: 'downloading',
			releaseTitle: 'One.Piece.S08.1080p.NF.WEB-DL.AAC2.0.H.264-7sprite7',
			seriesId: 'series-1',
			seasonNumber: 8,
			episodeIds: ['episode-1', 'episode-2'],
			queueItemId: 'queue-new',
			startedAt: '2026-03-12T05:30:00.000Z'
		});

		const deduped = new ActivityDeduplicationService().dedupeActiveActivities([
			duplicateFailedHistory,
			activeQueue
		]);
		expect(deduped).toHaveLength(1);
		expect(deduped[0].id).toBe('queue-active-1');
	});

	it('dedupes series rows when one side lacks episode ids', () => {
		const failedHistory = createActivity('history-failed-series-no-episodes', {
			status: 'failed',
			mediaType: 'episode',
			mediaId: '',
			seriesId: 'series-1',
			seasonNumber: 8,
			episodeIds: ['episode-1', 'episode-2'],
			releaseTitle: 'One.Piece.S08.1080p.NF.WEB-DL.AAC2.0.H.264-7sprite7'
		});

		const activeQueue = createActivity('queue-active-series-no-episodes', {
			status: 'downloading',
			id: 'queue-active-series-no-episodes',
			mediaType: 'episode',
			mediaId: '',
			seriesId: 'series-1',
			seasonNumber: undefined,
			episodeIds: undefined,
			releaseTitle: 'One.Piece.S08.1080p.NF.WEB-DL.AAC2.0.H.264-7sprite7'
		});

		const deduped = new ActivityDeduplicationService().dedupeActiveActivities([
			failedHistory,
			activeQueue
		]);
		expect(deduped).toHaveLength(1);
		expect(deduped[0].id).toBe('queue-active-series-no-episodes');
	});
});

describe('ActivityService unified summary', () => {
	it('excludes failed queue rows from the active scope (they belong in History)', () => {
		const failedQueue = createActivity('queue-failed', {
			status: 'failed',
			queueItemId: 'queue-failed-id',
			releaseTitle: 'Failure.Movie.2026.1080p.WEB-DL-GRP'
		});
		const downloadingQueue = createActivity('queue-downloading', {
			status: 'downloading',
			queueItemId: 'queue-download-id',
			releaseTitle: 'Success.Movie.2026.1080p.WEB-DL-GRP'
		});

		const activeUniverse = new ActivityDeduplicationService().dedupeActiveActivities(
			applyFilters([failedQueue, downloadingQueue], { status: 'all' }, 'active')
		);
		const summary = buildActivitySummary(activeUniverse);

		// Failed items are no longer part of the active scope - they appear in History
		expect(activeUniverse.map((activity) => activity.id)).toEqual(['queue-downloading']);
		expect(summary.failedCount).toBe(0);
		expect(summary.totalCount).toBe(1);
		expect(summary.downloadingCount).toBe(1);
	});
});
