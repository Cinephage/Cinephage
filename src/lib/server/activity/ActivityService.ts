import { db } from '#lib/server/db/index.js';
import {
	downloadQueue,
	downloadHistory,
	monitoringHistory,
	taskHistory,
	movies,
	series,
	episodes,
	settings,
	blocklist
} from '#lib/server/db/schema.js';
import { and, desc, gte, inArray, eq, lte, lt, sql, count, or } from 'drizzle-orm';
import { upsertQueueTombstoneFromQueueItem } from '#lib/server/downloadClients/monitoring/QueueTombstoneService.js';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { SQL } from 'drizzle-orm';
import {
	ActivityDeduplicationService,
	type ActiveQueueIndex
} from './ActivityDeduplicationService.js';
import { normalizeReleaseKey } from './dedup-utils.js';
import {
	buildFailedQueueIndex,
	findFailedQueueItemId,
	buildHistoryTimeline,
	buildBlocklistIndex,
	findBlocklistEntry,
	isBlocklistEntryActive,
	resolveMediaInfo,
	resolveMonitoringMediaInfo,
	type MediaMaps,
	type BlocklistEntryInfo
} from './activity-transformers.js';
import {
	type UnifiedActivity,
	type ActivityEvent,
	type ActivityStatus,
	type ActivityFilters,
	type ActivitySortOptions,
	type ActivityScope,
	type ActivitySummary
} from '#lib/types/activity.js';
import type {
	DownloadQueueRecord,
	DownloadHistoryRecord,
	MonitoringHistoryRecord,
	MoveTaskRecord
} from './types';
import { projectQueueActivity } from './projectors';
import { parseMoveTaskId } from '#lib/server/library/MediaMoveService.js';
import {
	mapFilterStatusToQueueStatuses,
	mapFilterStatusToHistoryStatuses,
	mapMoveStatusesForScopeAndFilter,
	mapMoveTaskStatus
} from './status-mappers.js';
import {
	sortActivities,
	withoutStatusFilter,
	applyRequestedStatusFilter,
	applyFilters,
	buildActivitySummary,
	parseRetentionDays
} from './activity-filters.js';

const logger = createChildLogger({ module: 'ActivityService', logDomain: 'monitoring' });

interface PaginationOptions {
	limit: number;
	offset: number;
}

interface ActivityQueryResult {
	activities: UnifiedActivity[];
	total: number;
	hasMore: boolean;
	summary: ActivitySummary | null;
	failedCount: number;
}

export {
	DEFAULT_ACTIVITY_RETENTION_DAYS,
	MAX_ACTIVITY_RETENTION_DAYS
} from './activity-filters.js';

const ACTIVITY_RETENTION_SETTINGS_KEY = 'activity_history_retention_days';

interface DeleteHistoryResult {
	deletedDownloadHistory: number;
	deletedMonitoringHistory: number;
	deletedTaskHistory: number;
	skippedQueue: number;
	skippedUnknown: number;
	skippedRetryableFailed: number;
	skippedRunningTasks: number;
}

interface PurgeHistoryResult {
	deletedDownloadHistory: number;
	deletedMonitoringHistory: number;
	deletedTaskHistory: number;
	totalDeleted: number;
	cutoff?: string;
}

/**
 * Service for managing and querying activity data
 * Consolidates download queue, history, and monitoring history into unified activities
 */
export class ActivityService {
	private static instance: ActivityService;
	private deduplicationService = new ActivityDeduplicationService();

	private constructor() {}

	static getInstance(): ActivityService {
		if (!ActivityService.instance) {
			ActivityService.instance = new ActivityService();
		}
		return ActivityService.instance;
	}

	/**
	 * Get unified activities with filtering and pagination.
	 *
	 * Filters are pushed down to SQL WHERE clauses where possible so the
	 * database does the heavy lifting rather than fetching everything into
	 * memory and filtering afterwards.
	 */
	async getActivities(
		filters: ActivityFilters = {},
		sort: ActivitySortOptions = { field: 'time', direction: 'desc' },
		pagination: PaginationOptions = { limit: 50, offset: 0 },
		scope: ActivityScope = 'all'
	): Promise<ActivityQueryResult> {
		const needsActive = scope === 'all' || scope === 'active';
		const needsHistory = scope === 'all' || scope === 'history';
		const summaryFilters = withoutStatusFilter(filters);

		// Check if any JS-only filters are active (search, resolution,
		// releaseGroup, isUpgrade).  When they are, we cannot compute an
		// accurate total via SQL COUNT alone and must rely on the
		// post-transform filtered length instead.
		const hasJsOnlyFilters =
			!!filters.search ||
			!!filters.resolution ||
			!!filters.releaseGroup ||
			filters.isUpgrade !== undefined;

		// Fetch data + SQL-level counts in parallel.
		// The counts use the same WHERE clauses as the data queries but skip
		// the LIMIT cap, giving an accurate total even when the result set is
		// larger than the fetch limit.
		const [
			activeDownloads,
			historyItems,
			monitoringItems,
			moveTasks,
			failedQueueItems,
			blocklistEntries,
			historyCount,
			monitoringCount,
			moveTaskCount,
			historyFailedCount
		] = await Promise.all([
			needsActive
				? this.fetchActiveDownloads(summaryFilters)
				: Promise.resolve([] as DownloadQueueRecord[]),
			needsHistory
				? this.fetchHistoryItems(filters)
				: Promise.resolve([] as DownloadHistoryRecord[]),
			needsHistory
				? this.fetchMonitoringItems(filters.includeNoResults, filters)
				: Promise.resolve([] as MonitoringHistoryRecord[]),
			needsActive || needsHistory
				? this.fetchMoveTasks(scope, filters)
				: Promise.resolve([] as MoveTaskRecord[]),
			needsActive || needsHistory
				? this.fetchFailedQueueItems()
				: Promise.resolve(
						[] as Pick<DownloadQueueRecord, 'id' | 'downloadId' | 'title' | 'addedAt' | 'status'>[]
					),
			needsHistory ? this.fetchBlocklistEntries() : Promise.resolve([]),
			needsHistory && !hasJsOnlyFilters ? this.countHistoryItems(filters) : Promise.resolve(0),
			needsHistory && !hasJsOnlyFilters
				? this.countMonitoringItems(filters.includeNoResults, filters)
				: Promise.resolve(0),
			(needsActive || needsHistory) && !hasJsOnlyFilters
				? this.countMoveTasks(scope, filters)
				: Promise.resolve(0),
			this.countHistoryFailed()
		]);

		// Batch fetch all media info
		const mediaMaps = await this.fetchMediaMaps(activeDownloads, historyItems, monitoringItems);

		// Fetch linked monitoring history for queue items
		const monitoringByQueueId = needsActive
			? await this.fetchMonitoringForQueue(activeDownloads.map((d) => d.id))
			: new Map<string, MonitoringHistoryRecord[]>();

		const failedQueueIndex = buildFailedQueueIndex(failedQueueItems);
		const blocklistIndex = buildBlocklistIndex(blocklistEntries);

		const queueActivities = this.transformQueueItems(
			activeDownloads,
			mediaMaps,
			monitoringByQueueId
		);
		const rawHistoryActivities = this.transformHistoryItems(
			historyItems,
			mediaMaps,
			activeDownloads,
			failedQueueIndex,
			blocklistIndex
		);
		const historyActivities = needsHistory
			? this.deduplicationService.deduplicateHistoryActivities(rawHistoryActivities)
			: rawHistoryActivities;
		const historyDeduped = historyActivities.length < rawHistoryActivities.length;
		const monitoringActivities = this.transformMonitoringItems(monitoringItems, mediaMaps);
		const moveActivities = this.transformMoveTasks(moveTasks);
		const activities: UnifiedActivity[] = [
			...queueActivities,
			...historyActivities,
			...monitoringActivities,
			...moveActivities
		];

		let filtered = applyRequestedStatusFilter(applyFilters(activities, filters, scope), filters);
		if (scope === 'active') {
			filtered = this.deduplicationService.dedupeActiveActivities(filtered);
		}
		sortActivities(filtered, sort);

		let activeFilteredCount = 0;
		let summary: ActivitySummary | null = null;
		if (needsActive) {
			let activeUniverse = applyFilters(activities, summaryFilters, 'active');
			activeUniverse = this.deduplicationService.dedupeActiveActivities(activeUniverse);
			activeFilteredCount = applyRequestedStatusFilter(activeUniverse, filters).length;

			if (scope === 'active') {
				summary = buildActivitySummary(activeUniverse);
				summary.failedCount = historyFailedCount;
			}
		}

		const useFilteredLength = hasJsOnlyFilters || historyDeduped;
		const total =
			scope === 'active'
				? activeFilteredCount
				: scope === 'history'
					? useFilteredLength
						? filtered.length
						: historyCount + monitoringCount + moveTaskCount
					: useFilteredLength
						? filtered.length
						: activeFilteredCount + historyCount + monitoringCount + moveTaskCount;

		const paginated = filtered.slice(pagination.offset, pagination.offset + pagination.limit);

		// Derive hasMore from the data we actually fetched rather than the parallel
		// SQL COUNT. The two run concurrently and can diverge when the download
		// monitor writes failed/recovered records between them - COUNT can come back
		// higher than the fetch, producing hasMore=true with nothing left to load
		// and causing an infinite load-more loop on the client.
		//
		// Limitation: fetchHistoryItems caps at 500 rows. Once filtered.length hits
		// that cap, hasMore correctly signals true up to offset=450 (with limit=50)
		// but then becomes false at offset=500 even if the DB holds more records.
		// The old COUNT-based formula was worse here: it produced hasMore=true on
		// empty pages, causing a loop. The fetch-cap itself is the real fix needed
		// for datasets over 500 items.
		const hasMore = filtered.length > pagination.offset + pagination.limit;

		return {
			activities: paginated,
			total,
			hasMore,
			summary,
			failedCount: historyFailedCount
		};
	}

