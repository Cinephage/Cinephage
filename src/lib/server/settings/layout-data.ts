import type { LibraryBreakdownItem } from '#lib/components/storage/utils.js';
import { sql } from 'drizzle-orm';
import { getRootFolderService } from '#lib/server/downloadClients/RootFolderService.js';
import { getEffectiveAnimeRootFolderEnforcement } from '#lib/server/library/anime-root-enforcement-settings.js';
import { getFileManagementSettings } from '#lib/server/settings/file-management.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { db } from '#lib/server/db/index.js';
import {
	episodeFiles,
	libraryScanHistory,
	movieFiles,
	movies,
	series,
	subtitles,
	unmatchedFiles
} from '#lib/server/db/schema.js';

type StorageBreakdownItem = {
	id: string;
	name: string;
	mediaType: 'movie' | 'tv';
	mediaSubType: 'standard' | 'anime';
	usedBytes: number;
	itemCount: number;
	path?: string | null;
	hasRootFolder?: boolean;
	accessible?: boolean;
	readOnly?: boolean;
	freeSpaceBytes?: number | null;
	totalSpaceBytes?: number | null;
	freeSpaceFormatted?: string | null;
	rootFolderCount?: number;
	rootFolderIds?: string[];
	detachedItemCount?: number;
	defaultSearchOnAdd?: boolean;
	defaultWantsSubtitles?: boolean;
	unmatchedCount?: number;
	lastScannedAt?: string | null;
	lastScanStatus?: string | null;
	needsScan?: boolean;
	freeRatio?: number | null;
};

