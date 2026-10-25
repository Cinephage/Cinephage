/**
 * Radarr/Sonarr-compatible `blocklist` response.
 *
 * Field set confirmed against BlocklistResourcePagingResource /
 * BlocklistResource in Radarr/Sonarr's actual openapi.json, backed by
 * Cinephage's own `blocklist` table.
 */

import { desc, inArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { blocklist, indexers } from '#lib/server/db/schema.js';
import { getOrAssignArrId, getOrAssignArrIds } from './ArrIdMappingService.js';
import type { ArrAppName } from './systemStatus.js';

const PROTOCOL_MAP: Record<string, string> = {
	torrent: 'torrent',
	usenet: 'usenet',
	debrid: 'torrent',
	streaming: 'unknown'
};

interface BlocklistQueryOptions {
	page: number;
	pageSize: number;
	sortKey: string | null;
	sortDirection: string;
}

export async function buildBlocklist(appName: ArrAppName, options: BlocklistQueryOptions) {
	const rows = await db.select().from(blocklist).orderBy(desc(blocklist.createdAt));

	const scoped = rows.filter((row) => (appName === 'Radarr' ? !!row.movieId : !!row.seriesId));

	const indexerIds = [...new Set(scoped.map((r) => r.indexerId).filter((id) => !!id))] as string[];
	const indexerRows = indexerIds.length
		? await db
				.select({ id: indexers.id, name: indexers.name })
				.from(indexers)
				.where(inArray(indexers.id, indexerIds))
		: [];
	const indexerMap = new Map(indexerRows.map((i) => [i.id, i.name]));

	const mediaIds = scoped
		.map((row) => (appName === 'Radarr' ? row.movieId : row.seriesId))
		.filter((id) => !!id) as string[];
	const mediaArrIds = await getOrAssignArrIds(appName === 'Radarr' ? 'movie' : 'series', mediaIds);

	const records = await Promise.all(
		scoped.map(async (row) => {
			const resolution = row.quality?.resolution
				? Number.parseInt(row.quality.resolution, 10) || 0
				: 0;
			const record: Record<string, unknown> = {
				id: await getOrAssignArrId('blocklist', row.id),
				sourceTitle: row.sourceTitle ?? row.title,
				quality: {
					quality: { id: 1, name: row.quality?.resolution ?? 'Unknown', resolution },
					revision: { version: 1, real: 0, isRepack: false }
				},
				date: row.createdAt,
				protocol: PROTOCOL_MAP[row.protocol ?? ''] ?? 'unknown',
				indexer: row.indexerId ? (indexerMap.get(row.indexerId) ?? null) : null,
				message: row.message
			};
			// BlocklistResource.movieId/seriesId aren't marked nullable,
			// default to 0 rather than null (see queue.ts for the confirmed crash behavior).
			if (appName === 'Radarr') {
				record.movieId = row.movieId ? (mediaArrIds.get(row.movieId) ?? 0) : 0;
			} else {
				record.seriesId = row.seriesId ? (mediaArrIds.get(row.seriesId) ?? 0) : 0;
			}
			return record;
		})
	);

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