	/**
	 * Get active-tab card stats using lightweight COUNT/SUM queries.
	 *
	 * Previous implementation ran the full 8-query pipeline (fetch all sources,
	 * transform, filter, dedupe) just to return 7 numbers. This replaces it with
	 * two simple SQL queries against the download_queue table.
	 */
	/**
	 * Lightweight check: how many active queue items exist?
	 * Used by the page load to decide which tab to show without running the full pipeline.
	 */
	async getActiveCount(): Promise<number> {
		const result = await db
			.select({ count: count() })
			.from(downloadQueue)
			.where(
				inArray(downloadQueue.status, [
					'downloading',
					'queued',
					'paused',
					'stalled',
					'seeding',
					'seeding-imported',
					'completed',
					'postprocessing',
					'importing'
				])
			)
			.get();
		return result?.count ?? 0;
	}

	async getQueueCardStats(): Promise<{
		totalCount: number;
		downloadingCount: number;
		seedingCount: number;
		pausedCount: number;
		failedCount: number;
	}> {
		const [queueStats, historyFailed] = await Promise.all([
			db
				.select({ status: downloadQueue.status, count: count() })
				.from(downloadQueue)
				.where(
					inArray(downloadQueue.status, [
						'downloading',
						'queued',
						'stalled',
						'seeding',
						'seeding-imported',
						'completed',
						'postprocessing',
						'importing',
						'paused'
					])
				)
				.groupBy(downloadQueue.status),
			db
				.select({ count: count() })
				.from(downloadHistory)
				.where(eq(downloadHistory.status, 'failed'))
				.get()
		]);

		const statusMap = new Map(queueStats.map((r) => [r.status, r.count]));
		const downloadingCount =
			(statusMap.get('downloading') ?? 0) +
			(statusMap.get('queued') ?? 0) +
			(statusMap.get('stalled') ?? 0) +
			(statusMap.get('completed') ?? 0) +
			(statusMap.get('postprocessing') ?? 0) +
			(statusMap.get('importing') ?? 0);
		const seedingCount = (statusMap.get('seeding') ?? 0) + (statusMap.get('seeding-imported') ?? 0);
		const pausedCount = statusMap.get('paused') ?? 0;
		const failedCount = historyFailed?.count ?? 0;
		const totalCount = downloadingCount + seedingCount + pausedCount;

		return { totalCount, downloadingCount, seedingCount, pausedCount, failedCount };
	}

	async getRetentionDays(): Promise<number> {
		const row = await db
			.select({ value: settings.value })
			.from(settings)
			.where(eq(settings.key, ACTIVITY_RETENTION_SETTINGS_KEY))
			.get();
		return parseRetentionDays(row?.value);
	}

	async setRetentionDays(days: number): Promise<number> {
		const normalized = parseRetentionDays(days);
		await db
			.insert(settings)
			.values({
				key: ACTIVITY_RETENTION_SETTINGS_KEY,
				value: String(normalized)
			})
			.onConflictDoUpdate({
				target: settings.key,
				set: { value: String(normalized) }
			});
		return normalized;
	}

