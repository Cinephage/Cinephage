import { normalizeReleaseKey, isSameMediaTarget } from './dedup-utils.js';
import type { DownloadQueueRecord, DownloadHistoryRecord } from './types.js';
import type { UnifiedActivity } from '#lib/types/activity.js';

export interface ActiveQueueIndex {
	byDownloadId: Map<string, DownloadQueueRecord>;
	byNormalizedTitle: Map<string, DownloadQueueRecord>;
	byMovieId: Set<string>;
	bySeriesId: Set<string>;
	byAddedAt: Map<string, DownloadQueueRecord[]>;
	titleEntries: { key: string; item: DownloadQueueRecord }[];
	hasAnyWithoutMediaLink: boolean;
	items: DownloadQueueRecord[];
}

export class ActivityDeduplicationService {
	buildActiveQueueIndex(activeDownloads: DownloadQueueRecord[]): ActiveQueueIndex {
		const byDownloadId = new Map<string, DownloadQueueRecord>();
		const byNormalizedTitle = new Map<string, DownloadQueueRecord>();
		const byMovieId = new Set<string>();
		const bySeriesId = new Set<string>();
		const byAddedAt = new Map<string, DownloadQueueRecord[]>();
		const titleEntries: { key: string; item: DownloadQueueRecord }[] = [];
		const hasAnyWithoutMediaLink = activeDownloads.some((d) => !d.movieId && !d.seriesId);

		for (const item of activeDownloads) {
			if (item.downloadId) {
				byDownloadId.set(item.downloadId, item);
			}
			const titleKey = normalizeReleaseKey(item.title);
			if (titleKey) {
				byNormalizedTitle.set(titleKey, item);
				titleEntries.push({ key: titleKey, item });
			}
			if (item.movieId) byMovieId.add(item.movieId);
			if (item.seriesId) bySeriesId.add(item.seriesId);
			if (item.addedAt) {
				const existing = byAddedAt.get(item.addedAt) || [];
				existing.push(item);
				byAddedAt.set(item.addedAt, existing);
			}
		}

		return {
			byDownloadId,
			byNormalizedTitle,
			byMovieId,
			bySeriesId,
			byAddedAt,
			titleEntries,
			hasAnyWithoutMediaLink,
			items: activeDownloads
		};
	}

	isHistoryRepresentedByActiveQueueIndexed(
		history: DownloadHistoryRecord,
		index: ActiveQueueIndex
	): boolean {
		if (index.items.length === 0) return false;

		// Fast path 1: exact downloadId match
		if (history.downloadId && index.byDownloadId.has(history.downloadId)) {
			return true;
		}

		const historyTitleKey = normalizeReleaseKey(history.title);
		const hasHistoryMediaLink = Boolean(history.movieId || history.seriesId);

		// Fast path 2: exact title match + (same media OR same grabbedAt OR no media link)
		if (historyTitleKey) {
			const queueByTitle = index.byNormalizedTitle.get(historyTitleKey);
			if (queueByTitle) {
				// sameTitle is true, check remaining conditions
				const sameMovie = Boolean(
					history.movieId && queueByTitle.movieId && history.movieId === queueByTitle.movieId
				);
				const sameSeries = Boolean(
					history.seriesId && queueByTitle.seriesId && history.seriesId === queueByTitle.seriesId
				);
				const sameGrabbedAt = Boolean(
					history.grabbedAt && queueByTitle.addedAt && history.grabbedAt === queueByTitle.addedAt
				);
				const hasQueueMediaLink = Boolean(queueByTitle.movieId || queueByTitle.seriesId);
				const sameProtocol = Boolean(
					history.protocol && queueByTitle.protocol && history.protocol === queueByTitle.protocol
				);
				const protocolCompatible = !history.protocol || !queueByTitle.protocol || sameProtocol;

				if (sameMovie || sameSeries || sameGrabbedAt) return true;
				if (isSameMediaTarget(history, queueByTitle)) return true;
				if (protocolCompatible && (!hasHistoryMediaLink || !hasQueueMediaLink)) return true;
			}
		}

		// Fast path 3: same grabbedAt + same movie/series
		if (history.grabbedAt) {
			const queueItemsAtTime = index.byAddedAt.get(history.grabbedAt);
			if (queueItemsAtTime) {
				for (const queueItem of queueItemsAtTime) {
					const sameMovie = Boolean(
						history.movieId && queueItem.movieId && history.movieId === queueItem.movieId
					);
					const sameSeries = Boolean(
						history.seriesId && queueItem.seriesId && history.seriesId === queueItem.seriesId
					);
					if (sameMovie || sameSeries) return true;
					if (isSameMediaTarget(history, queueItem)) return true;
				}
			}
		}

		// Fast path 4: same media + same grabbedAt (check media exists in index)
		if (history.movieId && index.byMovieId.has(history.movieId) && history.grabbedAt) {
			const queueItemsAtTime = index.byAddedAt.get(history.grabbedAt);
			if (queueItemsAtTime?.some((q) => q.movieId === history.movieId)) return true;
		}
		if (history.seriesId && index.bySeriesId.has(history.seriesId) && history.grabbedAt) {
			const queueItemsAtTime = index.byAddedAt.get(history.grabbedAt);
			if (queueItemsAtTime?.some((q) => q.seriesId === history.seriesId)) return true;
		}

		// Slow path: substring title matching (only when exact title didn't match)
		// This handles cases where title normalization results in containment rather than equality
		if (historyTitleKey && historyTitleKey.length > 12) {
			for (const entry of index.titleEntries) {
				if (entry.key === historyTitleKey) continue; // already checked exact match above
				const isSubstring =
					(entry.key.length > 12 && entry.key.includes(historyTitleKey)) ||
					historyTitleKey.includes(entry.key);
				if (!isSubstring) continue;

				const queueItem = entry.item;
				const sameMovie = Boolean(
					history.movieId && queueItem.movieId && history.movieId === queueItem.movieId
				);
				const sameSeries = Boolean(
					history.seriesId && queueItem.seriesId && history.seriesId === queueItem.seriesId
				);
				const sameGrabbedAt = Boolean(
					history.grabbedAt && queueItem.addedAt && history.grabbedAt === queueItem.addedAt
				);
				const hasQueueMediaLink = Boolean(queueItem.movieId || queueItem.seriesId);
				const sameProtocol = Boolean(
					history.protocol && queueItem.protocol && history.protocol === queueItem.protocol
				);
				const protocolCompatible = !history.protocol || !queueItem.protocol || sameProtocol;

				if (sameMovie || sameSeries || sameGrabbedAt) return true;
				if (isSameMediaTarget(history, queueItem)) return true;
				if (protocolCompatible && (!hasHistoryMediaLink || !hasQueueMediaLink)) return true;
			}
		}

		// Fallback for short-titled items with no media link (rare case)
		if (historyTitleKey && !hasHistoryMediaLink && index.hasAnyWithoutMediaLink) {
			const queueByTitle = index.byNormalizedTitle.get(historyTitleKey);
			if (queueByTitle) {
				const hasQueueMediaLink = Boolean(queueByTitle.movieId || queueByTitle.seriesId);
				if (!hasQueueMediaLink) {
					const protocolCompatible =
						!history.protocol ||
						!queueByTitle.protocol ||
						history.protocol === queueByTitle.protocol;
					if (protocolCompatible) return true;
				}
			}
		}

		return false;
	}

