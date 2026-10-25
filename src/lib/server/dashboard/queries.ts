import { stat, statfs } from 'node:fs/promises';
import { db } from '#lib/server/db/index.js';
import { toDateString, todayDateString } from '#lib/utils/format.js';
import {
	movies,
	series,
	episodes,
	episodeFiles,
	movieFiles,
	downloadQueue,
	downloadHistory,
	unmatchedFiles,
	rootFolders,
	indexers,
	downloadClients,
	settings
} from '#lib/server/db/schema.js';
import { count, eq, desc, and, inArray, sql, gte, ne } from 'drizzle-orm';
import {
	computeMissingMovieAvailabilityCounts,
	enrichMoviesWithAvailability
} from './movie-availability.js';
import type { DashboardStats, RecentlyAddedData } from '#lib/types/dashboard.js';

/**
 * Shared dashboard query functions used by both the page server loader
 * and the SSE stream endpoint to avoid code duplication.
 */

export async function getDashboardStats(): Promise<DashboardStats> {
	const now = new Date();
	const today = todayDateString();
	const oneDayAgoIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

	// Run ALL independent DB queries in a single parallel batch
	const [
		[movieStats],
		[seriesStats],
		[episodeStats],
		airedMissingEpisodes,
		unairedEpisodes,
		unmonitoredAiredMissingEpisodes,
		missingMoviesForAvailability,
		downloadingDownloads,
		queuedDownloads,
		stalledDownloads,
		pausedDownloads,
		downloadThroughput,
		completedDownloads24h,
		[unmatchedCount],
		[movieSizeResult],
		[episodeSizeResult],
		missingMovieRoots,
		missingSeriesRoots,
		rootFolderPathsResult,
		indexerCountResult,
		downloadClientCountResult,
		rootFolderCountResult,
		tmdbKeySetting
	] = await Promise.all([
		// Base stats (3 queries)
		db
			.select({
				total: count(),
				withFile: count(sql`CASE WHEN ${movies.hasFile} = 1 THEN 1 END`),
				monitored: count(sql`CASE WHEN ${movies.monitored} = 1 THEN 1 END`)
			})
			.from(movies),
		db
			.select({
				total: count(),
				monitored: count(sql`CASE WHEN ${series.monitored} = 1 THEN 1 END`)
			})
			.from(series),
		db
			.select({
				total: count(),
				withFile: count(sql`CASE WHEN ${episodes.hasFile} = 1 THEN 1 END`),
				monitored: count(sql`CASE WHEN ${episodes.monitored} = 1 THEN 1 END`)
			})
			.from(episodes),
		// Episode missing/unaired counts (3 queries)
		db
			.select({ count: count() })
			.from(episodes)
			.innerJoin(series, eq(episodes.seriesId, series.id))
			.where(
				and(
					eq(episodes.hasFile, false),
					eq(episodes.monitored, true),
					eq(series.monitored, true),
					ne(episodes.seasonNumber, 0),
					sql`${episodes.airDate} <= ${today}`
				)
			),
		db
			.select({ count: count() })
			.from(episodes)
			.innerJoin(series, eq(episodes.seriesId, series.id))
			.where(
				and(
					eq(episodes.hasFile, false),
					eq(episodes.monitored, true),
					eq(series.monitored, true),
					ne(episodes.seasonNumber, 0),
					sql`${episodes.airDate} > ${today}`
				)
			),
		db
			.select({ count: count() })
			.from(episodes)
			.innerJoin(series, eq(episodes.seriesId, series.id))
			.where(
				and(
					eq(episodes.hasFile, false),
					ne(episodes.seasonNumber, 0),
					sql`${episodes.airDate} <= ${today}`,
					sql`(${episodes.monitored} = 0 OR ${series.monitored} = 0)`
				)
			),
		// Missing movies for TMDB availability lookup (1 query)
		db
			.select({
				tmdbId: movies.tmdbId,
				year: movies.year,
				added: movies.added,
				monitored: movies.monitored
			})
			.from(movies)
			.where(eq(movies.hasFile, false)),
		// Download stats (4 queries)
		db
			.select({ count: count() })
			.from(downloadQueue)
			.where(eq(downloadQueue.status, 'downloading')),
		db.select({ count: count() }).from(downloadQueue).where(eq(downloadQueue.status, 'queued')),
		db.select({ count: count() }).from(downloadQueue).where(eq(downloadQueue.status, 'stalled')),
		db.select({ count: count() }).from(downloadQueue).where(eq(downloadQueue.status, 'paused')),
		db
			.select({
				totalSpeed: sql<number>`COALESCE(SUM(${downloadQueue.downloadSpeed}), 0)`,
				avgProgress: sql<number>`COALESCE(AVG(CAST(${downloadQueue.progress} AS REAL)), 0)`,
				movingCount: count(sql`CASE WHEN ${downloadQueue.downloadSpeed} > 0 THEN 1 END`)
			})
			.from(downloadQueue)
			.where(eq(downloadQueue.status, 'downloading')),
		db
			.select({ count: count() })
			.from(downloadHistory)
			.where(
				and(
					eq(downloadHistory.status, 'imported'),
					sql`COALESCE(${downloadHistory.importedAt}, ${downloadHistory.completedAt}, ${downloadHistory.createdAt}) >= ${oneDayAgoIso}`
				)
			),
		// Unmatched files + storage (3 queries)
		db.select({ count: count() }).from(unmatchedFiles),
		db.select({ total: sql<number>`COALESCE(SUM(${movieFiles.size}), 0)` }).from(movieFiles),
		db.select({ total: sql<number>`COALESCE(SUM(${episodeFiles.size}), 0)` }).from(episodeFiles),
		// Missing root folders (2 queries)
		db.select({ count: count() }).from(movies).where(sql`
			${movies.rootFolderId} IS NULL
			OR ${movies.rootFolderId} = ''
			OR ${movies.rootFolderId} = 'null'
			OR NOT EXISTS (
				SELECT 1 FROM ${rootFolders} rf WHERE rf.id = ${movies.rootFolderId}
			)
			OR EXISTS (
				SELECT 1 FROM ${rootFolders} rf
				WHERE rf.id = ${movies.rootFolderId} AND rf.media_type != 'movie'
			)
		`),
		db.select({ count: count() }).from(series).where(sql`
			${series.rootFolderId} IS NULL
			OR ${series.rootFolderId} = ''
			OR ${series.rootFolderId} = 'null'
			OR NOT EXISTS (
				SELECT 1 FROM ${rootFolders} rf WHERE rf.id = ${series.rootFolderId}
			)
			OR EXISTS (
				SELECT 1 FROM ${rootFolders} rf
				WHERE rf.id = ${series.rootFolderId} AND rf.media_type != 'tv'
			)
		`),
		db
			.select({ path: rootFolders.path, freeSpaceBytes: rootFolders.freeSpaceBytes })
			.from(rootFolders)
			.where(eq(rootFolders.readOnly, false)),
		db.select({ count: count() }).from(indexers),
		db.select({ count: count() }).from(downloadClients),
		db.select({ count: count() }).from(rootFolders),
		db.query.settings.findFirst({ where: eq(settings.key, 'tmdb_api_key') })
	]);

	// Deduplicate root folder free space by filesystem device ID so folders
	// sharing the same physical volume are only counted once.
	const freeSpaceByDevice = new Map<number, number>();
	let fallbackFreeBytes = 0;
	await Promise.all(
		rootFolderPathsResult.map(async ({ path, freeSpaceBytes }) => {
			try {
				const [fileStat, fsStat] = await Promise.all([stat(path), statfs(path)]);
				if (!freeSpaceByDevice.has(fileStat.dev)) {
					freeSpaceByDevice.set(fileStat.dev, fsStat.bfree * fsStat.bsize);
				}
			} catch {
				// Path inaccessible — fall back to stored value from DB
				fallbackFreeBytes += freeSpaceBytes ?? 0;
			}
		})
	);
	const totalFreeBytes =
		[...freeSpaceByDevice.values()].reduce((sum, v) => sum + v, 0) + fallbackFreeBytes;

	// Only sequential step: TMDB availability lookup (depends on missingMoviesForAvailability)
	const missingMovieCounts = await computeMissingMovieAvailabilityCounts(
		missingMoviesForAvailability
	);

	const movieStorageBytes = Number(movieSizeResult?.total || 0);
	const tvStorageBytes = Number(episodeSizeResult?.total || 0);

	return {
		movies: {
			total: movieStats?.total || 0,
			withFile: movieStats?.withFile || 0,
			missing: missingMovieCounts.monitoredReleasedMissing,
			inCinemas: missingMovieCounts.monitoredInCinemas,
			unreleased: missingMovieCounts.monitoredUnreleased,
			unmonitoredMissing: missingMovieCounts.unmonitoredMissing,
			monitored: movieStats?.monitored || 0
		},
		series: {
			total: seriesStats?.total || 0,
			monitored: seriesStats?.monitored || 0
		},
		episodes: {
			total: episodeStats?.total || 0,
			withFile: episodeStats?.withFile || 0,
			missing: airedMissingEpisodes?.[0]?.count || 0,
			unaired: unairedEpisodes?.[0]?.count || 0,
			unmonitoredMissing: unmonitoredAiredMissingEpisodes?.[0]?.count || 0,
			monitored: episodeStats?.monitored || 0
		},
		activeDownloads: (downloadingDownloads?.[0]?.count || 0) + (stalledDownloads?.[0]?.count || 0),
		queuedDownloads: queuedDownloads?.[0]?.count || 0,
		stalledDownloads: stalledDownloads?.[0]?.count || 0,
		pausedDownloads: pausedDownloads?.[0]?.count || 0,
		downloadSpeedBytes: Number(downloadThroughput?.[0]?.totalSpeed || 0),
		downloadAvgProgress: Math.max(
			0,
			Math.min(100, Math.round(Number(downloadThroughput?.[0]?.avgProgress || 0) * 100))
		),
		movingDownloads: downloadThroughput?.[0]?.movingCount || 0,
		completedDownloadsLast24h: completedDownloads24h?.[0]?.count || 0,
		unmatchedFiles: unmatchedCount?.count || 0,
		missingRootFolders:
			(missingMovieRoots?.[0]?.count || 0) + (missingSeriesRoots?.[0]?.count || 0),
		storage: {
			movieBytes: movieStorageBytes,
			tvBytes: tvStorageBytes,
			totalBytes: movieStorageBytes + tvStorageBytes,
			freeBytes: totalFreeBytes
		},
		config: {
			indexerCount: indexerCountResult?.[0]?.count || 0,
			downloadClientCount: downloadClientCountResult?.[0]?.count || 0,
			rootFolderCount: rootFolderCountResult?.[0]?.count || 0,
			tmdbConfigured: !!tmdbKeySetting
		}
	};
}

