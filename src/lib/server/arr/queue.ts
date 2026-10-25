/**
 * Radarr/Sonarr-compatible `queue` (full listing) response - backs the same
 * data as Cinephage's own Activity/Queue page (`GET /api/queue`, driven by
 * the `download_queue` table). Field set confirmed against QueueResource
 * (and its Sonarr counterpart, which swaps movieId for seriesId/episodeId)
 * in Radarr/Sonarr's actual openapi.json.
 */

import { and, isNotNull, isNull, not, inArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { downloadQueue, downloadClients } from '#lib/server/db/schema.js';
import { getOrAssignArrId, getOrAssignArrIds } from './ArrIdMappingService.js';
import type { ArrAppName } from './systemStatus.js';

// Terminal statuses - already fully done and imported/removed, not part of
// an active queue view. Matches the same convention src/routes/api/queue
// uses for Cinephage's own Activity page.
const TERMINAL_STATUSES = ['imported', 'removed'];

// Cinephage's own queue status values -> Radarr/Sonarr's QueueStatus enum
// (unknown | queued | paused | downloading | completed | failed | warning |
// delay | downloadClientUnavailable | fallback).
const STATUS_MAP: Record<string, string> = {
	queued: 'queued',
	downloading: 'downloading',
	paused: 'paused',
	completed: 'completed',
	postprocessing: 'completed',
	importing: 'completed',
	imported: 'completed',
	failed: 'failed',
	seeding: 'completed'
};

// -> TrackedDownloadState enum (downloading | importBlocked | importPending
// | importing | imported | failedPending | failed | ignored).
const TRACKED_STATE_MAP: Record<string, string> = {
	queued: 'downloading',
	downloading: 'downloading',
	paused: 'downloading',
	completed: 'importPending',
	seeding: 'importPending',
	postprocessing: 'importing',
	importing: 'importing',
	imported: 'imported',
	failed: 'failed'
};

// -> DownloadProtocol enum (unknown | usenet | torrent). Debrid acquisition
// is fundamentally torrent-sourced content fetched via a debrid provider
// instead of a local client, so it maps to 'torrent'; streaming has no
// real analog.
const PROTOCOL_MAP: Record<string, string> = {
	torrent: 'torrent',
	usenet: 'usenet',
	debrid: 'torrent',
	streaming: 'unknown'
};

interface QueueQueryOptions {
	page: number;
	pageSize: number;
	sortKey: string | null;
	sortDirection: string;
}

/**
 * The full mapped-record list for a persona, unpaginated - shared by
 * `buildQueue` (paginates it) and `buildQueueDetails` (filters it by
 * movieId/seriesId, matching the real /queue/details endpoint's contract).
 */
async function getQueueRecords(appName: ArrAppName): Promise<Record<string, unknown>[]> {
	const mediaFilter =
		appName === 'Radarr'
			? and(isNotNull(downloadQueue.movieId), isNull(downloadQueue.seriesId))
			: and(isNotNull(downloadQueue.seriesId), isNull(downloadQueue.movieId));

	const rows = await db
		.select()
		.from(downloadQueue)
		.where(and(mediaFilter, not(inArray(downloadQueue.status, TERMINAL_STATUSES))));

	const clientIds = [...new Set(rows.map((row) => row.downloadClientId))];
	const clientsData = clientIds.length
		? await db
				.select({ id: downloadClients.id, name: downloadClients.name })
				.from(downloadClients)
				.where(inArray(downloadClients.id, clientIds))
		: [];
	const clientMap = new Map(clientsData.map((client) => [client.id, client.name]));

	const queueArrIds = await getOrAssignArrIds(
		appName === 'Radarr' ? 'movie' : 'series',
		rows
			.map((row) => (appName === 'Radarr' ? row.movieId : row.seriesId))
			.filter((id) => !!id) as string[]
	);

	return Promise.all(
		rows.map(async (row) => {
			const status = STATUS_MAP[row.status] ?? 'unknown';
			const progress = parseFloat(row.progress || '0');
			const size = row.size ?? 0;
			const resolution = row.quality?.resolution
				? Number.parseInt(row.quality.resolution, 10) || 0
				: 0;

			const record: Record<string, unknown> = {
				id: await getOrAssignArrId('queue', row.id),
				quality: {
					quality: { id: 1, name: row.quality?.resolution ?? 'Unknown', resolution },
					revision: { version: 1, real: 0, isRepack: false }
				},
				customFormatScore: 0,
				size,
				title: row.title,
				estimatedCompletionTime:
					row.eta != null ? new Date(Date.now() + row.eta * 1000).toISOString() : null,
				added: row.addedAt,
				status,
				trackedDownloadStatus: row.status === 'failed' ? 'error' : 'ok',
				trackedDownloadState: TRACKED_STATE_MAP[row.status] ?? 'downloading',
				statusMessages: [],
				errorMessage: row.errorMessage,
				downloadId: row.downloadId,
				protocol: PROTOCOL_MAP[row.protocol] ?? 'unknown',
				downloadClient: clientMap.get(row.downloadClientId) ?? null,
				downloadClientHasPostImportCategory: false,
				indexer: row.indexerName,
				outputPath: row.outputPath,
				// Deprecated in the real API, but still part of the documented
				// schema and easier to compute correctly.
				sizeleft: size * (1 - progress)
			};

			if (appName === 'Radarr') {
				// Spec marks this nullable, but real-world clients (NZBDav) use a
				// non-nullable int model regardless - see the Sonarr branch below
				// for the seasonNumber case that actually crashed one.
				record.movieId = row.movieId ? (queueArrIds.get(row.movieId) ?? 0) : 0;
			} else {
				// The real spec marks seriesId/episodeId/seasonNumber nullable,
				// but observed real-world clients (NZBDav) use a non-nullable int
				// model regardless and throw a JSON deserialization error on
				// null - a real Sonarr queue item always has these populated in
				// practice, so default to 0 instead of sending null.
				record.seriesId = row.seriesId ? (queueArrIds.get(row.seriesId) ?? 0) : 0;
				// episodeIds are UUID text FKs, not numeric - need the same
				// surrogate-ID treatment as movieId/seriesId, not a raw cast.
				record.episodeId = row.episodeIds?.[0]
					? await getOrAssignArrId('episode', row.episodeIds[0])
					: 0;
				record.seasonNumber = row.seasonNumber ?? 0;
			}

			return record;
		})
	);
}

export async function buildQueue(appName: ArrAppName, options: QueueQueryOptions) {
	const records = await getQueueRecords(appName);

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

/**
 * `/queue/details` - the same records as `/queue`, unpaginated, optionally
 * filtered to a single movie (Radarr: `movieId`) or series/episode set
 * (Sonarr: `seriesId`/`episodeIds`), matching the real endpoint's contract.
 * arrId filters are compared against the surrogate IDs already assigned by
 * getQueueRecords() -> getOrAssignArrIds, so no extra lookup is needed.
 */
export async function buildQueueDetails(
	appName: ArrAppName,
	filter: { movieId?: number; seriesId?: number; episodeIds?: number[] }
): Promise<Record<string, unknown>[]> {
	const records = await getQueueRecords(appName);

	if (appName === 'Radarr' && filter.movieId !== undefined) {
		return records.filter((record) => record.movieId === filter.movieId);
	}
	if (appName === 'Sonarr') {
		if (filter.seriesId !== undefined) {
			return records.filter((record) => record.seriesId === filter.seriesId);
		}
		if (filter.episodeIds?.length) {
			return records.filter(
				(record) =>
					typeof record.episodeId === 'number' && filter.episodeIds!.includes(record.episodeId)
			);
		}
	}
	return records;
}