	buildActiveDedupKey(activity: UnifiedActivity): string {
		const releaseKey = normalizeReleaseKey(
			activity.releaseTitle || activity.mediaTitle || activity.id
		);
		const mediaTitleKey = normalizeReleaseKey(activity.mediaTitle || activity.id);
		const mediaKey =
			activity.mediaType === 'movie'
				? `movie:${activity.mediaId || mediaTitleKey}`
				: activity.seriesId
					? `series:${activity.seriesId}`
					: `fallback:${activity.mediaType}:${mediaTitleKey}`;

		return `${mediaKey}|release:${releaseKey}`;
	}

	getActiveDedupPriority(activity: UnifiedActivity): [number, number, number] {
		const statusPriority =
			activity.status === 'downloading' || activity.status === 'seeding'
				? 0
				: activity.status === 'paused' || activity.status === 'searching'
					? 1
					: activity.status === 'failed'
						? 2
						: 3;

		const sourcePriority = activity.id.startsWith('queue-') ? 0 : 1;
		const startedAtMs = Number.isFinite(new Date(activity.startedAt).getTime())
			? new Date(activity.startedAt).getTime()
			: 0;
		const recencyPriority = -startedAtMs;

		return [statusPriority, sourcePriority, recencyPriority];
	}

	shouldPreferActiveCandidate(candidate: UnifiedActivity, existing: UnifiedActivity): boolean {
		const [candidateStatus, candidateSource, candidateRecency] =
			this.getActiveDedupPriority(candidate);
		const [existingStatus, existingSource, existingRecency] = this.getActiveDedupPriority(existing);

		if (candidateStatus !== existingStatus) return candidateStatus < existingStatus;
		if (candidateSource !== existingSource) return candidateSource < existingSource;
		return candidateRecency < existingRecency;
	}

	deduplicateHistoryActivities(activities: UnifiedActivity[]): UnifiedActivity[] {
		const seen = new Map<string, UnifiedActivity>();
		for (const activity of activities) {
			const key = `${activity.status}:${this.buildActiveDedupKey(activity)}`;
			const existing = seen.get(key);
			if (!existing || activity.startedAt > existing.startedAt) {
				seen.set(key, activity);
			}
		}
		return [...seen.values()];
	}

	dedupeActiveActivities(activities: UnifiedActivity[]): UnifiedActivity[] {
		const dedupedByKey = new Map<string, UnifiedActivity>();
		const stableOrder: string[] = [];

		for (const activity of activities) {
			const key = this.buildActiveDedupKey(activity);
			if (!dedupedByKey.has(key)) {
				dedupedByKey.set(key, activity);
				stableOrder.push(key);
				continue;
			}

			const existing = dedupedByKey.get(key)!;
			if (this.shouldPreferActiveCandidate(activity, existing)) {
				dedupedByKey.set(key, activity);
			}
		}

		return stableOrder
			.map((key) => dedupedByKey.get(key))
			.filter((activity): activity is UnifiedActivity => Boolean(activity));
	}
}