export async function getRecentlyAdded(): Promise<RecentlyAddedData> {
	const today = todayDateString();

	// Run movie and series branches in parallel - they are independent
	const [recentMovies, recentSeries] = await Promise.all([
		// Movie branch: fetch recent movies, then enrich with TMDB availability
		(async () => {
			const recentlyAddedMovies = await db
				.select({
					id: movies.id,
					tmdbId: movies.tmdbId,
					title: movies.title,
					year: movies.year,
					posterPath: movies.posterPath,
					hasFile: movies.hasFile,
					monitored: movies.monitored,
					added: movies.added
				})
				.from(movies)
				.orderBy(desc(movies.added))
				.limit(6);
			return enrichMoviesWithAvailability(recentlyAddedMovies);
		})(),
		// Series branch: fetch recent series, then episode/file data and missing counts
		(async () => {
			const recentlyAddedSeries = await db
				.select({
					id: series.id,
					tmdbId: series.tmdbId,
					title: series.title,
					year: series.year,
					posterPath: series.posterPath,
					episodeFileCount: series.episodeFileCount,
					episodeCount: series.episodeCount,
					added: series.added
				})
				.from(series)
				.orderBy(desc(series.added))
				.limit(6);

			const recentlyAddedSeriesIds = recentlyAddedSeries.map((s) => s.id);
			if (recentlyAddedSeriesIds.length === 0) {
				return recentlyAddedSeries.map((show) => ({
					...show,
					episodeCount: 0,
					episodeFileCount: 0,
					airedMissingCount: 0
				}));
			}

			// Fetch episode data, episode files, and missing counts in parallel
			const [recentRegularEpisodes, recentEpisodeFiles, missingCounts] = await Promise.all([
				db
					.select({
						id: episodes.id,
						seriesId: episodes.seriesId,
						airDate: episodes.airDate
					})
					.from(episodes)
					.where(
						and(inArray(episodes.seriesId, recentlyAddedSeriesIds), ne(episodes.seasonNumber, 0))
					),
				db
					.select({
						seriesId: episodeFiles.seriesId,
						episodeIds: episodeFiles.episodeIds
					})
					.from(episodeFiles)
					.where(inArray(episodeFiles.seriesId, recentlyAddedSeriesIds)),
				db
					.select({
						seriesId: episodes.seriesId,
						count: count()
					})
					.from(episodes)
					.innerJoin(series, eq(episodes.seriesId, series.id))
					.where(
						and(
							inArray(episodes.seriesId, recentlyAddedSeriesIds),
							eq(episodes.hasFile, false),
							eq(episodes.monitored, true),
							eq(series.monitored, true),
							ne(episodes.seasonNumber, 0),
							sql`${episodes.airDate} <= ${today}`
						)
					)
					.groupBy(episodes.seriesId)
			]);

			const isAired = (ep: { airDate: string | null }) =>
				Boolean(ep.airDate && ep.airDate !== '' && ep.airDate <= today);

			const recentEpisodeIdToSeries = new Map(
				recentRegularEpisodes.filter(isAired).map((ep) => [ep.id, ep.seriesId])
			);
			const recentEpisodeTotals = new Map<string, number>();
			for (const episode of recentRegularEpisodes.filter(isAired)) {
				recentEpisodeTotals.set(
					episode.seriesId,
					(recentEpisodeTotals.get(episode.seriesId) ?? 0) + 1
				);
			}
			const recentEpisodeFilesBySeries = new Map<string, Set<string>>();
			for (const file of recentEpisodeFiles) {
				const linkedEpisodeIds = (file.episodeIds as string[] | null) ?? [];
				if (linkedEpisodeIds.length === 0) continue;
				const seriesId = file.seriesId;
				let tracked = recentEpisodeFilesBySeries.get(seriesId);
				if (!tracked) {
					tracked = new Set<string>();
					recentEpisodeFilesBySeries.set(seriesId, tracked);
				}
				for (const episodeId of linkedEpisodeIds) {
					if (recentEpisodeIdToSeries.get(episodeId) === seriesId) {
						tracked.add(episodeId);
					}
				}
			}
			const missingMap = new Map(missingCounts.map((row) => [row.seriesId, row.count]));

			return recentlyAddedSeries.map((show) => ({
				...show,
				episodeCount: recentEpisodeTotals.get(show.id) ?? 0,
				episodeFileCount: recentEpisodeFilesBySeries.get(show.id)?.size ?? 0,
				airedMissingCount: missingMap.get(show.id) ?? 0
			}));
		})()
	]);

	return {
		movies: recentMovies,
		series: recentSeries
	};
}

