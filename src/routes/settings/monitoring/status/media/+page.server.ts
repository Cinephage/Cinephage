import type { PageServerLoad } from './$types';
import { sql, eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	episodeFiles,
	libraries,
	mediaServerSyncedItems,
	movieFiles,
	movies,
	rootFolders,
	series,
	storageInsights
} from '#lib/server/db/schema.js';
import {
	extractResolution,
	extractVideoCodec,
	extractHdrFormat,
	extractAudioCodec,
	extractContainer
} from '#lib/server/storage/reconciliation/matchers.js';
import { aggregateMovieRows } from './aggregate-movies.js';
import { getInsightItemResolver } from '#lib/server/storage/insights/items/registry.js';
import type { InsightType } from '#lib/server/storage/insights/types.js';

export type MediaExplorerItem = {
	id: string;
	tmdbId: number;
	title: string;
	year: number | null;
	mediaType: 'movie' | 'tv';
	mediaSubType: 'standard' | 'anime';
	libraryId: string | null;
	libraryName: string;
	rootFolderId: string | null;
	rootFolderName: string | null;
	monitored: boolean;
	hasFile: boolean;
	fileSize: number;
	resolution: string | null;
	videoCodec: string | null;
	hdrFormat: string | null;
	audioCodec: string | null;
	containerFormat: string | null;
	addedAt: string | null;
	playCount: number;
	lastPlayedDate: string | null;
	isPlayed: boolean;
	playedPercentage: number | null;
	episodeCount: number | null;
	episodeFileCount: number | null;
	posterPath: string | null;
};

