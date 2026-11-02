/**
 * Radarr/Sonarr-compatible `history` response.
 *
 * Field set confirmed against HistoryResourcePagingResource / HistoryResource
 * in Radarr/Sonarr's actual openapi.json, backed by Cinephage's own
 * `download_history` table.
 *
 * Real Radarr/Sonarr history is a full event timeline (grabbed, then
 * imported/failed/rejected as a separate record over time for the same
 * download) - each `download_history` row already carries the timestamps
 * for every stage (`grabbedAt`/`completedAt`/`importedAt`/`createdAt`), the
 * same columns the Activity page's own timeline view is built from (see
 * `buildHistoryTimeline` in `activity-transformers.ts`), so this reuses that
 * helper to emit one HistoryResource per timeline event instead of
 * flattening a download down to a single final-outcome row.
 */

import { db } from '#lib/server/db/index.js';
import { downloadHistory } from '#lib/server/db/schema.js';
import { buildHistoryTimeline } from '#lib/server/activity/activity-transformers.js';
import type { ActivityEventType } from '#lib/types/activity.js';
import { getOrAssignArrId, getOrAssignArrIds } from './ArrIdMappingService.js';
import type { ArrAppName } from './systemStatus.js';

// Cinephage's per-event ActivityEventType (the same set the Activity page's
// timeline renders) -> Radarr's MovieHistoryEventType / Sonarr's
// EpisodeHistoryEventType. Both enums are structurally the same shape
// (grabbed | *FolderImported | downloadFailed | *FileDeleted | *FileRenamed
// | downloadIgnored | unknown), just with movie/episode-prefixed variants -
// a single map works for both personas. 'completed' has no real arr
// equivalent (a real client never sees a separate "download finished, not
// yet imported" history entry) so it's intentionally left unmapped/skipped.
const EVENT_TYPE_MAP: Partial<Record<ActivityEventType, string>> = {
	grabbed: 'grabbed',
	imported: 'downloadFolderImported',
	failed: 'downloadFailed',
	rejected: 'downloadIgnored'
};

interface HistoryQueryOptions {
	page: number;
	pageSize: number;
	sortKey: string | null;
	sortDirection: string;
}

export async function buildHistory(appName: ArrAppName, options: HistoryQueryOptions) {
	const rows = await db.select().from(downloadHistory);

	const scoped = rows.filter((row) => (appName === 'Radarr' ? !!row.movieId : !!row.seriesId));

	const mediaIds = scoped
		.map((row) => (appName === 'Radarr' ? row.movieId : row.seriesId))
		.filter((id) => !!id) as string[];
	const mediaArrIds = await getOrAssignArrIds(appName === 'Radarr' ? 'movie' : 'series', mediaIds);

	// Each row can expand into several history records - one per timeline
	// event that has a real arr equivalent - so this is a flatMap, not a map.
	const nested = await Promise.all(
		scoped.map(async (row) => {
			const resolution = row.quality?.resolution
				? Number.parseInt(row.quality.resolution, 10) || 0
				: 0;
			const mediaArrId = (() => {
				const mediaId = appName === 'Radarr' ? row.movieId : row.seriesId;
				// HistoryResource.movieId/seriesId aren't marked nullable in the
				// real spec at all - default to 0 rather than null (see queue.ts
				// for the confirmed real-world crash this pattern causes).
				return mediaId ? (mediaArrIds.get(mediaId) ?? 0) : 0;
			})();

			const events = buildHistoryTimeline(row).filter((event) => event.type in EVENT_TYPE_MAP);

			return Promise.all(
				events.map(async (event) => {
					const record: Record<string, unknown> = {
						id: await getOrAssignArrId('history', `${row.id}:${event.type}`),
						sourceTitle: row.title,
						quality: {
							quality: { id: 1, name: row.quality?.resolution ?? 'Unknown', resolution },
							revision: { version: 1, real: 0, isRepack: false }
						},
						customFormatScore: 0,
						qualityCutoffNotMet: false,
						date: event.timestamp,
						downloadId: row.downloadId,
						eventType: EVENT_TYPE_MAP[event.type],
						data: event.details ? { message: event.details } : {}
					};
					if (appName === 'Radarr') {
						record.movieId = mediaArrId;
					} else {
						record.seriesId = mediaArrId;
					}
					return record;
				})
			);
		})
	);

	const records = nested
		.flat()
		.sort((a, b) => new Date(b.date as string).getTime() - new Date(a.date as string).getTime());

	const totalRecords = records.length;
	const page = Math.max(1, options.page);
	const pageSize = Math.max(1, options.pageSize);
	const paged = records.slice((page - 1) * pageSize, page * pageSize);

	return {
		page,
		pageSize,
		sortKey: options.sortKey,
		sortDirection: options.sortDirection,
		totalRecords,
		records: paged
	};
}