	async deleteHistoryActivities(activityIds: string[]): Promise<DeleteHistoryResult> {
		const historyIds = new Set<string>();
		const monitoringIds = new Set<string>();
		const taskIds = new Set<string>();
		let skippedQueue = 0;
		let skippedUnknown = 0;

		for (const rawId of activityIds) {
			const id = rawId.trim();
			if (!id) {
				continue;
			}

			if (id.startsWith('history-')) {
				const historyId = id.slice('history-'.length).trim();
				if (historyId) {
					historyIds.add(historyId);
				}
				continue;
			}

			if (id.startsWith('monitoring-')) {
				const monitoringId = id.slice('monitoring-'.length).trim();
				if (monitoringId) {
					monitoringIds.add(monitoringId);
				}
				continue;
			}

			if (id.startsWith('queue-')) {
				skippedQueue += 1;
				continue;
			}

			if (id.startsWith('task-')) {
				const taskId = id.slice('task-'.length).trim();
				if (taskId) {
					taskIds.add(taskId);
				}
				continue;
			}

			skippedUnknown += 1;
		}

		const historyIdList = Array.from(historyIds);
		const monitoringIdList = Array.from(monitoringIds);
		const taskIdList = Array.from(taskIds);
		let eligibleHistoryIdList = historyIdList;
		let eligibleTaskIdList = taskIdList;
		const skippedRetryableFailed = 0;
		let skippedRunningTasks = 0;

		// Collect downloadIds from failed history rows being deleted so we can cascade to queue
		const failedHistoryDownloadIds = new Set<string>();

		if (historyIdList.length > 0) {
			// Fetch initial rows to find their dedup group (media link + normalized title)
			// Also fetch status and downloadId for failed rows so we can cascade-clean queue items
			const initialRows = await db
				.select({
					id: downloadHistory.id,
					title: downloadHistory.title,
					movieId: downloadHistory.movieId,
					seriesId: downloadHistory.seriesId,
					status: downloadHistory.status,
					downloadId: downloadHistory.downloadId,
					grabbedAt: downloadHistory.grabbedAt
				})
				.from(downloadHistory)
				.where(inArray(downloadHistory.id, historyIdList))
				.all();

			// Collect downloadIds of failed rows for cascade cleanup
			for (const row of initialRows) {
				if (row.status === 'failed' && row.downloadId) {
					failedHistoryDownloadIds.add(row.downloadId);
				}
			}

			// Expand historyIds to include all sibling rows in the same dedup group so
			// deleting a deduplicated entry removes all underlying DB rows at once
			const movieIdTargets = [
				...new Set(initialRows.filter((r) => r.movieId).map((r) => r.movieId!))
			];
			const seriesIdTargets = [
				...new Set(initialRows.filter((r) => r.seriesId).map((r) => r.seriesId!))
			];

			if (movieIdTargets.length > 0 || seriesIdTargets.length > 0) {
				const siblingConditions = [
					...(movieIdTargets.length > 0 ? [inArray(downloadHistory.movieId, movieIdTargets)] : []),
					...(seriesIdTargets.length > 0
						? [inArray(downloadHistory.seriesId, seriesIdTargets)]
						: [])
				];
				const candidates = await db
					.select({
						id: downloadHistory.id,
						title: downloadHistory.title,
						movieId: downloadHistory.movieId,
						seriesId: downloadHistory.seriesId,
						status: downloadHistory.status,
						downloadId: downloadHistory.downloadId
					})
					.from(downloadHistory)
					.where(siblingConditions.length === 1 ? siblingConditions[0] : or(...siblingConditions))
					.all();

				for (const target of initialRows) {
					const targetNormKey = normalizeReleaseKey(target.title);
					for (const candidate of candidates) {
						if (historyIds.has(candidate.id)) continue;
						const sameGroup =
							(target.movieId &&
								candidate.movieId === target.movieId &&
								normalizeReleaseKey(candidate.title) === targetNormKey) ||
							(target.seriesId &&
								candidate.seriesId === target.seriesId &&
								normalizeReleaseKey(candidate.title) === targetNormKey);
						if (sameGroup) {
							historyIds.add(candidate.id);
							if (candidate.status === 'failed' && candidate.downloadId) {
								failedHistoryDownloadIds.add(candidate.downloadId);
							}
						}
					}
				}
			}

			eligibleHistoryIdList = Array.from(historyIds);
		}

		if (taskIdList.length > 0) {
			const requestedTaskRows = await db
				.select({
					id: taskHistory.id,
					taskId: taskHistory.taskId,
					status: taskHistory.status
				})
				.from(taskHistory)
				.where(inArray(taskHistory.id, taskIdList))
				.all();

			const protectedTaskIds = new Set<string>();
			for (const row of requestedTaskRows) {
				// Only media-move task history is represented in Activity rows.
				// Also do not allow deleting running task rows.
				if (!row.taskId.startsWith('media-move:')) {
					protectedTaskIds.add(row.id);
					continue;
				}
				if (row.status === 'running') {
					protectedTaskIds.add(row.id);
					skippedRunningTasks += 1;
				}
			}

			eligibleTaskIdList = taskIdList.filter((id) => !protectedTaskIds.has(id));
		}

		const { deletedDownloadHistory, deletedMonitoringHistory, deletedTaskHistory } =
			await db.transaction((tx) => {
				const deletedDownloadHistory =
					eligibleHistoryIdList.length > 0
						? tx
								.delete(downloadHistory)
								.where(inArray(downloadHistory.id, eligibleHistoryIdList))
								.run().changes
						: 0;

				const deletedMonitoringHistory =
					monitoringIdList.length > 0
						? tx
								.delete(monitoringHistory)
								.where(inArray(monitoringHistory.id, monitoringIdList))
								.run().changes
						: 0;

				const deletedTaskHistory =
					eligibleTaskIdList.length > 0
						? tx
								.delete(taskHistory)
								.where(
									and(
										inArray(taskHistory.id, eligibleTaskIdList),
										sql`${taskHistory.taskId} LIKE 'media-move:%'`,
										inArray(taskHistory.status, ['completed', 'failed', 'cancelled'])
									)
								)
								.run().changes
						: 0;

				return { deletedDownloadHistory, deletedMonitoringHistory, deletedTaskHistory };
			});

		// Cascade: clean up failed queue items linked to the deleted history rows
		if (failedHistoryDownloadIds.size > 0) {
			const linkedQueueItems = await db
				.select()
				.from(downloadQueue)
				.where(
					and(
						eq(downloadQueue.status, 'failed'),
						inArray(downloadQueue.downloadId, Array.from(failedHistoryDownloadIds))
					)
				)
				.all();

			for (const item of linkedQueueItems) {
				try {
					await upsertQueueTombstoneFromQueueItem(item, 'local_remove_without_client_delete');
					await db.delete(downloadQueue).where(eq(downloadQueue.id, item.id));
				} catch (_err) {
					// Best-effort; failures here shouldn't abort the history delete
				}
			}
		}

		return {
			deletedDownloadHistory,
			deletedMonitoringHistory,
			deletedTaskHistory,
			skippedQueue,
			skippedUnknown,
			skippedRetryableFailed,
			skippedRunningTasks
		};
	}

	async purgeHistoryOlderThan(
		retentionDays: number,
		options: { removeFromClient?: boolean } = {}
	): Promise<PurgeHistoryResult> {
		const normalizedRetentionDays = parseRetentionDays(retentionDays);
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - normalizedRetentionDays);
		const cutoffIso = cutoffDate.toISOString();

		// Fetch failed queue items that are old enough to be purged
		const failedQueueItems = await db
			.select()
			.from(downloadQueue)
			.where(and(eq(downloadQueue.status, 'failed'), lt(downloadQueue.addedAt, cutoffIso)))
			.all();

		const { deletedDownloadHistory, deletedMonitoringHistory, deletedTaskHistory } =
			await db.transaction((tx) => {
				const deletedDownloadHistory = tx
					.delete(downloadHistory)
					.where(lt(downloadHistory.createdAt, cutoffIso))
					.run().changes;
				const deletedMonitoringHistory = tx
					.delete(monitoringHistory)
					.where(lt(monitoringHistory.executedAt, cutoffIso))
					.run().changes;

				const deletedTaskHistory = tx
					.delete(taskHistory)
					.where(
						and(
							sql`${taskHistory.taskId} LIKE 'media-move:%'`,
							inArray(taskHistory.status, ['completed', 'failed', 'cancelled']),
							lt(taskHistory.startedAt, cutoffIso)
						)
					)
					.run().changes;

				return { deletedDownloadHistory, deletedMonitoringHistory, deletedTaskHistory };
			});