export const load: PageServerLoad = async ({ url, parent }) => {
	await parent();

	const sort = url.searchParams.get('sort') || 'title-asc';
	const typeFilter = url.searchParams.get('type') || 'all';
	const classification = url.searchParams.get('classification') || 'all';
	const libraryFilter = url.searchParams.get('library') || 'all';
	const rootFolderFilter = url.searchParams.get('rootFolder') || 'all';
	const monitoredFilter = url.searchParams.get('monitored') || 'all';
	const fileStatusFilter = url.searchParams.get('fileStatus') || 'all';
	const resolutionFilter = url.searchParams.get('resolution') || 'all';
	const videoCodecFilter = url.searchParams.get('videoCodec') || 'all';
	const hdrFormatFilter = url.searchParams.get('hdrFormat') || 'all';
	const audioCodecFilter = url.searchParams.get('audioCodec') || 'all';
	const containerFilter = url.searchParams.get('container') || 'all';
	const hasPlaysFilter = url.searchParams.get('hasPlays') || 'all';
	const insightId = url.searchParams.get('insightId');

	const [libraryRows, rootFolderRows, movieRows, seriesRows, efRows, playStatsRows] =
		await Promise.all([
			db.select().from(libraries),
			db.select().from(rootFolders),
			db
				.select({
					id: movies.id,
					tmdbId: movies.tmdbId,
					title: movies.title,
					year: movies.year,
					libraryId: movies.libraryId,
					rootFolderId: movies.rootFolderId,
					monitored: movies.monitored,
					hasFile: movies.hasFile,
					added: movies.added,
					posterPath: movies.posterPath,
					fileId: movieFiles.id,
					fileSize: movieFiles.size,
					quality: movieFiles.quality,
					mediaInfo: movieFiles.mediaInfo,
					relativePath: movieFiles.relativePath
				})
				.from(movies)
				.leftJoin(movieFiles, sql`${movieFiles.movieId} = ${movies.id}`),
			db
				.select({
					id: series.id,
					tmdbId: series.tmdbId,
					title: series.title,
					year: series.year,
					libraryId: series.libraryId,
					rootFolderId: series.rootFolderId,
					monitored: series.monitored,
					seriesType: series.seriesType,
					episodeCount: series.episodeCount,
					episodeFileCount: series.episodeFileCount,
					added: series.added,
					posterPath: series.posterPath
				})
				.from(series),
			db
				.select({
					seriesId: episodeFiles.seriesId,
					size: episodeFiles.size,
					quality: episodeFiles.quality,
					mediaInfo: episodeFiles.mediaInfo
				})
				.from(episodeFiles),
			db
				.select({
					tmdbId: mediaServerSyncedItems.tmdbId,
					playCount: sql<number>`COALESCE(SUM(${mediaServerSyncedItems.playCount}), 0)`,
					lastPlayedDate: sql<string | null>`MAX(${mediaServerSyncedItems.lastPlayedDate})`,
					isPlayed: sql<number>`MAX(${mediaServerSyncedItems.isPlayed})`,
					playedPercentage: sql<number | null>`MAX(${mediaServerSyncedItems.playedPercentage})`
				})
				.from(mediaServerSyncedItems)
				.where(sql`${mediaServerSyncedItems.tmdbId} IS NOT NULL`)
				.groupBy(mediaServerSyncedItems.tmdbId)
		]);

	const libraryMap = new Map(libraryRows.map((l) => [l.id, l]));
	const rootFolderMap = new Map(rootFolderRows.map((r) => [r.id, r]));

	const seriesFileMap = new Map<
		string,
		{
			totalSize: number;
			quality: typeof episodeFiles.$inferSelect.quality;
			mediaInfo: typeof episodeFiles.$inferSelect.mediaInfo;
		}
	>();
	for (const ef of efRows) {
		if (!seriesFileMap.has(ef.seriesId)) {
			seriesFileMap.set(ef.seriesId, {
				totalSize: 0,
				quality: ef.quality,
				mediaInfo: ef.mediaInfo
			});
		}
		seriesFileMap.get(ef.seriesId)!.totalSize += ef.size ?? 0;
	}

	const playStatsMap = new Map(playStatsRows.map((p) => [p.tmdbId, p]));

	const allItems: MediaExplorerItem[] = [];

	for (const movie of aggregateMovieRows(movieRows)) {
		const lib = movie.libraryId ? libraryMap.get(movie.libraryId) : null;
		const rf = movie.rootFolderId ? rootFolderMap.get(movie.rootFolderId) : null;
		const plays = movie.tmdbId ? playStatsMap.get(movie.tmdbId) : undefined;

		allItems.push({
			id: movie.id,
			tmdbId: movie.tmdbId,
			title: movie.title,
			year: movie.year ?? null,
			mediaType: 'movie',
			mediaSubType: lib?.mediaSubType === 'anime' ? 'anime' : 'standard',
			libraryId: movie.libraryId ?? null,
			libraryName: lib?.name ?? '',
			rootFolderId: movie.rootFolderId ?? null,
			rootFolderName: rf?.name ?? null,
			monitored: movie.monitored ?? true,
			hasFile: movie.hasFile ?? false,
			fileSize: movie.totalFileSize,
			resolution: extractResolution(movie.bestQuality, movie.bestMediaInfo),
			videoCodec: extractVideoCodec(movie.bestQuality, movie.bestMediaInfo),
			hdrFormat: extractHdrFormat(movie.bestQuality, movie.bestMediaInfo),
			audioCodec: extractAudioCodec(movie.bestMediaInfo),
			containerFormat: extractContainer(movie.bestMediaInfo),
			addedAt: movie.added ?? null,
			playCount: Number(plays?.playCount ?? 0),
			lastPlayedDate: plays?.lastPlayedDate ?? null,
			isPlayed: Boolean(plays?.isPlayed),
			playedPercentage: plays?.playedPercentage ?? null,
			episodeCount: null,
			episodeFileCount: null,
			posterPath: movie.posterPath ?? null
		});
	}

	for (const row of seriesRows) {
		const lib = row.libraryId ? libraryMap.get(row.libraryId) : null;
		const rf = row.rootFolderId ? rootFolderMap.get(row.rootFolderId) : null;
		const plays = row.tmdbId ? playStatsMap.get(row.tmdbId) : undefined;
		const fileStats = seriesFileMap.get(row.id);

		let isAnime = row.seriesType === 'anime';
		if (!isAnime && lib?.mediaSubType === 'anime') {
			isAnime = true;
		}

		const efc = row.episodeFileCount ?? 0;

		allItems.push({
			id: row.id,
			tmdbId: row.tmdbId,
			title: row.title,
			year: row.year ?? null,
			mediaType: 'tv',
			mediaSubType: isAnime ? 'anime' : 'standard',
			libraryId: row.libraryId ?? null,
			libraryName: lib?.name ?? '',
			rootFolderId: row.rootFolderId ?? null,
			rootFolderName: rf?.name ?? null,
			monitored: row.monitored ?? true,
			hasFile: efc > 0,
			fileSize: fileStats?.totalSize ?? 0,
			resolution: extractResolution(fileStats?.quality, fileStats?.mediaInfo),
			videoCodec: extractVideoCodec(fileStats?.quality, fileStats?.mediaInfo),
			hdrFormat: extractHdrFormat(fileStats?.quality, fileStats?.mediaInfo),
			audioCodec: extractAudioCodec(fileStats?.mediaInfo),
			containerFormat: extractContainer(fileStats?.mediaInfo),
			addedAt: row.added ?? null,
			playCount: Number(plays?.playCount ?? 0),
			lastPlayedDate: plays?.lastPlayedDate ?? null,
			isPlayed: Boolean(plays?.isPlayed),
			playedPercentage: plays?.playedPercentage ?? null,
			episodeCount: row.episodeCount ?? null,
			episodeFileCount: row.episodeFileCount ?? null,
			posterPath: row.posterPath ?? null
		});
	}

	const uniqueValues = (getter: (item: MediaExplorerItem) => string | null): string[] => {
		const set = new Set<string>();
		for (const item of allItems) {
			const val = getter(item);
			if (val) set.add(val);
		}
		return [...set].sort();
	};

	const filterOptions = {
		resolutions: uniqueValues((i) => i.resolution),
		videoCodecs: uniqueValues((i) => i.videoCodec),
		hdrFormats: uniqueValues((i) => i.hdrFormat),
		audioCodecs: uniqueValues((i) => i.audioCodec),
		containers: uniqueValues((i) => i.containerFormat),
		libraryIds: [...new Set(allItems.map((i) => i.libraryId).filter(Boolean))] as string[],
		rootFolderIds: [...new Set(allItems.map((i) => i.rootFolderId).filter(Boolean))] as string[]
	};

	let filtered = allItems;

	if (typeFilter !== 'all') {
		const mt = typeFilter === 'movie' ? 'movie' : 'tv';
		filtered = filtered.filter((i) => i.mediaType === mt);
	}

	if (classification !== 'all') {
		const sub = classification === 'anime' ? 'anime' : 'standard';
		filtered = filtered.filter((i) => i.mediaSubType === sub);
	}

	if (libraryFilter !== 'all') {
		filtered = filtered.filter((i) => i.libraryId === libraryFilter);
	}

	if (rootFolderFilter !== 'all') {
		filtered = filtered.filter((i) => i.rootFolderId === rootFolderFilter);
	}

	if (monitoredFilter === 'monitored') {
		filtered = filtered.filter((i) => i.monitored);
	} else if (monitoredFilter === 'unmonitored') {
		filtered = filtered.filter((i) => !i.monitored);
	}

	if (fileStatusFilter === 'hasFile') {
		filtered = filtered.filter((i) => i.hasFile);
	} else if (fileStatusFilter === 'missingFile') {
		filtered = filtered.filter((i) => !i.hasFile);
	}

	if (resolutionFilter !== 'all') {
		filtered = filtered.filter((i) => i.resolution === resolutionFilter);
	}

	if (videoCodecFilter !== 'all') {
		filtered = filtered.filter((i) => i.videoCodec === videoCodecFilter);
	}

	if (hdrFormatFilter !== 'all') {
		filtered = filtered.filter((i) => i.hdrFormat === hdrFormatFilter);
	}

	if (audioCodecFilter !== 'all') {
		filtered = filtered.filter((i) => i.audioCodec === audioCodecFilter);
	}

	if (containerFilter !== 'all') {
		filtered = filtered.filter((i) => i.containerFormat === containerFilter);
	}

	if (hasPlaysFilter === 'played') {
		filtered = filtered.filter((i) => i.playCount > 0);
	} else if (hasPlaysFilter === 'neverPlayed') {
		filtered = filtered.filter((i) => i.playCount === 0);
	}

	// Scope to a single storage insight's items ("View all in X" from the
	// insight modal). Reuses the same per-type resolver the modal itself
	// calls, so the filtered list is exactly what the insight reported.
	let insightContext: { id: string; title: string; rawItemCount: number } | null = null;
	if (insightId) {
		const insight = db
			.select()
			.from(storageInsights)
			.where(eq(storageInsights.id, insightId))
			.get();
		if (insight) {
			const resolver = getInsightItemResolver(insight.insightType as InsightType);
			const { items } = await resolver({ db, insight, page: 1, limit: 500 });
			const insightIds = new Set(
				items
					.map((item) => item.href?.match(/^\/library\/(?:movie|tv)\/(.+)$/)?.[1])
					.filter((id): id is string => Boolean(id))
			);
			filtered = filtered.filter((i) => insightIds.has(i.id));
			// Several insight types (e.g. unplayed) group multiple flagged rows
			// (episodes) under one parent show, so the raw itemCount the insight
			// reported can be much larger than the number of distinct
			// shows/movies left after filtering - surfaced on the page so that
			// isn't read as a data bug.
			insightContext = { id: insight.id, title: insight.title, rawItemCount: insight.itemCount };
		}
	}

	const [sortField, sortDir] = sort.split('-') as [string, string];
	const mult = sortDir === 'desc' ? -1 : 1;

	filtered.sort((a, b) => {
		let cmp: number;
		switch (sortField) {
			case 'title':
				cmp = a.title.localeCompare(b.title);
				break;
			case 'size':
				cmp = (a.fileSize || 0) - (b.fileSize || 0);
				break;
			case 'plays':
				cmp = a.playCount - b.playCount;
				break;
			case 'lastPlayed':
				cmp = (a.lastPlayedDate ?? '').localeCompare(b.lastPlayedDate ?? '');
				break;
			case 'added':
				cmp = (a.addedAt ?? '').localeCompare(b.addedAt ?? '');
				break;
			case 'year':
				cmp = (a.year ?? 0) - (b.year ?? 0);
				break;
			default:
				cmp = a.title.localeCompare(b.title);
		}
		return cmp * mult;
	});

	const totalFileSize = filtered.reduce((sum, i) => sum + i.fileSize, 0);
	const movieCount = filtered.filter((i) => i.mediaType === 'movie').length;
	const seriesCount = filtered.filter((i) => i.mediaType === 'tv').length;

	return {
		items: filtered,
		totalCount: filtered.length,
		movieCount,
		seriesCount,
		totalFileSize,
		allItemCount: allItems.length,
		allMovieCount: allItems.filter((i) => i.mediaType === 'movie').length,
		allSeriesCount: allItems.filter((i) => i.mediaType === 'tv').length,
		insightContext,
		filterOptions,
		filters: {
			sort,
			type: typeFilter,
			classification,
			library: libraryFilter,
			rootFolder: rootFolderFilter,
			monitored: monitoredFilter,
			fileStatus: fileStatusFilter,
			resolution: resolutionFilter,
			videoCodec: videoCodecFilter,
			hdrFormat: hdrFormatFilter,
			audioCodec: audioCodecFilter,
			container: containerFilter,
			hasPlays: hasPlaysFilter
		}
	};
};