export async function loadStorageLayoutData() {
	const rootFolderService = getRootFolderService();
	const libraryService = getLibraryEntityService();

	const [
		rootFolders,
		enforceAnimeSubtype,
		fileManagementSettings,
		libraries,
		movieStats,
		tvStats,
		subtitleStats,
		libraryMovieUsage,
		librarySeriesUsage,
		detachedMovieUsage,
		detachedSeriesUsage,
		unmatchedStats,
		unmatchedByRootFolder,
		recentRootFolderScans,
		lastScan
	] = await Promise.all([
		rootFolderService.getFolders(),
		getEffectiveAnimeRootFolderEnforcement(),
		getFileManagementSettings(),
		libraryService.listLibraries(),
		db
			.select({
				usedBytes: sql<number>`COALESCE(SUM(${movieFiles.size}), 0)`,
				itemCount: sql<number>`COUNT(DISTINCT ${movies.id})`
			})
			.from(movies)
			.leftJoin(movieFiles, sql`${movieFiles.movieId} = ${movies.id}`)
			.get(),
		db
			.select({
				usedBytes: sql<number>`COALESCE(SUM(${episodeFiles.size}), 0)`,
				itemCount: sql<number>`COUNT(DISTINCT ${series.id})`
			})
			.from(series)
			.leftJoin(episodeFiles, sql`${episodeFiles.seriesId} = ${series.id}`)
			.get(),
		db
			.select({
				usedBytes: sql<number>`COALESCE(SUM(${subtitles.size}), 0)`,
				itemCount: sql<number>`COUNT(${subtitles.id})`
			})
			.from(subtitles)
			.get(),
		db
			.select({
				libraryId: movies.libraryId,
				usedBytes: sql<number>`COALESCE(SUM(${movieFiles.size}), 0)`,
				itemCount: sql<number>`COUNT(DISTINCT ${movies.id})`
			})
			.from(movies)
			.leftJoin(movieFiles, sql`${movieFiles.movieId} = ${movies.id}`)
			.groupBy(movies.libraryId),
		db
			.select({
				libraryId: series.libraryId,
				usedBytes: sql<number>`COALESCE(SUM(${episodeFiles.size}), 0)`,
				itemCount: sql<number>`COUNT(DISTINCT ${series.id})`
			})
			.from(series)
			.leftJoin(episodeFiles, sql`${episodeFiles.seriesId} = ${series.id}`)
			.groupBy(series.libraryId),
		db
			.select({
				libraryId: movies.libraryId,
				itemCount: sql<number>`COUNT(DISTINCT ${movies.id})`
			})
			.from(movies)
			.where(sql`${movies.rootFolderId} IS NULL`)
			.groupBy(movies.libraryId),
		db
			.select({
				libraryId: series.libraryId,
				itemCount: sql<number>`COUNT(DISTINCT ${series.id})`
			})
			.from(series)
			.where(sql`${series.rootFolderId} IS NULL`)
			.groupBy(series.libraryId),
		db
			.select({
				itemCount: sql<number>`COUNT(${unmatchedFiles.id})`
			})
			.from(unmatchedFiles)
			.get(),
		db
			.select({
				rootFolderId: unmatchedFiles.rootFolderId,
				itemCount: sql<number>`COUNT(${unmatchedFiles.id})`
			})
			.from(unmatchedFiles)
			.groupBy(unmatchedFiles.rootFolderId),
		db
			.select({
				rootFolderId: libraryScanHistory.rootFolderId,
				status: libraryScanHistory.status,
				startedAt: libraryScanHistory.startedAt,
				completedAt: libraryScanHistory.completedAt
			})
			.from(libraryScanHistory)
			.where(
				sql`${libraryScanHistory.rootFolderId} IS NOT NULL AND ${libraryScanHistory.startedAt} = (
					SELECT MAX(started_at) FROM library_scan_history h2
					WHERE h2.root_folder_id = ${libraryScanHistory.rootFolderId}
				)`
			),
		db
			.select({
				status: libraryScanHistory.status,
				scanType: libraryScanHistory.scanType,
				startedAt: libraryScanHistory.startedAt,
				completedAt: libraryScanHistory.completedAt,
				filesScanned: libraryScanHistory.filesScanned,
				filesAdded: libraryScanHistory.filesAdded,
				filesUpdated: libraryScanHistory.filesUpdated,
				filesRemoved: libraryScanHistory.filesRemoved,
				unmatchedFiles: libraryScanHistory.unmatchedFiles,
				errorMessage: libraryScanHistory.errorMessage
			})
			.from(libraryScanHistory)
			.orderBy(sql`${libraryScanHistory.startedAt} DESC`)
			.limit(1)
			.get()
	]);

	const usageByLibrary = new Map<string, { usedBytes: number; itemCount: number }>();
	const detachedByLibrary = new Map<string, number>();
	const unmatchedByRootFolderMap = new Map<string, number>();
	const latestScanByRootFolder = new Map<
		string,
		{ status: string | null; startedAt: string | null; completedAt: string | null }
	>();

	for (const row of [...libraryMovieUsage, ...librarySeriesUsage]) {
		if (!row.libraryId) continue;
		const current = usageByLibrary.get(row.libraryId) ?? { usedBytes: 0, itemCount: 0 };
		current.usedBytes += Number(row.usedBytes ?? 0);
		current.itemCount += Number(row.itemCount ?? 0);
		usageByLibrary.set(row.libraryId, current);
	}

	for (const row of [...detachedMovieUsage, ...detachedSeriesUsage]) {
		if (!row.libraryId) continue;
		detachedByLibrary.set(
			row.libraryId,
			(detachedByLibrary.get(row.libraryId) ?? 0) + Number(row.itemCount ?? 0)
		);
	}

	for (const row of unmatchedByRootFolder) {
		if (!row.rootFolderId) continue;
		unmatchedByRootFolderMap.set(row.rootFolderId, Number(row.itemCount ?? 0));
	}

	for (const row of recentRootFolderScans) {
		if (!row.rootFolderId || latestScanByRootFolder.has(row.rootFolderId)) continue;
		latestScanByRootFolder.set(row.rootFolderId, {
			status: row.status,
			startedAt: row.startedAt,
			completedAt: row.completedAt
		});
	}

	const libraryBreakdown: LibraryBreakdownItem[] = libraries.map((library) => {
		const usage = usageByLibrary.get(library.id) ?? { usedBytes: 0, itemCount: 0 };
		const unmatchedCount = (library.rootFolders ?? []).reduce(
			(sum, folder) => sum + (unmatchedByRootFolderMap.get(folder.id) ?? 0),
			0
		);
		const needsScan =
			(library.rootFolders?.length ?? 0) > 0 &&
			library.rootFolders.some((folder) => {
				const scan = latestScanByRootFolder.get(folder.id);
				return !scan || scan.status !== 'completed';
			});
		return {
			id: library.id,
			name: library.name,
			slug: library.slug,
			isDefault: library.isDefault,
			mediaType: library.mediaType,
			mediaSubType: library.mediaSubType,
			usedBytes: usage.usedBytes,
			itemCount: usage.itemCount,
			path: library.defaultRootFolderPath,
			hasRootFolder: (library.rootFolders?.length ?? 0) > 0,
			rootFolderCount: library.rootFolders?.length ?? 0,
			rootFolderIds: library.rootFolders?.map((f) => f.id) ?? [],
			detachedItemCount: detachedByLibrary.get(library.id) ?? 0,
			defaultSearchOnAdd: library.defaultSearchOnAdd,
			defaultWantsSubtitles: library.defaultWantsSubtitles,
			unmatchedCount,
			needsScan,
			scanMode: library.scanMode
		};
	});

	const rootFolderBreakdown: StorageBreakdownItem[] = rootFolders.map((folder) => {
		const matchingLibraries = libraryBreakdown.filter(
			(item) =>
				item.mediaType === folder.mediaType &&
				item.mediaSubType === (folder.mediaSubType ?? 'standard') &&
				item.path === folder.path
		);
		const usedBytes = matchingLibraries.reduce((sum, item) => sum + item.usedBytes, 0);
		const itemCount = matchingLibraries.reduce((sum, item) => sum + item.itemCount, 0);
		return {
			id: folder.id,
			name: folder.name,
			path: folder.path,
			mediaType: folder.mediaType,
			mediaSubType: folder.mediaSubType ?? 'standard',
			usedBytes,
			itemCount,
			accessible: folder.accessible,
			readOnly: folder.readOnly,
			freeSpaceBytes: folder.freeSpaceBytes,
			totalSpaceBytes: folder.totalSpaceBytes ?? null,
			freeSpaceFormatted: folder.freeSpaceFormatted ?? null,
			freeRatio:
				folder.totalSpaceBytes !== null &&
				folder.totalSpaceBytes !== undefined &&
				folder.totalSpaceBytes > 0
					? Number(folder.freeSpaceBytes ?? 0) / Number(folder.totalSpaceBytes)
					: null,
			unmatchedCount: unmatchedByRootFolderMap.get(folder.id) ?? 0,
			lastScannedAt: latestScanByRootFolder.get(folder.id)?.completedAt ?? null,
			lastScanStatus: latestScanByRootFolder.get(folder.id)?.status ?? null,
			needsScan:
				!latestScanByRootFolder.has(folder.id) ||
				latestScanByRootFolder.get(folder.id)?.status !== 'completed'
		};
	});

	const librariesWithoutRootFolder = libraryBreakdown.filter((item) => !item.hasRootFolder).length;
	const inaccessibleRootFolders = rootFolderBreakdown.filter(
		(item) => item.accessible === false
	).length;
	const readOnlyRootFolders = rootFolderBreakdown.filter((item) => item.readOnly === true).length;

	return {
		rootFolders,
		enforceAnimeSubtype,
		symlinkModeEnabled: fileManagementSettings.importMode === 'symlink',
		libraries,
		storage: {
			totalUsedBytes:
				Number(movieStats?.usedBytes ?? 0) +
				Number(tvStats?.usedBytes ?? 0) +
				Number(subtitleStats?.usedBytes ?? 0),
			moviesUsedBytes: Number(movieStats?.usedBytes ?? 0),
			tvUsedBytes: Number(tvStats?.usedBytes ?? 0),
			subtitlesUsedBytes: Number(subtitleStats?.usedBytes ?? 0),
			movieCount: Number(movieStats?.itemCount ?? 0),
			seriesCount: Number(tvStats?.itemCount ?? 0),
			subtitleCount: Number(subtitleStats?.itemCount ?? 0),
			libraryBreakdown,
			rootFolderBreakdown,
			health: {
				librariesWithoutRootFolder,
				inaccessibleRootFolders,
				readOnlyRootFolders,
				unmatchedFiles: Number(unmatchedStats?.itemCount ?? 0),
				rootFoldersNeedingScan: rootFolderBreakdown.filter((item) => item.needsScan).length,
				totalDetachedItems: [...detachedByLibrary.values()].reduce((sum, count) => sum + count, 0),
				lastScan: lastScan
					? {
							status: lastScan.status,
							scanType: lastScan.scanType,
							startedAt: lastScan.startedAt,
							completedAt: lastScan.completedAt,
							filesScanned: Number(lastScan.filesScanned ?? 0),
							filesAdded: Number(lastScan.filesAdded ?? 0),
							filesUpdated: Number(lastScan.filesUpdated ?? 0),
							filesRemoved: Number(lastScan.filesRemoved ?? 0),
							unmatchedFiles: Number(lastScan.unmatchedFiles ?? 0),
							errorMessage: lastScan.errorMessage,
							durationMs:
								lastScan.startedAt && lastScan.completedAt
									? new Date(lastScan.completedAt).getTime() -
										new Date(lastScan.startedAt).getTime()
									: null
						}
					: null
			}
		}
	};
}