		// Clean up old failed queue items so they can't resurface on the next client sync
		for (const item of failedQueueItems) {
			try {
				if (options.removeFromClient && item.downloadClientId) {
					const isTorrent = item.protocol === 'torrent';
					const clientDownloadId = isTorrent
						? item.infoHash || item.downloadId
						: item.downloadId || item.infoHash;
					if (clientDownloadId) {
						const clientInstance = await getDownloadClientManager().getClientInstance(
							item.downloadClientId
						);
						if (clientInstance) {
							try {
								await clientInstance.removeDownload(clientDownloadId, false);
							} catch (removeErr) {
								logger.warn(
									{
										queueId: item.id,
										title: item.title,
										error: removeErr instanceof Error ? removeErr.message : String(removeErr)
									},
									'Failed to remove from download client during purge; continuing with local removal'
								);
							}
						}
					}
				}
				await upsertQueueTombstoneFromQueueItem(item, 'local_remove_without_client_delete');
				await db.delete(downloadQueue).where(eq(downloadQueue.id, item.id));
			} catch (_err) {
				// Best-effort; failures here shouldn't abort the purge
			}
		}

		return {
			deletedDownloadHistory,
			deletedMonitoringHistory,
			deletedTaskHistory,
			totalDeleted: deletedDownloadHistory + deletedMonitoringHistory + deletedTaskHistory,
			cutoff: cutoffIso
		};
	}

	async purgeAllHistory(options: { removeFromClient?: boolean } = {}): Promise<PurgeHistoryResult> {
		// Fetch failed queue items before purging so we can tombstone and delete them
		const failedQueueItems = await db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.status, 'failed'))
			.all();

		const { deletedDownloadHistory, deletedMonitoringHistory, deletedTaskHistory } =
			await db.transaction((tx) => {
				const deletedDownloadHistory = tx.delete(downloadHistory).run().changes;
				const deletedMonitoringHistory = tx.delete(monitoringHistory).run().changes;

				const deletedTaskHistory = tx
					.delete(taskHistory)
					.where(
						and(
							sql`${taskHistory.taskId} LIKE 'media-move:%'`,
							inArray(taskHistory.status, ['completed', 'failed', 'cancelled'])
						)
					)
					.run().changes;

				return { deletedDownloadHistory, deletedMonitoringHistory, deletedTaskHistory };
			});

		// Clean up failed queue items so they can't resurface on the next client sync
		for (const item of failedQueueItems) {
			try {
				if (options.removeFromClient && item.downloadClientId) {
					const isTorrent = item.protocol === 'torrent';
					const clientDownloadId = isTorrent
						? item.infoHash || item.downloadId
						: item.downloadId || item.infoHash;
					if (clientDownloadId) {
						const clientInstance = await getDownloadClientManager().getClientInstance(
							item.downloadClientId
						);
						if (clientInstance) {
							try {
								await clientInstance.removeDownload(clientDownloadId, false);
							} catch (removeErr) {
								logger.warn(
									{
										queueId: item.id,
										title: item.title,
										error: removeErr instanceof Error ? removeErr.message : String(removeErr)
									},
									'Failed to remove from download client during purge; continuing with local removal'
								);
							}
						}
					}
				}
				await upsertQueueTombstoneFromQueueItem(item, 'local_remove_without_client_delete');
				await db.delete(downloadQueue).where(eq(downloadQueue.id, item.id));
			} catch (_err) {
				// Best-effort; failures here shouldn't abort the purge
			}
		}

		return {
			deletedDownloadHistory,
			deletedMonitoringHistory,
			deletedTaskHistory,
			totalDeleted: deletedDownloadHistory + deletedMonitoringHistory + deletedTaskHistory
		};
	}

	/**
	 * Transform a single queue item to unified activity
	 */
	transformQueueItem(
		download: DownloadQueueRecord,
		mediaMaps: MediaMaps,
		linkedMonitoring: MonitoringHistoryRecord[] = []
	): UnifiedActivity {
		const mediaInfo = resolveMediaInfo(download, mediaMaps);

		return projectQueueActivity(download, mediaInfo, linkedMonitoring);
	}

	/**
	 * Transform a single history item to unified activity
	 */
	transformHistoryItem(
		history: DownloadHistoryRecord,
		mediaMaps: MediaMaps,
		activeDownloads: DownloadQueueRecord[] = [],
		failedQueueIndex?: Map<string, string>,
		blocklistIndex?: Map<string, BlocklistEntryInfo>
	): UnifiedActivity | null {
		// Skip if this release is already represented by an active queue row.
		// This avoids duplicate active entries when a failed history record is retried.
		const index = this.deduplicationService.buildActiveQueueIndex(activeDownloads);
		if (this.deduplicationService.isHistoryRepresentedByActiveQueueIndexed(history, index)) {
			return null;
		}

		const blocklistEntry = findBlocklistEntry(history, blocklistIndex);
		const timeline = buildHistoryTimeline(history, blocklistEntry);
		const mediaInfo = resolveMediaInfo(history, mediaMaps);
		const queueItemId =
			history.status === 'failed' ? findFailedQueueItemId(history, failedQueueIndex) : undefined;

		return {
			id: `history-${history.id}`,
			activitySource: 'download_history' as const,
			mediaType: mediaInfo.mediaType,
			mediaId: mediaInfo.mediaId,
			mediaTitle: mediaInfo.mediaTitle,
			mediaYear: mediaInfo.mediaYear,
			seriesId: mediaInfo.seriesId,
			seriesTitle: mediaInfo.seriesTitle,
			seasonNumber: mediaInfo.seasonNumber,
			episodeNumber: mediaInfo.episodeNumber,
			episodeIds: history.episodeIds ?? undefined,
			releaseTitle: history.title,
			quality: history.quality ?? null,
			releaseGroup: history.releaseGroup ?? null,
			size: history.size ?? null,
			indexerId: history.indexerId ?? null,
			indexerName: history.indexerName ?? null,
			protocol: (history.protocol as 'torrent' | 'usenet' | 'streaming') ?? null,
			downloadClientId: history.downloadClientId ?? null,
			downloadClientName: history.downloadClientName ?? null,
			status: history.status as ActivityStatus,
			statusReason: history.statusReason ?? undefined,
			isUpgrade: false,
			timeline,
			startedAt:
				history.createdAt ||
				history.importedAt ||
				history.completedAt ||
				history.grabbedAt ||
				new Date().toISOString(),
			completedAt: history.importedAt || history.completedAt || null,
			queueItemId,
			downloadHistoryId: history.id,
			importedPath: history.importedPath ?? undefined,
			transferMode: (history.transferMode as UnifiedActivity['transferMode']) ?? undefined,
			isBlocklisted: blocklistEntry ? isBlocklistEntryActive(blocklistEntry) : false
		};
	}

	/**
	 * Transform a single monitoring item to unified activity
	 */
	transformMonitoringItem(
		mon: MonitoringHistoryRecord,
		mediaMaps: MediaMaps,
		processedKeys?: Set<string>
	): UnifiedActivity | null {
		const executedAt = mon.executedAt;
		if (!executedAt) return null;

		// Deduplication key
		const mediaKey = mon.movieId
			? `movie-${mon.movieId}-${executedAt.slice(0, 10)}`
			: `episode-${mon.episodeId || mon.seriesId}-${executedAt.slice(0, 10)}`;

		if (processedKeys?.has(mediaKey)) return null;
		processedKeys?.add(mediaKey);

		const mediaInfo = resolveMonitoringMediaInfo(mon, mediaMaps);

		const timeline: ActivityEvent[] = [
			{
				type: 'searched',
				timestamp: executedAt,
				details: mon.errorMessage || (mon.status === 'no_results' ? 'No results found' : undefined)
			}
		];

		return {
			id: `monitoring-${mon.id}`,
			activitySource: 'monitoring',
			taskType: mon.taskType ?? undefined,
			mediaType: mediaInfo.mediaType,
			mediaId: mediaInfo.mediaId,
			mediaTitle: mediaInfo.mediaTitle,
			mediaYear: mediaInfo.mediaYear,
			seriesId: mediaInfo.seriesId,
			seriesTitle: mediaInfo.seriesTitle,
			seasonNumber: mediaInfo.seasonNumber,
			episodeNumber: mediaInfo.episodeNumber,
			releaseTitle: null,
			quality: null,
			releaseGroup: null,
			size: null,
			indexerId: null,
			indexerName: null,
			protocol: null,
			status: mon.status === 'error' ? 'search_error' : 'no_results',
			statusReason: mon.errorMessage ?? undefined,
			isUpgrade: mon.isUpgrade ?? false,
			oldScore: mon.oldScore ?? undefined,
			newScore: mon.newScore ?? undefined,
			timeline,
			startedAt: executedAt,
			completedAt: executedAt,
			monitoringHistoryId: mon.id
		};
	}

	// Private helper methods

	private async fetchActiveDownloads(
		filters: ActivityFilters = {}
	): Promise<DownloadQueueRecord[]> {
		const baseStatuses = [
			'downloading',
			'queued',
			'paused',
			'stalled',
			'seeding',
			'seeding-imported',
			'completed',
			'postprocessing',
			'importing'
		];

		// Apply status filter at SQL level when possible
		let statusFilter: string[] = baseStatuses;
		if (filters.status && filters.status !== 'all') {
			const mapped = mapFilterStatusToQueueStatuses(filters.status);
			if (mapped) {
				statusFilter = mapped.filter((s) => baseStatuses.includes(s));
				// If no overlap (e.g. filtering for 'success' on active tab), return empty
				if (statusFilter.length === 0) return [];
			}
		}

		const conditions: SQL[] = [inArray(downloadQueue.status, statusFilter)];

		// Protocol filter
		if (filters.protocol && filters.protocol !== 'all') {
			conditions.push(eq(downloadQueue.protocol, filters.protocol));
		}

		// Download client filter
		if (filters.downloadClientId) {
			conditions.push(eq(downloadQueue.downloadClientId, filters.downloadClientId));
		}

		// Indexer filter (by name)
		if (filters.indexer) {
			conditions.push(sql`LOWER(${downloadQueue.indexerName}) = LOWER(${filters.indexer})`);
		}

		// Media type filter
		if (filters.mediaType === 'movie') {
			conditions.push(sql`${downloadQueue.movieId} IS NOT NULL`);
		} else if (filters.mediaType === 'tv') {
			conditions.push(sql`${downloadQueue.seriesId} IS NOT NULL`);
		}

		// Date filters (use addedAt for queue items)
		if (filters.startDate) {
			conditions.push(gte(downloadQueue.addedAt, filters.startDate));
		}
		if (filters.endDate) {
			const endDateEnd = filters.endDate + 'T23:59:59.999Z';
			conditions.push(lte(downloadQueue.addedAt, endDateEnd));
		}

		return db
			.select({
				id: downloadQueue.id,
				downloadClientId: downloadQueue.downloadClientId,
				downloadId: downloadQueue.downloadId,
				title: downloadQueue.title,
				indexerId: downloadQueue.indexerId,
				indexerName: downloadQueue.indexerName,
				protocol: downloadQueue.protocol,
				movieId: downloadQueue.movieId,
				seriesId: downloadQueue.seriesId,
				episodeIds: downloadQueue.episodeIds,
				seasonNumber: downloadQueue.seasonNumber,
				status: downloadQueue.status,
				progress: downloadQueue.progress,
				size: downloadQueue.size,
				quality: downloadQueue.quality,
				releaseGroup: downloadQueue.releaseGroup,
				addedAt: downloadQueue.addedAt,
				startedAt: downloadQueue.startedAt,
				completedAt: downloadQueue.completedAt,
				importedAt: downloadQueue.importedAt,
				errorMessage: downloadQueue.errorMessage,
				lastAttemptAt: downloadQueue.lastAttemptAt,
				isUpgrade: downloadQueue.isUpgrade
			})
			.from(downloadQueue)
			.where(and(...conditions))
			.orderBy(desc(downloadQueue.addedAt))
			.all() as DownloadQueueRecord[];
	}

	private async fetchFailedQueueItems(): Promise<
		Pick<DownloadQueueRecord, 'id' | 'downloadId' | 'title' | 'addedAt' | 'status'>[]
	> {
		return db
			.select({
				id: downloadQueue.id,
				downloadId: downloadQueue.downloadId,
				title: downloadQueue.title,
				addedAt: downloadQueue.addedAt,
				status: downloadQueue.status
			})
			.from(downloadQueue)
			.where(eq(downloadQueue.status, 'failed'))
			.all();
	}

	/**
	 * Lets Activity entries show whether their release is currently
	 * blocklisted, and when - without a per-item query.
	 */
	private async fetchBlocklistEntries(): Promise<
		{
			title: string;
			movieId: string | null;
			seriesId: string | null;
			createdAt: string | null;
			reason: string;
			expiresAt: string | null;
		}[]
	> {
		return db
			.select({
				title: blocklist.title,
				movieId: blocklist.movieId,
				seriesId: blocklist.seriesId,
				createdAt: blocklist.createdAt,
				reason: blocklist.reason,
				expiresAt: blocklist.expiresAt
			})
			.from(blocklist)
			.all();
	}

	private async fetchHistoryItems(filters: ActivityFilters = {}): Promise<DownloadHistoryRecord[]> {
		const conditions: SQL[] = [];

		// Status filter at SQL level
		if (filters.status && filters.status !== 'all') {
			const mapped = mapFilterStatusToHistoryStatuses(filters.status);
			if (mapped) {
				if (mapped.length === 0) return [];
				conditions.push(inArray(downloadHistory.status, mapped));
			}
		}

		// Protocol filter
		if (filters.protocol && filters.protocol !== 'all') {
			conditions.push(eq(downloadHistory.protocol, filters.protocol));
		}

		// Download client filter
		if (filters.downloadClientId) {
			conditions.push(eq(downloadHistory.downloadClientId, filters.downloadClientId));
		}

		// Indexer filter (by name)
		if (filters.indexer) {
			conditions.push(sql`LOWER(${downloadHistory.indexerName}) = LOWER(${filters.indexer})`);
		}

		// Media type filter
		if (filters.mediaType === 'movie') {
			conditions.push(sql`${downloadHistory.movieId} IS NOT NULL`);
		} else if (filters.mediaType === 'tv') {
			conditions.push(sql`${downloadHistory.seriesId} IS NOT NULL`);
		}

		// Date filters
		if (filters.startDate) {
			conditions.push(gte(downloadHistory.createdAt, filters.startDate));
		}
		if (filters.endDate) {
			const endDateEnd = filters.endDate + 'T23:59:59.999Z';
			conditions.push(lte(downloadHistory.createdAt, endDateEnd));
		}

		// Fetch up to 500 rows (raised from 200) -- SQL filters now keep this manageable
		const fetchLimit = 500;

		const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

		return db
			.select({
				id: downloadHistory.id,
				downloadClientId: downloadHistory.downloadClientId,
				downloadClientName: downloadHistory.downloadClientName,
				downloadId: downloadHistory.downloadId,
				title: downloadHistory.title,
				indexerId: downloadHistory.indexerId,
				indexerName: downloadHistory.indexerName,
				protocol: downloadHistory.protocol,
				movieId: downloadHistory.movieId,
				seriesId: downloadHistory.seriesId,
				episodeIds: downloadHistory.episodeIds,
				seasonNumber: downloadHistory.seasonNumber,
				status: downloadHistory.status,
				statusReason: downloadHistory.statusReason,
				size: downloadHistory.size,
				quality: downloadHistory.quality,
				releaseGroup: downloadHistory.releaseGroup,
				importedPath: downloadHistory.importedPath,
				transferMode: downloadHistory.transferMode,
				grabbedAt: downloadHistory.grabbedAt,
				completedAt: downloadHistory.completedAt,
				importedAt: downloadHistory.importedAt,
				createdAt: downloadHistory.createdAt
			})
			.from(downloadHistory)
			.where(whereClause)
			.orderBy(desc(downloadHistory.createdAt))
			.limit(fetchLimit)
			.all() as DownloadHistoryRecord[];
	}

	private async countHistoryFailed(): Promise<number> {
		const result = await db
			.select({ count: count() })
			.from(downloadHistory)
			.where(eq(downloadHistory.status, 'failed'))
			.get();
		return result?.count ?? 0;
	}

	/**
	 * Count history items matching SQL-level filters (no LIMIT cap).
	 * Uses the same WHERE conditions as fetchHistoryItems so the total is
	 * accurate even when the data fetch is capped.
	 */
	private async countHistoryItems(filters: ActivityFilters = {}): Promise<number> {
		const conditions: SQL[] = [];

		if (filters.status && filters.status !== 'all') {
			const mapped = mapFilterStatusToHistoryStatuses(filters.status);
			if (mapped) {
				if (mapped.length === 0) return 0;
				conditions.push(inArray(downloadHistory.status, mapped));
			}
		}
		if (filters.protocol && filters.protocol !== 'all') {
			conditions.push(eq(downloadHistory.protocol, filters.protocol));
		}
		if (filters.downloadClientId) {
			conditions.push(eq(downloadHistory.downloadClientId, filters.downloadClientId));
		}
		if (filters.indexer) {
			conditions.push(sql`LOWER(${downloadHistory.indexerName}) = LOWER(${filters.indexer})`);
		}
		if (filters.mediaType === 'movie') {
			conditions.push(sql`${downloadHistory.movieId} IS NOT NULL`);
		} else if (filters.mediaType === 'tv') {
			conditions.push(sql`${downloadHistory.seriesId} IS NOT NULL`);
		}
		if (filters.startDate) {
			conditions.push(gte(downloadHistory.createdAt, filters.startDate));
		}
		if (filters.endDate) {
			const endDateEnd = filters.endDate + 'T23:59:59.999Z';
			conditions.push(lte(downloadHistory.createdAt, endDateEnd));
		}

		const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
		const result = await db
			.select({ count: count() })
			.from(downloadHistory)
			.where(whereClause)
			.get();
		return result?.count ?? 0;
	}

	private async fetchMonitoringItems(
		includeNoResults?: boolean,
		filters: ActivityFilters = {}
	): Promise<MonitoringHistoryRecord[]> {
		// Build status filter based on includeNoResults flag
		// By default (undefined/false), exclude 'no_results' to reduce noise
		const baseStatuses = includeNoResults
			? ['no_results', 'error', 'skipped']
			: ['error', 'skipped'];

		// If user is filtering by a specific status, narrow monitoring statuses accordingly
		let monitoringStatuses = baseStatuses;
		if (filters.status && filters.status !== 'all') {
			if (filters.status === 'failed' || filters.status === 'search_error') {
				monitoringStatuses = baseStatuses.filter((s) => s === 'error');
			} else if (filters.status === 'no_results') {
				monitoringStatuses = baseStatuses.filter((s) => s === 'no_results');
				if (monitoringStatuses.length === 0) return [];
			} else if (
				filters.status === 'success' ||
				filters.status === 'downloading' ||
				filters.status === 'seeding' ||
				filters.status === 'paused' ||
				filters.status === 'removed' ||
				filters.status === 'rejected'
			) {
				// Monitoring items never have these statuses
				return [];
			}
		}

		const conditions: SQL[] = [inArray(monitoringHistory.status, monitoringStatuses)];

		// Exclude subtitle search noise in SQL (previously done in JS post-query)
		conditions.push(
			sql`NOT (${monitoringHistory.taskType} = 'missingSubtitles' AND ${monitoringHistory.status} = 'no_results')`
		);

		// Media type filter
		if (filters.mediaType === 'movie') {
			conditions.push(sql`${monitoringHistory.movieId} IS NOT NULL`);
		} else if (filters.mediaType === 'tv') {
			conditions.push(sql`${monitoringHistory.seriesId} IS NOT NULL`);
		}

		// Date filters
		if (filters.startDate) {
			conditions.push(gte(monitoringHistory.executedAt, filters.startDate));
		}
		if (filters.endDate) {
			const endDateEnd = filters.endDate + 'T23:59:59.999Z';
			conditions.push(lte(monitoringHistory.executedAt, endDateEnd));
		}

		// Fetch up to 300 rows (raised from 100) -- SQL filters keep this manageable
		const fetchLimit = 300;

		const items = (await db
			.select({
				id: monitoringHistory.id,
				taskType: monitoringHistory.taskType,
				movieId: monitoringHistory.movieId,
				seriesId: monitoringHistory.seriesId,
				seasonNumber: monitoringHistory.seasonNumber,
				episodeId: monitoringHistory.episodeId,
				status: monitoringHistory.status,
				releasesFound: monitoringHistory.releasesFound,
				releaseGrabbed: monitoringHistory.releaseGrabbed,
				queueItemId: monitoringHistory.queueItemId,
				isUpgrade: monitoringHistory.isUpgrade,
				oldScore: monitoringHistory.oldScore,
				newScore: monitoringHistory.newScore,
				executedAt: monitoringHistory.executedAt,
				errorMessage: monitoringHistory.errorMessage
			})
			.from(monitoringHistory)
			.where(and(...conditions))
			.orderBy(desc(monitoringHistory.executedAt))
			.limit(fetchLimit)
			.all()) as MonitoringHistoryRecord[];

		return items;
	}

	/**
	 * Count monitoring items matching SQL-level filters (no LIMIT cap).
	 * Mirrors the WHERE logic in fetchMonitoringItems, plus excludes
	 * subtitle noise in SQL so the count is accurate.
	 */
	private async countMonitoringItems(
		includeNoResults?: boolean,
		filters: ActivityFilters = {}
	): Promise<number> {
		const baseStatuses = includeNoResults
			? ['no_results', 'error', 'skipped']
			: ['error', 'skipped'];

		let monitoringStatuses = baseStatuses;
		if (filters.status && filters.status !== 'all') {
			if (filters.status === 'failed') {
				monitoringStatuses = baseStatuses.filter((s) => s === 'error');
			} else if (filters.status === 'no_results') {
				monitoringStatuses = baseStatuses.filter((s) => s === 'no_results');
				if (monitoringStatuses.length === 0) return 0;
			} else if (
				filters.status === 'success' ||
				filters.status === 'downloading' ||
				filters.status === 'seeding' ||
				filters.status === 'paused' ||
				filters.status === 'removed' ||
				filters.status === 'rejected'
			) {
				return 0;
			}
		}

		const conditions: SQL[] = [inArray(monitoringHistory.status, monitoringStatuses)];

		// Exclude subtitle noise in SQL (matches the JS filter in fetchMonitoringItems)
		conditions.push(
			sql`NOT (${monitoringHistory.taskType} = 'missingSubtitles' AND ${monitoringHistory.status} = 'no_results')`
		);

		if (filters.mediaType === 'movie') {
			conditions.push(sql`${monitoringHistory.movieId} IS NOT NULL`);
		} else if (filters.mediaType === 'tv') {
			conditions.push(sql`${monitoringHistory.seriesId} IS NOT NULL`);
		}
		if (filters.startDate) {
			conditions.push(gte(monitoringHistory.executedAt, filters.startDate));
		}
		if (filters.endDate) {
			const endDateEnd = filters.endDate + 'T23:59:59.999Z';
			conditions.push(lte(monitoringHistory.executedAt, endDateEnd));
		}

		const result = await db
			.select({ count: count() })
			.from(monitoringHistory)
			.where(and(...conditions))
			.get();
		return result?.count ?? 0;
	}

	private async fetchMoveTasks(
		scope: ActivityScope,
		filters: ActivityFilters = {}
	): Promise<MoveTaskRecord[]> {
		const conditions: SQL[] = [sql`${taskHistory.taskId} LIKE 'media-move:%'`];

		const statuses = mapMoveStatusesForScopeAndFilter(scope, filters.status ?? 'all');
		if (statuses.length === 0) return [];
		conditions.push(inArray(taskHistory.status, statuses));

		if (filters.mediaType === 'movie') {
			conditions.push(sql`${taskHistory.taskId} LIKE 'media-move:movie:%'`);
		} else if (filters.mediaType === 'tv') {
			conditions.push(sql`${taskHistory.taskId} LIKE 'media-move:series:%'`);
		}

		if (filters.protocol && filters.protocol !== 'all') {
			return [];
		}
		if (filters.downloadClientId || filters.indexer) {
			return [];
		}

		if (filters.startDate) {
			conditions.push(gte(taskHistory.startedAt, filters.startDate));
		}
		if (filters.endDate) {
			const endDateEnd = filters.endDate + 'T23:59:59.999Z';
			conditions.push(lte(taskHistory.startedAt, endDateEnd));
		}

		return (await db
			.select({
				id: taskHistory.id,
				taskId: taskHistory.taskId,
				status: taskHistory.status,
				results: taskHistory.results,
				errors: taskHistory.errors,
				startedAt: taskHistory.startedAt,
				completedAt: taskHistory.completedAt
			})
			.from(taskHistory)
			.where(and(...conditions))
			.orderBy(desc(taskHistory.startedAt))
			.limit(500)
			.all()) as MoveTaskRecord[];
	}

	private async countMoveTasks(
		scope: ActivityScope,
		filters: ActivityFilters = {}
	): Promise<number> {
		const conditions: SQL[] = [sql`${taskHistory.taskId} LIKE 'media-move:%'`];

		const statuses = mapMoveStatusesForScopeAndFilter(scope, filters.status ?? 'all');
		if (statuses.length === 0) return 0;
		conditions.push(inArray(taskHistory.status, statuses));

		if (filters.mediaType === 'movie') {
			conditions.push(sql`${taskHistory.taskId} LIKE 'media-move:movie:%'`);
		} else if (filters.mediaType === 'tv') {
			conditions.push(sql`${taskHistory.taskId} LIKE 'media-move:series:%'`);
		}

		if (filters.protocol && filters.protocol !== 'all') {
			return 0;
		}
		if (filters.downloadClientId || filters.indexer) {
			return 0;
		}

		if (filters.startDate) {
			conditions.push(gte(taskHistory.startedAt, filters.startDate));
		}
		if (filters.endDate) {
			const endDateEnd = filters.endDate + 'T23:59:59.999Z';
			conditions.push(lte(taskHistory.startedAt, endDateEnd));
		}

		const result = await db
			.select({ count: count() })
			.from(taskHistory)
			.where(and(...conditions))
			.get();
		return result?.count ?? 0;
	}

	private transformMoveTasks(tasks: MoveTaskRecord[]): UnifiedActivity[] {
		return tasks
			.map((task) => this.transformMoveTask(task))
			.filter((activity): activity is UnifiedActivity => activity !== null);
	}

	private transformMoveTask(task: MoveTaskRecord): UnifiedActivity | null {
		const parsed = parseMoveTaskId(task.taskId);
		if (!parsed) return null;

		const mediaType = parsed.mediaType === 'movie' ? 'movie' : 'episode';
		const defaultTitle = parsed.mediaType === 'movie' ? 'Movie' : 'Series';
		const results = task.results ?? {};
		const resultsMediaTitle =
			typeof results.mediaTitle === 'string' && results.mediaTitle.trim().length > 0
				? results.mediaTitle.trim()
				: null;
		const mediaTitle = resultsMediaTitle ?? defaultTitle;

		const mappedStatus = mapMoveTaskStatus(task.status);
		const statusReason =
			task.status === 'failed'
				? (task.errors?.[0] ?? 'Failed to move media files')
				: task.status === 'cancelled'
					? (task.errors?.[0] ?? 'Move cancelled')
					: undefined;

		const startedAt = task.startedAt ?? new Date().toISOString();
		const completedAt = task.completedAt ?? null;
		const timeline: ActivityEvent[] = [{ type: 'searched', timestamp: startedAt }];
		if (task.status === 'running') {
			timeline.push({
				type: 'downloading',
				timestamp: startedAt,
				details: 'Moving files to new root folder'
			});
		} else if (task.status === 'completed') {
			timeline.push({
				type: 'imported',
				timestamp: completedAt ?? startedAt,
				details:
					typeof results.destPath === 'string' && results.destPath
						? `Moved to ${results.destPath}`
						: 'Moved to new root folder'
			});
		} else if (task.status === 'failed') {
			timeline.push({
				type: 'failed',
				timestamp: completedAt ?? startedAt,
				details: statusReason
			});
		} else if (task.status === 'cancelled') {
			timeline.push({
				type: 'removed',
				timestamp: completedAt ?? startedAt,
				details: statusReason
			});
		}

		return {
			id: `task-${task.id}`,
			activitySource: 'task',
			taskType: 'media_move',
			mediaType,
			mediaId: parsed.mediaId,
			mediaTitle,
			mediaYear: null,
			seriesId: mediaType === 'episode' ? parsed.mediaId : undefined,
			seriesTitle: mediaType === 'episode' ? mediaTitle : undefined,
			releaseTitle: 'Move media files to new root folder',
			quality: null,
			releaseGroup: null,
			size: null,
			indexerId: null,
			indexerName: null,
			protocol: null,
			status: mappedStatus,
			statusReason,
			isUpgrade: false,
			timeline,
			startedAt,
			completedAt,
			lastAttemptAt: task.status === 'failed' ? (completedAt ?? startedAt) : null
		};
	}

	private async fetchMediaMaps(
		activeDownloads: DownloadQueueRecord[],
		historyItems: DownloadHistoryRecord[],
		monitoringItems: MonitoringHistoryRecord[]
	): Promise<MediaMaps> {
		// Collect all IDs
		const movieIds = new Set<string>([
			...activeDownloads.filter((d) => d.movieId).map((d) => d.movieId!),
			...historyItems.filter((h) => h.movieId).map((h) => h.movieId!),
			...monitoringItems.filter((m) => m.movieId).map((m) => m.movieId!)
		]);

		const seriesIds = new Set<string>([
			...activeDownloads.filter((d) => d.seriesId).map((d) => d.seriesId!),
			...historyItems.filter((h) => h.seriesId).map((h) => h.seriesId!),
			...monitoringItems.filter((m) => m.seriesId).map((m) => m.seriesId!)
		]);

		const episodeIds = new Set<string>([
			...activeDownloads.filter((d) => d.episodeIds).flatMap((d) => d.episodeIds || []),
			...historyItems.filter((h) => h.episodeIds).flatMap((h) => h.episodeIds || []),
			...monitoringItems.filter((m) => m.episodeId).map((m) => m.episodeId!)
		]);

		// Fetch movies and episodes in parallel first so we can bridge episode → series
		const [moviesData, episodesData] = await Promise.all([
			movieIds.size > 0
				? db
						.select({ id: movies.id, title: movies.title, year: movies.year })
						.from(movies)
						.where(inArray(movies.id, Array.from(movieIds)))
						.all()
				: Promise.resolve([]),
			episodeIds.size > 0
				? db
						.select({
							id: episodes.id,
							seriesId: episodes.seriesId,
							episodeNumber: episodes.episodeNumber,
							seasonNumber: episodes.seasonNumber
						})
						.from(episodes)
						.where(inArray(episodes.id, Array.from(episodeIds)))
						.all()
				: Promise.resolve([])
		]);

		// Include series IDs bridged from episodes whose monitoringHistory row lacks seriesId
		// (older records written before the source fix was applied)
		for (const ep of episodesData) {
			if (ep.seriesId) seriesIds.add(ep.seriesId);
		}

		const seriesData =
			seriesIds.size > 0
				? await db
						.select({ id: series.id, title: series.title, year: series.year })
						.from(series)
						.where(inArray(series.id, Array.from(seriesIds)))
						.all()
				: [];

		return {
			movies: new Map(moviesData.map((m) => [m.id, m])),
			series: new Map(seriesData.map((s) => [s.id, s])),
			episodes: new Map(
				episodesData.map((e) => [
					e.id,
					{
						id: e.id,
						seriesId: e.seriesId,
						episodeNumber: e.episodeNumber,
						seasonNumber: e.seasonNumber
					}
				])
			)
		};
	}

	private async fetchMonitoringForQueue(
		queueIds: string[]
	): Promise<Map<string, MonitoringHistoryRecord[]>> {
		if (queueIds.length === 0) return new Map();

		const linkedMonitoring = await db
			.select()
			.from(monitoringHistory)
			.where(inArray(monitoringHistory.queueItemId, queueIds))
			.all();

		const map = new Map<string, MonitoringHistoryRecord[]>();
		for (const m of linkedMonitoring) {
			if (m.queueItemId) {
				const existing = map.get(m.queueItemId) || [];
				existing.push(m);
				map.set(m.queueItemId, existing);
			}
		}
		return map;
	}

	private transformQueueItems(
		downloads: DownloadQueueRecord[],
		mediaMaps: MediaMaps,
		monitoringByQueueId: Map<string, MonitoringHistoryRecord[]>
	): UnifiedActivity[] {
		return downloads.map((download) =>
			this.transformQueueItem(download, mediaMaps, monitoringByQueueId.get(download.id) || [])
		);
	}

	private transformHistoryItems(
		historyItems: DownloadHistoryRecord[],
		mediaMaps: MediaMaps,
		activeDownloads: DownloadQueueRecord[],
		failedQueueIndex?: Map<string, string>,
		blocklistIndex?: Map<string, BlocklistEntryInfo>
	): UnifiedActivity[] {
		// Build the active queue index once for all history items (O(n) build, O(1) lookups)
		const activeIndex = this.deduplicationService.buildActiveQueueIndex(activeDownloads);

		return historyItems
			.map((history) =>
				this.transformHistoryItemWithIndex(
					history,
					mediaMaps,
					activeIndex,
					failedQueueIndex,
					blocklistIndex
				)
			)
			.filter((activity): activity is UnifiedActivity => activity !== null);
	}

	/**
	 * Internal transform using a pre-built active queue index for O(1) dedup lookups.
	 */
	private transformHistoryItemWithIndex(
		history: DownloadHistoryRecord,
		mediaMaps: MediaMaps,
		activeIndex: ActiveQueueIndex,
		failedQueueIndex?: Map<string, string>,
		blocklistIndex?: Map<string, BlocklistEntryInfo>
	): UnifiedActivity | null {
		if (this.deduplicationService.isHistoryRepresentedByActiveQueueIndexed(history, activeIndex)) {
			return null;
		}

		const blocklistEntry = findBlocklistEntry(history, blocklistIndex);
		const timeline = buildHistoryTimeline(history, blocklistEntry);
		const mediaInfo = resolveMediaInfo(history, mediaMaps);
		const queueItemId =
			history.status === 'failed' ? findFailedQueueItemId(history, failedQueueIndex) : undefined;

		return {
			id: `history-${history.id}`,
			activitySource: 'download_history' as const,
			mediaType: mediaInfo.mediaType,
			mediaId: mediaInfo.mediaId,
			mediaTitle: mediaInfo.mediaTitle,
			mediaYear: mediaInfo.mediaYear,
			seriesId: mediaInfo.seriesId,
			seriesTitle: mediaInfo.seriesTitle,
			seasonNumber: mediaInfo.seasonNumber,
			episodeNumber: mediaInfo.episodeNumber,
			episodeIds: history.episodeIds ?? undefined,
			releaseTitle: history.title,
			quality: history.quality ?? null,
			releaseGroup: history.releaseGroup ?? null,
			size: history.size ?? null,
			indexerId: history.indexerId ?? null,
			indexerName: history.indexerName ?? null,
			protocol: (history.protocol as 'torrent' | 'usenet' | 'streaming') ?? null,
			downloadClientId: history.downloadClientId ?? null,
			downloadClientName: history.downloadClientName ?? null,
			status: history.status as ActivityStatus,
			statusReason: history.statusReason ?? undefined,
			isUpgrade: false,
			timeline,
			startedAt:
				history.createdAt ||
				history.importedAt ||
				history.completedAt ||
				history.grabbedAt ||
				new Date().toISOString(),
			completedAt: history.importedAt || history.completedAt || null,
			queueItemId,
			downloadHistoryId: history.id,
			importedPath: history.importedPath ?? undefined,
			transferMode: (history.transferMode as UnifiedActivity['transferMode']) ?? undefined,
			isBlocklisted: blocklistEntry ? isBlocklistEntryActive(blocklistEntry) : false
		};
	}

	private transformMonitoringItems(
		monitoringItems: MonitoringHistoryRecord[],
		mediaMaps: MediaMaps
	): UnifiedActivity[] {
		const processedKeys = new Set<string>();
		return monitoringItems
			.map((mon) => this.transformMonitoringItem(mon, mediaMaps, processedKeys))
			.filter((activity): activity is UnifiedActivity => activity !== null);
	}
}

// Export singleton instance
export const activityService = ActivityService.getInstance();
