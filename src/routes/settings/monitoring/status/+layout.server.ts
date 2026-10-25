import type { LayoutServerLoad } from './$types';
import { db } from '#lib/server/db/index.js';
import {
	mediaServerSyncedItems,
	mediaServerSyncedRuns,
	mediaBrowserServers,
	movies,
	movieFiles,
	series,
	episodeFiles,
	storageInsights
} from '#lib/server/db/schema.js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
	extractResolution,
	extractVideoCodec,
	extractHdrFormat,
	extractAudioCodec,
	extractContainer
} from '#lib/server/storage/reconciliation/matchers.js';

export const load: LayoutServerLoad = async ({ parent }) => {
	await parent();

	const servers = await db.select().from(mediaBrowserServers);
	// A disabled server's synced data is kept (not deleted) so re-enabling and
	// re-syncing is cheap, but it must stop counting toward every aggregate
	// stat below - including the per-server serverStatuses list, which is
	// fully hidden (not just its data) once a server is disabled.
	const enabledServerIds = servers.filter((s) => s.enabled).map((s) => s.id);
	const enabledFilter = inArray(mediaServerSyncedItems.serverId, enabledServerIds);

	const playsResult =
		enabledServerIds.length === 0
			? [{ total: 0 }]
			: await db
					.select({ total: sql<number>`coalesce(sum(${mediaServerSyncedItems.playCount}), 0)` })
					.from(mediaServerSyncedItems)
					.where(enabledFilter);
	const totalPlays = playsResult[0]?.total ?? 0;

	// Quality data (resolution/codec/HDR/audio/container, and which items
	// have it at all) is Cinephage's own - extracted via ffprobe at import
	// time - and has nothing to do with whether a media server is connected,
	// enabled, or synced. Unlike play counts (only a media server can report
	// those), source these from local movie/episode files instead of
	// mediaServerSyncedItems, reusing the same extraction helpers the Media
	// Explorer page uses so labels stay consistent everywhere.
	const localMovieFiles = db
		.select({
			movieId: movieFiles.movieId,
			quality: movieFiles.quality,
			mediaInfo: movieFiles.mediaInfo
		})
		.from(movieFiles)
		.all();
	const localEpisodeFiles = db
		.select({
			seriesId: episodeFiles.seriesId,
			quality: episodeFiles.quality,
			mediaInfo: episodeFiles.mediaInfo
		})
		.from(episodeFiles)
		.all();
	const localFiles: Array<{ quality: unknown; mediaInfo: unknown }> = [
		...localMovieFiles.map((f) => ({ quality: f.quality, mediaInfo: f.mediaInfo })),
		...localEpisodeFiles.map((f) => ({ quality: f.quality, mediaInfo: f.mediaInfo }))
	];

	const uniqueItems =
		new Set(localMovieFiles.map((f) => f.movieId)).size +
		new Set(localEpisodeFiles.map((f) => f.seriesId)).size;

	function tallyLocalFiles(
		extractLabel: (
			quality: Parameters<typeof extractResolution>[0],
			mediaInfo: Parameters<typeof extractResolution>[1]
		) => string | null
	): Array<{ label: string; count: number }> {
		const counts = new Map<string, number>();
		for (const f of localFiles) {
			const label = extractLabel(
				f.quality as Parameters<typeof extractResolution>[0],
				f.mediaInfo as Parameters<typeof extractResolution>[1]
			);
			if (!label) continue;
			counts.set(label, (counts.get(label) ?? 0) + 1);
		}
		return [...counts.entries()]
			.map(([label, count]) => ({ label, count }))
			.sort((a, b) => b.count - a.count);
	}

	const resolutionBreakdown = tallyLocalFiles((q, m) => extractResolution(q, m));
	const codecBreakdown = tallyLocalFiles((q, m) => extractVideoCodec(q, m));
	// Non-HDR files report null from extractHdrFormat - bucket them as a
	// single explicit "SDR" entry rather than dropping them from the chart.
	const hdrBreakdown = tallyLocalFiles((q, m) => extractHdrFormat(q, m) ?? 'SDR');
	const audioCodecBreakdown = tallyLocalFiles((_q, m) => extractAudioCodec(m));
	const containerBreakdown = tallyLocalFiles((_q, m) => extractContainer(m));

	const syncedServersResult =
		enabledServerIds.length === 0
			? []
			: await db
					.select({ serverId: mediaServerSyncedItems.serverId })
					.from(mediaServerSyncedItems)
					.where(enabledFilter)
					.groupBy(mediaServerSyncedItems.serverId);
	const serversSynced = syncedServersResult.length;

	const sizeResult =
		enabledServerIds.length === 0
			? [{ total: 0 }]
			: await db
					.select({ total: sql<number>`coalesce(sum(${mediaServerSyncedItems.fileSize}), 0)` })
					.from(mediaServerSyncedItems)
					.where(enabledFilter);
	const totalFileSize = sizeResult[0]?.total ?? 0;

	// Disabled servers are fully hidden from Storage Maintenance (not just
	// their data) - admins see disabled servers' status on the Media Servers
	// settings page instead, where re-enabling them lives.
	const serverStatuses = await Promise.all(
		servers
			.filter((server) => server.enabled)
			.map(async (server) => {
				const itemCount = await db
					.select({ count: sql<number>`count(*)` })
					.from(mediaServerSyncedItems)
					.where(sql`${mediaServerSyncedItems.serverId} = ${server.id}`);
				const lastRun = await db
					.select()
					.from(mediaServerSyncedRuns)
					.where(sql`${mediaServerSyncedRuns.serverId} = ${server.id}`)
					.orderBy(desc(mediaServerSyncedRuns.startedAt))
					.limit(1);
				return {
					serverId: server.id,
					serverName: server.name,
					serverType: server.serverType,
					itemCount: itemCount[0]?.count ?? 0,
					lastSyncAt: lastRun[0]?.completedAt ?? null,
					lastSyncStatus: lastRun[0]?.status ?? null,
					enabled: server.enabled ?? false
				};
			})
	);

	const insights = db
		.select()
		.from(storageInsights)
		.where(sql`${storageInsights.dismissedAt} IS NULL`)
		.orderBy(
			sql`CASE ${storageInsights.severity}
				WHEN 'critical' THEN 0
				WHEN 'warning' THEN 1
				WHEN 'info' THEN 2
				ELSE 3
			END`,
			storageInsights.insightType
		)
		.all();

	const allInsights = db
		.select()
		.from(storageInsights)
		.orderBy(
			sql`CASE ${storageInsights.dismissedAt} IS NULL WHEN 0 THEN 0 ELSE 1 END`,
			sql`CASE ${storageInsights.severity}
				WHEN 'critical' THEN 0
				WHEN 'warning' THEN 1
				WHEN 'info' THEN 2
				ELSE 3
			END`,
			storageInsights.insightType
		)
		.all();

	const topItems =
		enabledServerIds.length === 0
			? []
			: db
					.select({
						title: mediaServerSyncedItems.title,
						seriesName: mediaServerSyncedItems.seriesName,
						playCount: mediaServerSyncedItems.playCount,
						height: mediaServerSyncedItems.height,
						fileSize: mediaServerSyncedItems.fileSize,
						itemType: mediaServerSyncedItems.itemType
					})
					.from(mediaServerSyncedItems)
					.where(and(sql`${mediaServerSyncedItems.playCount} > 0`, enabledFilter))
					.orderBy(desc(mediaServerSyncedItems.playCount))
					.limit(5)
					.all();

	// Unlike Most Played (which only a media server can report), file size is
	// Cinephage's own data - it has nothing to do with whether a media server
	// is connected, enabled, or synced. Source it straight from the local
	// movie/episode file records instead of mediaServerSyncedItems, so
	// Largest Files keeps working with zero media servers configured.
	const topMovieFiles = db
		.select({
			title: movies.title,
			fileSize: movieFiles.size,
			quality: movieFiles.quality,
			mediaInfo: movieFiles.mediaInfo
		})
		.from(movieFiles)
		.innerJoin(movies, eq(movieFiles.movieId, movies.id))
		.where(sql`${movieFiles.size} IS NOT NULL`)
		.orderBy(desc(movieFiles.size))
		.limit(5)
		.all();
	const topEpisodeFiles = db
		.select({
			seriesName: series.title,
			fileSize: episodeFiles.size,
			quality: episodeFiles.quality,
			mediaInfo: episodeFiles.mediaInfo
		})
		.from(episodeFiles)
		.innerJoin(series, eq(episodeFiles.seriesId, series.id))
		.where(sql`${episodeFiles.size} IS NOT NULL`)
		.orderBy(desc(episodeFiles.size))
		.limit(5)
		.all();
	const toRawHeight = (mediaInfo: Parameters<typeof extractResolution>[1]): number | null => {
		const height = (mediaInfo as { height?: number } | null | undefined)?.height;
		return typeof height === 'number' ? height : null;
	};
	const largestItems = [
		...topMovieFiles.map((f) => ({
			title: f.title,
			seriesName: null as string | null,
			fileSize: f.fileSize,
			height: toRawHeight(f.mediaInfo as Parameters<typeof extractResolution>[1]),
			videoCodec: extractVideoCodec(
				f.quality as Parameters<typeof extractVideoCodec>[0],
				f.mediaInfo as Parameters<typeof extractVideoCodec>[1]
			),
			itemType: 'movie'
		})),
		...topEpisodeFiles.map((f) => ({
			title: f.seriesName,
			seriesName: f.seriesName as string | null,
			fileSize: f.fileSize,
			height: toRawHeight(f.mediaInfo as Parameters<typeof extractResolution>[1]),
			videoCodec: extractVideoCodec(
				f.quality as Parameters<typeof extractVideoCodec>[0],
				f.mediaInfo as Parameters<typeof extractVideoCodec>[1]
			),
			itemType: 'episode'
		}))
	]
		.sort((a, b) => (b.fileSize ?? 0) - (a.fileSize ?? 0))
		.slice(0, 5);

	return {
		mediaServerStats: {
			totalPlays,
			uniqueItems,
			serversSynced,
			totalFileSize,
			resolutionBreakdown,
			codecBreakdown,
			hdrBreakdown,
			audioCodecBreakdown,
			containerBreakdown
		},
		serverStatuses,
		servers,
		insights,
		allInsights,
		topItems,
		largestItems
	};
};