export async function getMissingEpisodes() {
	const today = todayDateString();
	const thirtyDaysAgo = toDateString(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

	const missingEpisodes = await db
		.select({
			id: episodes.id,
			seriesId: episodes.seriesId,
			seasonNumber: episodes.seasonNumber,
			episodeNumber: episodes.episodeNumber,
			title: episodes.title,
			airDate: episodes.airDate
		})
		.from(episodes)
		.innerJoin(series, eq(episodes.seriesId, series.id))
		.where(
			and(
				eq(episodes.monitored, true),
				eq(episodes.hasFile, false),
				eq(series.monitored, true),
				gte(episodes.airDate, thirtyDaysAgo),
				sql`${episodes.airDate} <= ${today}`
			)
		)
		.orderBy(desc(episodes.airDate))
		.limit(10);

	const seriesIds = [...new Set(missingEpisodes.map((e) => e.seriesId))];
	const seriesInfo =
		seriesIds.length > 0
			? await db
					.select({
						id: series.id,
						title: series.title,
						posterPath: series.posterPath
					})
					.from(series)
					.where(inArray(series.id, seriesIds))
			: [];

	const seriesMap = new Map(seriesInfo.map((s) => [s.id, s]));

	return missingEpisodes.map((ep) => ({
		...ep,
		series: seriesMap.get(ep.seriesId) || null
	}));
}
