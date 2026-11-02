import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import {
	mediaServerSyncedItems,
	mediaServerSyncedRuns,
	mediaBrowserServers
} from '#lib/server/db/schema.js';
import { sql, desc, eq, and, or, isNull, inArray } from 'drizzle-orm';
import type {
	StatsSummary,
	AggregatedMediaItem,
	ServerSyncStatus
} from '#lib/server/mediaServerStats/types.js';

/**
 * Matches the (tmdbId, tvdbId, title) identifying key aggregateItems() groups by.
 * Used to re-fetch full row detail for a small, already-ranked set of items
 * instead of loading the whole table.
 */
function matchesIdentifyingKey(key: {
	tmdbId: number | null;
	tvdbId: number | null;
	title: string;
}) {
	return and(
		key.tmdbId != null
			? eq(mediaServerSyncedItems.tmdbId, key.tmdbId)
			: isNull(mediaServerSyncedItems.tmdbId),
		key.tvdbId != null
			? eq(mediaServerSyncedItems.tvdbId, key.tvdbId)
			: isNull(mediaServerSyncedItems.tvdbId),
		eq(mediaServerSyncedItems.title, key.title)
	);
}

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

export const GET: RequestHandler = async () => {
	const resolutionBucket = sql`CASE
		WHEN ${mediaServerSyncedItems.height} >= 2160 THEN '4K'
		WHEN ${mediaServerSyncedItems.height} >= 1080 THEN '1080p'
		WHEN ${mediaServerSyncedItems.height} >= 720 THEN '720p'
		WHEN ${mediaServerSyncedItems.height} >= 480 THEN '480p'
		WHEN ${mediaServerSyncedItems.height} IS NULL THEN 'Unknown'
		ELSE 'SD'
	END`;

	// A disabled server's synced data is kept (not deleted) so re-enabling and
	// re-syncing is cheap, but it must stop counting toward every aggregate
	// stat below. inArray() with an empty array safely resolves to a `false`
	// predicate (no special-casing needed if zero servers are enabled).
	const servers = await db.select().from(mediaBrowserServers);
	const enabledServerIds = servers.filter((s) => s.enabled).map((s) => s.id);
	const enabledFilter = inArray(mediaServerSyncedItems.serverId, enabledServerIds);

	const [
		totalPlaysRow,
		uniqueItemsRow,
		serversSyncedRow,
		totalFileSizeRow,
		resolutionRows,
		codecRows,
		hdrRows,
		audioCodecRows,
		containerRows,
		itemCountsByServerRows,
		topPlayedKeys,
		largestRawRows
	] = await Promise.all([
		db
			.select({ total: sql<number>`coalesce(sum(${mediaServerSyncedItems.playCount}), 0)` })
			.from(mediaServerSyncedItems)
			.where(enabledFilter),
		db
			.select({
				count: sql<number>`count(distinct coalesce(${mediaServerSyncedItems.tmdbId}, ${mediaServerSyncedItems.serverItemId}))`
			})
			.from(mediaServerSyncedItems)
			.where(enabledFilter),
		db
			.select({
				count: sql<number>`count(distinct ${mediaServerSyncedItems.serverId})`
			})
			.from(mediaServerSyncedItems)
			.where(enabledFilter),
		db
			.select({ total: sql<number>`coalesce(sum(${mediaServerSyncedItems.fileSize}), 0)` })
			.from(mediaServerSyncedItems)
			.where(enabledFilter),
		db
			.select({ label: resolutionBucket.as('label'), count: sql<number>`count(*)` })
			.from(mediaServerSyncedItems)
			.where(enabledFilter)
			.groupBy(resolutionBucket),
		db
			.select({
				videoCodec: mediaServerSyncedItems.videoCodec,
				count: sql<number>`count(*)`
			})
			.from(mediaServerSyncedItems)
			.where(and(sql`${mediaServerSyncedItems.videoCodec} IS NOT NULL`, enabledFilter))
			.groupBy(mediaServerSyncedItems.videoCodec)
			.orderBy(sql`count(*) desc`),
		db
			.select({
				isHDR: mediaServerSyncedItems.isHDR,
				hdrFormat: mediaServerSyncedItems.hdrFormat,
				count: sql<number>`count(*)`
			})
			.from(mediaServerSyncedItems)
			.where(enabledFilter)
			.groupBy(mediaServerSyncedItems.isHDR, mediaServerSyncedItems.hdrFormat)
			.orderBy(sql`count(*) desc`),
		db
			.select({
				audioCodec: mediaServerSyncedItems.audioCodec,
				count: sql<number>`count(*)`
			})
			.from(mediaServerSyncedItems)
			.where(and(sql`${mediaServerSyncedItems.audioCodec} IS NOT NULL`, enabledFilter))
			.groupBy(mediaServerSyncedItems.audioCodec)
			.orderBy(sql`count(*) desc`),
		db
			.select({
				containerFormat: mediaServerSyncedItems.containerFormat,
				count: sql<number>`count(*)`
			})
			.from(mediaServerSyncedItems)
			.where(and(sql`${mediaServerSyncedItems.containerFormat} IS NOT NULL`, enabledFilter))
			.groupBy(mediaServerSyncedItems.containerFormat)
			.orderBy(sql`count(*) desc`),
		db
			.select({ serverId: mediaServerSyncedItems.serverId, count: sql<number>`count(*)` })
			.from(mediaServerSyncedItems)
			.where(and(sql`${mediaServerSyncedItems.serverId} IS NOT NULL`, enabledFilter))
			.groupBy(mediaServerSyncedItems.serverId),
		db
			.select({
				tmdbId: mediaServerSyncedItems.tmdbId,
				tvdbId: mediaServerSyncedItems.tvdbId,
				title: mediaServerSyncedItems.title
			})
			.from(mediaServerSyncedItems)
			.where(enabledFilter)
			.groupBy(
				mediaServerSyncedItems.tmdbId,
				mediaServerSyncedItems.tvdbId,
				mediaServerSyncedItems.title
			)
			.orderBy(sql`sum(${mediaServerSyncedItems.playCount}) desc`)
			.limit(25),
		db
			.select()
			.from(mediaServerSyncedItems)
			.where(and(sql`${mediaServerSyncedItems.fileSize} IS NOT NULL`, enabledFilter))
			.orderBy(desc(mediaServerSyncedItems.fileSize))
			.limit(10)
	]);

	// Server metadata for breakdown entries (real type/name, never hardcoded).
	const serverById = new Map(
		servers.map((server) => [server.id, { name: server.name, serverType: server.serverType }])
	);

	// Latest sync run per server - one small limited query per (bounded, small) server
	// list instead of loading the whole run-history table.
	const syncRuns = (
		await Promise.all(
			servers.map((server) =>
				db
					.select()
					.from(mediaServerSyncedRuns)
					.where(eq(mediaServerSyncedRuns.serverId, server.id))
					.orderBy(desc(mediaServerSyncedRuns.startedAt))
					.limit(1)
			)
		)
	).flat();

	// Fetch full row detail only for the items that actually made the top-25/top-10
	// lists above, so serverBreakdown can still be built without loading every row.
	const topPlayedRows =
		topPlayedKeys.length > 0
			? await db
					.select()
					.from(mediaServerSyncedItems)
					.where(and(or(...topPlayedKeys.map(matchesIdentifyingKey)), enabledFilter))
			: [];

	const largestKeys = largestRawRows.map((item) => ({
		tmdbId: item.tmdbId,
		tvdbId: item.tvdbId,
		title: item.title
	}));
	const largestDetailRows =
		largestKeys.length > 0
			? await db
					.select()
					.from(mediaServerSyncedItems)
					.where(and(or(...largestKeys.map(matchesIdentifyingKey)), enabledFilter))
			: [];

	const resolutionBreakdown = resolutionRows
		.map((r) => ({ label: r.label as string, count: r.count }))
		.sort((a, b) => b.count - a.count);

	const codecBreakdown = codecRows.map((r) => ({
		label: r.videoCodec ?? 'Unknown',
		count: r.count
	}));

	const hdrBreakdown = hdrRows.map((r) => {
		const isHdr = (r.isHDR ?? 0) === 1;
		return {
			label: isHdr ? (r.hdrFormat ?? 'HDR') : 'SDR',
			count: r.count
		};
	});

	const audioCodecBreakdown = audioCodecRows.map((r) => ({
		label: r.audioCodec ?? 'Unknown',
		count: r.count
	}));

	const containerBreakdown = containerRows.map((r) => ({
		label: r.containerFormat ?? 'Unknown',
		count: r.count
	}));

	const topPlayedItems = aggregateItems(topPlayedRows, serverById)
		.sort((a, b) => b.totalPlayCount - a.totalPlayCount)
		.slice(0, 25);

	const largestAggregated = aggregateItems(largestDetailRows, serverById);
	const largestItems = largestRawRows.map((item) => {
		const agg = largestAggregated.find(
			(a) => a.tmdbId === item.tmdbId && a.tvdbId === item.tvdbId && a.title === item.title
		);
		return (
			agg ?? {
				tmdbId: item.tmdbId ?? null,
				tvdbId: item.tvdbId ?? null,
				imdbId: item.imdbId ?? null,
				title: item.title,
				year: item.year ?? null,
				itemType: item.itemType,
				totalPlayCount: item.playCount ?? 0,
				lastPlayedDate: item.lastPlayedDate ?? null,
				serverBreakdown: []
			}
		);
	});

	const latestRunsMap = new Map<string, (typeof syncRuns)[0]>();
	for (const run of syncRuns) {
		latestRunsMap.set(run.serverId, run);
	}

	const itemCountsMap = new Map<string, number>(
		itemCountsByServerRows.map((r) => [r.serverId as string, r.count])
	);

	const serverStatuses: ServerSyncStatus[] = servers.map((server) => {
		const latestRun = latestRunsMap.get(server.id);
		return {
			serverId: server.id,
			serverName: server.name,
			serverType: server.serverType,
			itemCount: itemCountsMap.get(server.id) ?? 0,
			lastSyncAt: latestRun?.completedAt ?? latestRun?.startedAt ?? null,
			lastSyncStatus: latestRun?.status ?? null,
			enabled: server.enabled ?? true
		};
	});

	const summary: StatsSummary & { serverStatuses: ServerSyncStatus[] } = {
		totalPlays: totalPlaysRow[0]?.total ?? 0,
		uniqueItems: uniqueItemsRow[0]?.count ?? 0,
		serversSynced: serversSyncedRow[0]?.count ?? 0,
		totalFileSize: totalFileSizeRow[0]?.total ?? 0,
		resolutionBreakdown,
		codecBreakdown,
		hdrBreakdown,
		audioCodecBreakdown,
		containerBreakdown,
		topPlayedItems,
		largestItems,
		serverStatuses
	};

	return Response.json(summary);
};
