import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { mediaBrowserServers, mediaServerSyncedItems } from '#lib/server/db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import type { AggregatedMediaItem } from '#lib/server/mediaServerStats/types.js';

const VALID_SORT_FIELDS = ['playCount', 'fileSize', 'title', 'lastPlayedDate'] as const;
type SortField = (typeof VALID_SORT_FIELDS)[number];

const VALID_ITEM_TYPES = ['movie', 'episode', 'series', 'season'] as const;

export const GET: RequestHandler = async ({ url }) => {
	const typeParam = url.searchParams.get('type');
	const sortParam = url.searchParams.get('sort') ?? 'playCount';
	const orderParam = url.searchParams.get('order') ?? 'desc';
	const pageParam = url.searchParams.get('page') ?? '1';
	const limitParam = url.searchParams.get('limit') ?? '25';

	const sort: SortField = VALID_SORT_FIELDS.includes(sortParam as SortField)
		? (sortParam as SortField)
		: 'playCount';
	const order = orderParam === 'asc' ? 'asc' : 'desc';
	const page = Math.max(1, parseInt(pageParam, 10) || 1);
	const limit = Math.min(100, Math.max(1, parseInt(limitParam, 10) || 25));

	// A disabled server's synced data is kept (not deleted) so re-enabling and
	// re-syncing is cheap, but it must stop counting toward this aggregate.
	const servers = await db.select().from(mediaBrowserServers);
	const enabledServerIds = servers.filter((s) => s.enabled).map((s) => s.id);

	const conditions = [inArray(mediaServerSyncedItems.serverId, enabledServerIds)];
	if (typeParam && VALID_ITEM_TYPES.includes(typeParam as (typeof VALID_ITEM_TYPES)[number])) {
		conditions.push(
			eq(mediaServerSyncedItems.itemType, typeParam as (typeof VALID_ITEM_TYPES)[number])
		);
	}

	const MAX_RAW_ITEMS = 5000;
	const allItems = await db
		.select()
		.from(mediaServerSyncedItems)
		.where(and(...conditions))
		.limit(MAX_RAW_ITEMS);

	const serverById = new Map(
		servers.map((server) => [server.id, { name: server.name, serverType: server.serverType }])
	);
	const aggregated = aggregateItems(allItems, serverById);

	aggregated.sort((a, b) => {
		let cmp = 0;
		switch (sort) {
			case 'playCount':
				cmp = a.totalPlayCount - b.totalPlayCount;
				break;
			case 'fileSize':
				cmp = a.serverBreakdown.length - b.serverBreakdown.length;
				break;
			case 'title':
				cmp = a.title.localeCompare(b.title);
				break;
			case 'lastPlayedDate': {
				const aDate = a.lastPlayedDate ?? '';
				const bDate = b.lastPlayedDate ?? '';
				cmp = aDate.localeCompare(bDate);
				break;
			}
		}
		return order === 'desc' ? -cmp : cmp;
	});

	const total = aggregated.length;
	const offset = (page - 1) * limit;
	const pagedItems = aggregated.slice(offset, offset + limit);

	return Response.json({
		items: pagedItems,
		total,
		page,
		limit
	});
};

function aggregateItems(
	rows: (typeof mediaServerSyncedItems.$inferSelect)[],
	serverById: Map<string, { name: string; serverType: string }>
): AggregatedMediaItem[] {
	const map = new Map<string, AggregatedMediaItem>();

	for (const row of rows) {
		const key = `${row.tmdbId ?? 'null'}-${row.tvdbId ?? 'null'}-${row.title}`;
		const existing = map.get(key);
		const server = row.serverId ? serverById.get(row.serverId) : undefined;
		if (existing) {
			existing.totalPlayCount += row.playCount ?? 0;
			if (
				row.lastPlayedDate &&
				(!existing.lastPlayedDate || row.lastPlayedDate > existing.lastPlayedDate)
			) {
				existing.lastPlayedDate = row.lastPlayedDate;
			}
			if (row.serverId && server) {
				existing.serverBreakdown.push({
					serverId: row.serverId,
					serverName: server.name,
					serverType:
						server.serverType as AggregatedMediaItem['serverBreakdown'][number]['serverType'],
					playCount: row.playCount ?? 0,
					lastPlayedDate: row.lastPlayedDate ?? null,
					videoCodec: row.videoCodec ?? null,
					width: row.width ?? null,
					height: row.height ?? null,
					isHDR: (row.isHDR ?? 0) === 1,
					containerFormat: row.containerFormat ?? null
				});
			}
		} else {
			map.set(key, {
				tmdbId: row.tmdbId ?? null,
				tvdbId: row.tvdbId ?? null,
				imdbId: row.imdbId ?? null,
				title: row.title,
				year: row.year ?? null,
				itemType: row.itemType,
				totalPlayCount: row.playCount ?? 0,
				lastPlayedDate: row.lastPlayedDate ?? null,
				serverBreakdown:
					row.serverId && server
						? [
								{
									serverId: row.serverId,
									serverName: server.name,
									serverType:
										server.serverType as AggregatedMediaItem['serverBreakdown'][number]['serverType'],
									playCount: row.playCount ?? 0,
									lastPlayedDate: row.lastPlayedDate ?? null,
									videoCodec: row.videoCodec ?? null,
									width: row.width ?? null,
									height: row.height ?? null,
									isHDR: (row.isHDR ?? 0) === 1,
									containerFormat: row.containerFormat ?? null
								}
							]
						: []
			});
		}
	}

	return Array.from(map.values());
}
