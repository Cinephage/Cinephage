/**
 * Rename Preview Service
 *
 * Provides dry-run preview and execution of file renames based on naming settings.
 * Allows users to see what would change before applying renames.
 */

import { db } from '#lib/server/db/index.js';
import {
	movies,
	movieFiles,
	series,
	seasons,
	episodes,
	episodeFiles,
	rootFolders,
	renameHistory,
	renamingFailures
} from '#lib/server/db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import { extname, join, dirname, basename, resolve } from 'path';
import { createChildLogger, getRequestId } from '#lib/logging/index.js';
import { todayDateString } from '#lib/utils/format.js';
import { randomUUID } from 'node:crypto';

import { NamingService, type MediaNamingInfo } from './NamingService';
import { namingSettingsService } from './NamingSettingsService';
import { libraryOperationLock } from '../library-operation-lock.js';
import { diskScanService } from '../disk-scan.js';
import { moveFile, fileExists } from '#lib/server/downloadClients/import/FileTransfer.js';
import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import { rename, stat, readdir, rmdir } from 'node:fs/promises';
import { ensureMediaDirectory } from '#lib/server/filesystem/mkdir-helpers.js';
import { chooseBestParsedRelease, resolveAudioLanguages } from './preview-metadata';
import { extractLanguageCodes, resolveLocalizedTitles } from './localization';
import {
	getMediaBrowserManager,
	getMediaBrowserNotifier
} from '#lib/server/notifications/mediabrowser/index.js';
import { syncSubtitleRowsForRenames } from '#lib/server/subtitles/subtitle-rename-sync.js';
import { isSubtitleExtension } from '#lib/server/subtitles/subtitle-content.js';
import { nfoPathFor } from '#lib/server/library/sidecar/NfoGenerator.js';

const logger = createChildLogger({ logDomain: 'scans' as const });

// Yield to the event loop every N files during preview computation so other
// requests are not starved while processing large libraries.
const PREVIEW_BATCH_SIZE = 500;

export type { RenameStreamEvent } from '#lib/library/naming/types.js';
import type { RenameStreamEvent } from '#lib/library/naming/types.js';

// Number of media groups to process concurrently during rename execution.
// Bounds open file handles and OS I/O queue depth.
const EXECUTE_GROUP_BATCH_SIZE = 20;

function yieldToEventLoop(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

// Types are defined in #lib/library/naming/types.ts (outside the server
// bundle) so .svelte files can import them without pulling server code
// into the client. Re-exported here for server-internal consumers.
export type {
	RenameStatus,
	RenamePreviewItem,
	RenamePreviewResult,
	RenameExecuteResult,
	ReorganizeRequestItem,
	ReorganizeBatchResult
} from '#lib/library/naming/types.js';

import type {
	RenamePreviewItem,
	RenamePreviewResult,
	RenameExecuteResult
} from '#lib/library/naming/types.js';

/**
 * Create an empty preview result
 */
function emptyPreviewResult(): RenamePreviewResult {
	return {
		willChange: [],
		alreadyCorrect: [],
		collisions: [],
		errors: [],
		totalFiles: 0,
		totalWillChange: 0,
		totalAlreadyCorrect: 0,
		totalCollisions: 0,
		totalErrors: 0
	};
}

/**
 * Convert audio channels number to string format (e.g., 6 -> "5.1")
 */
function formatAudioChannels(channels?: number): string | undefined {
	if (!channels) return undefined;

	const channelMap: Record<number, string> = {
		1: '1.0',
		2: '2.0',
		6: '5.1',
		8: '7.1'
	};

	return channelMap[channels] || `${channels}.0`;
}

async function recordRenamingFailure(opts: {
	fileId: string;
	fileType: 'movie' | 'episode';
	sourcePath: string;
	intendedPath: string;
	reason: string;
	reasonDetail?: string;
}): Promise<void> {
	await db.insert(renamingFailures).values({
		id: randomUUID(),
		correlationId: getRequestId() ?? randomUUID(),
		fileId: opts.fileId,
		fileType: opts.fileType,
		sourcePath: opts.sourcePath,
		intendedPath: opts.intendedPath,
		reason: opts.reason,
		reasonDetail: opts.reasonDetail ?? null,
		failedAt: new Date().toISOString(),
		status: 'failed'
	});
}

/**
 * Rename Preview Service
 */
export class RenamePreviewService {
	private namingService: NamingService;

	constructor() {
		const config = namingSettingsService.getConfigSync();
		this.namingService = new NamingService(config);
	}

	/**
	 * Parse quality info from filename when stored data is missing
	 */
	private parseFilenameForQuality(filename: string): {
		resolution?: string;
		source?: string;
		codec?: string;
		hdr?: string;
		bitDepth?: string;
		audioCodec?: string;
		audioChannels?: string;
		releaseGroup?: string;
		edition?: string;
		proper?: boolean;
		repack?: boolean;
	} {
		const parser = new ReleaseParser();
		const parsed = parser.parse(filename);

		return {
			resolution: parsed.resolution ?? undefined,
			source: parsed.source ?? undefined,
			codec: parsed.codec ?? undefined,
			hdr: parsed.hdr ?? undefined,
			bitDepth: parsed.bitDepth !== 'unknown' ? parsed.bitDepth : undefined,
			audioCodec: parsed.audioCodec ?? undefined,
			audioChannels: parsed.audioChannels ?? undefined,
			releaseGroup: parsed.releaseGroup ?? undefined,
			edition: parsed.edition ?? undefined,
			proper: parsed.isProper,
			repack: parsed.isRepack
		};
	}

	/**
	 * Resolve localized titles ({Title:xx}/{CleanTitle:xx}) for a movie or
	 * series so renames render the same localized names folder creation does.
	 * No-op unless the active naming formats actually use a localized-title
	 * token, so default configs never hit TMDB.
	 *
	 * Results come from the shared per-title+language cache, so preview and
	 * execute (and reorganize) share one fetch per title + language.
	 */
	private async resolveLocalizedTitlesFor(
		tmdbId: number | null | undefined,
		kind: 'movie' | 'series'
	): Promise<Record<string, string>> {
		if (!tmdbId) return {};
		const config = this.namingService.getConfig();
		const formats =
			kind === 'movie'
				? [config.movieFolderFormat, config.movieFileFormat]
				: [
						config.seriesFolderFormat,
						config.episodeFileFormat,
						config.dailyEpisodeFormat,
						config.animeEpisodeFormat
					];
		const codes = extractLanguageCodes(formats.join(' '));
		if (codes.length === 0) return {};
		try {
			return await resolveLocalizedTitles(tmdbId, codes, kind);
		} catch {
			// Non-fatal: fall back to the base title.
			return {};
		}
	}

	/**
	 * Preview renames for all movies.
	 * Batches DB queries to avoid N+1 per-movie lookups on large libraries.
	 */
	async previewAllMovies(emit?: (event: RenameStreamEvent) => void): Promise<RenamePreviewResult> {
		const allMovies = db.select().from(movies).all();
		const allRootFolders = db.select().from(rootFolders).all();
		const allFiles = db.select().from(movieFiles).all();

		const rootFolderById = new Map(allRootFolders.map((rf) => [rf.id, rf]));
		const filesByMovieId = new Map<string, (typeof movieFiles.$inferSelect)[]>();
		for (const file of allFiles) {
			const list = filesByMovieId.get(file.movieId) || [];
			list.push(file);
			filesByMovieId.set(file.movieId, list);
		}

		const result = emptyPreviewResult();
		let processed = 0;
		const batchWillChange: RenamePreviewItem[] = [];
		const batchAlreadyCorrect: RenamePreviewItem[] = [];
		const batchErrors: RenamePreviewItem[] = [];

		const flushBatch = () => {
			if (!emit) return;
			if (batchWillChange.length)
				emit({ type: 'items', category: 'willChange', data: [...batchWillChange] });
			if (batchAlreadyCorrect.length)
				emit({ type: 'items', category: 'alreadyCorrect', data: [...batchAlreadyCorrect] });
			if (batchErrors.length) emit({ type: 'items', category: 'errors', data: [...batchErrors] });
			batchWillChange.length = 0;
			batchAlreadyCorrect.length = 0;
			batchErrors.length = 0;
		};

		for (const movie of allMovies) {
			const rootFolder = movie.rootFolderId ? rootFolderById.get(movie.rootFolderId) : undefined;
			const rootFolderPath = rootFolder?.path ?? '';
			const rootFolderReadOnly = rootFolder?.readOnly ?? false;
			const files = filesByMovieId.get(movie.id) ?? [];
			const localizedTitles = await this.resolveLocalizedTitlesFor(movie.tmdbId, 'movie');

			for (const file of files) {
				const item = this.buildMoviePreviewItem(
					movie,
					file,
					rootFolderPath,
					rootFolderReadOnly,
					localizedTitles
				);
				result.totalFiles++;

				if (item.status === 'error') {
					result.errors.push(item);
					result.totalErrors++;
					if (emit) batchErrors.push(item);
				} else if (
					item.currentRelativePath === item.newRelativePath &&
					item.currentParentPath === item.newParentPath
				) {
					item.status = 'already_correct';
					result.alreadyCorrect.push(item);
					result.totalAlreadyCorrect++;
					if (emit) batchAlreadyCorrect.push(item);
				} else {
					item.status = 'will_change';
					result.willChange.push(item);
					result.totalWillChange++;
					if (emit) batchWillChange.push(item);
				}
				if (++processed % PREVIEW_BATCH_SIZE === 0) {
					flushBatch();
					await yieldToEventLoop();
				}
			}
		}

		flushBatch();
		this.detectCollisions(result);

		if (emit) {
			if (result.collisions.length) {
				emit({ type: 'items', category: 'collisions', data: result.collisions });
			}
		}

		return result;
	}

	/**
	 * Preview renames for a specific set of movies (partial/targeted recompute).
	 */
	async previewMoviesByIds(movieIds: string[]): Promise<RenamePreviewResult> {
		if (movieIds.length === 0) return emptyPreviewResult();

		const targetMovies = db.select().from(movies).where(inArray(movies.id, movieIds)).all();
		const allRootFolders = db.select().from(rootFolders).all();
		const targetFiles = db
			.select()
			.from(movieFiles)
			.where(inArray(movieFiles.movieId, movieIds))
			.all();

		const rootFolderById = new Map(allRootFolders.map((rf) => [rf.id, rf]));
		const filesByMovieId = new Map<string, (typeof movieFiles.$inferSelect)[]>();
		for (const file of targetFiles) {
			const list = filesByMovieId.get(file.movieId) || [];
			list.push(file);
			filesByMovieId.set(file.movieId, list);
		}

		const result = emptyPreviewResult();

		for (const movie of targetMovies) {
			const rootFolder = movie.rootFolderId ? rootFolderById.get(movie.rootFolderId) : undefined;
			const rootFolderPath = rootFolder?.path ?? '';
			const rootFolderReadOnly = rootFolder?.readOnly ?? false;
			const files = filesByMovieId.get(movie.id) ?? [];
			const localizedTitles = await this.resolveLocalizedTitlesFor(movie.tmdbId, 'movie');

			for (const file of files) {
				const item = this.buildMoviePreviewItem(
					movie,
					file,
					rootFolderPath,
					rootFolderReadOnly,
					localizedTitles
				);
				result.totalFiles++;

				if (item.status === 'error') {
					result.errors.push(item);
					result.totalErrors++;
				} else if (
					item.currentRelativePath === item.newRelativePath &&
					item.currentParentPath === item.newParentPath
				) {
					item.status = 'already_correct';
					result.alreadyCorrect.push(item);
					result.totalAlreadyCorrect++;
				} else {
					item.status = 'will_change';
					result.willChange.push(item);
					result.totalWillChange++;
				}
			}
		}
		return result;
	}

	/**
	 * Preview renames for all episode files.
	 * Batches DB queries to avoid N+1 per-series lookups on large libraries.
	 */
	async previewAllEpisodes(
		emit?: (event: RenameStreamEvent) => void
	): Promise<RenamePreviewResult> {
		const allSeries = db.select().from(series).all();
		const allRootFolders = db.select().from(rootFolders).all();
		const allFiles = db.select().from(episodeFiles).all();
		const allEpisodes = db.select().from(episodes).all();

		const rootFolderById = new Map(allRootFolders.map((rf) => [rf.id, rf]));
		const filesBySeriesId = new Map<string, (typeof episodeFiles.$inferSelect)[]>();
		for (const file of allFiles) {
			const list = filesBySeriesId.get(file.seriesId) || [];
			list.push(file);
			filesBySeriesId.set(file.seriesId, list);
		}
		const episodesBySeriesId = new Map<string, (typeof episodes.$inferSelect)[]>();
		for (const ep of allEpisodes) {
			const list = episodesBySeriesId.get(ep.seriesId) || [];
			list.push(ep);
			episodesBySeriesId.set(ep.seriesId, list);
		}

		const result = emptyPreviewResult();
		let processed = 0;
		const batchWillChange: RenamePreviewItem[] = [];
		const batchAlreadyCorrect: RenamePreviewItem[] = [];
		const batchErrors: RenamePreviewItem[] = [];

		const flushBatch = () => {
			if (!emit) return;
			if (batchWillChange.length)
				emit({ type: 'items', category: 'willChange', data: [...batchWillChange] });
			if (batchAlreadyCorrect.length)
				emit({ type: 'items', category: 'alreadyCorrect', data: [...batchAlreadyCorrect] });
			if (batchErrors.length) emit({ type: 'items', category: 'errors', data: [...batchErrors] });
			batchWillChange.length = 0;
			batchAlreadyCorrect.length = 0;
			batchErrors.length = 0;
		};

		for (const show of allSeries) {
			const rootFolder = show.rootFolderId ? rootFolderById.get(show.rootFolderId) : undefined;
			const rootFolderPath = rootFolder?.path ?? '';
			const rootFolderReadOnly = rootFolder?.readOnly ?? false;
			const files = filesBySeriesId.get(show.id) ?? [];
			const seriesEpisodes = episodesBySeriesId.get(show.id) ?? [];
			const episodeMap = new Map(seriesEpisodes.map((ep) => [ep.id, ep]));
			const absoluteEpisodeMap = this.buildAbsoluteEpisodeFallbackMap(seriesEpisodes);
			const localizedTitles = await this.resolveLocalizedTitlesFor(show.tmdbId, 'series');

			for (const file of files) {
				const item = this.buildEpisodePreviewItem(
					show,
					file,
					episodeMap,
					rootFolderPath,
					absoluteEpisodeMap,
					rootFolderReadOnly,
					localizedTitles
				);
				result.totalFiles++;

				if (item.status === 'error') {
					result.errors.push(item);
					result.totalErrors++;
					if (emit) batchErrors.push(item);
				} else if (
					item.currentRelativePath === item.newRelativePath &&
					item.currentParentPath === item.newParentPath
				) {
					item.status = 'already_correct';
					result.alreadyCorrect.push(item);
					result.totalAlreadyCorrect++;
					if (emit) batchAlreadyCorrect.push(item);
				} else {
					item.status = 'will_change';
					result.willChange.push(item);
					result.totalWillChange++;
					if (emit) batchWillChange.push(item);
				}
				if (++processed % PREVIEW_BATCH_SIZE === 0) {
					flushBatch();
					await yieldToEventLoop();
				}
			}
		}

		flushBatch();
		this.detectCollisions(result);

		if (emit && result.collisions.length) {
			emit({ type: 'items', category: 'collisions', data: result.collisions });
		}

		return result;
	}

	/**
	 * Preview renames for a specific set of series (partial/targeted recompute).
	 */
	async previewSeriesByIds(seriesIds: string[]): Promise<RenamePreviewResult> {
		if (seriesIds.length === 0) return emptyPreviewResult();

		const targetSeries = db.select().from(series).where(inArray(series.id, seriesIds)).all();
		const allRootFolders = db.select().from(rootFolders).all();
		const targetFiles = db
			.select()
			.from(episodeFiles)
			.where(inArray(episodeFiles.seriesId, seriesIds))
			.all();
		const targetEpisodes = db
			.select()
			.from(episodes)
			.where(inArray(episodes.seriesId, seriesIds))
			.all();

		const rootFolderById = new Map(allRootFolders.map((rf) => [rf.id, rf]));
		const filesBySeriesId = new Map<string, (typeof episodeFiles.$inferSelect)[]>();
		for (const file of targetFiles) {
			const list = filesBySeriesId.get(file.seriesId) || [];
			list.push(file);
			filesBySeriesId.set(file.seriesId, list);
		}
		const episodesBySeriesId = new Map<string, (typeof episodes.$inferSelect)[]>();
		for (const ep of targetEpisodes) {
			const list = episodesBySeriesId.get(ep.seriesId) || [];
			list.push(ep);
			episodesBySeriesId.set(ep.seriesId, list);
		}

		const result = emptyPreviewResult();

		for (const show of targetSeries) {
			const rootFolder = show.rootFolderId ? rootFolderById.get(show.rootFolderId) : undefined;
			const rootFolderPath = rootFolder?.path ?? '';
			const rootFolderReadOnly = rootFolder?.readOnly ?? false;
			const files = filesBySeriesId.get(show.id) ?? [];
			const seriesEpisodes = episodesBySeriesId.get(show.id) ?? [];
			const episodeMap = new Map(seriesEpisodes.map((ep) => [ep.id, ep]));
			const absoluteEpisodeMap = this.buildAbsoluteEpisodeFallbackMap(seriesEpisodes);
			const localizedTitles = await this.resolveLocalizedTitlesFor(show.tmdbId, 'series');

			for (const file of files) {
				const item = this.buildEpisodePreviewItem(
					show,
					file,
					episodeMap,
					rootFolderPath,
					absoluteEpisodeMap,
					rootFolderReadOnly,
					localizedTitles
				);
				result.totalFiles++;

				if (item.status === 'error') {
					result.errors.push(item);
					result.totalErrors++;
				} else if (
					item.currentRelativePath === item.newRelativePath &&
					item.currentParentPath === item.newParentPath
				) {
					item.status = 'already_correct';
					result.alreadyCorrect.push(item);
					result.totalAlreadyCorrect++;
				} else {
					item.status = 'will_change';
					result.willChange.push(item);
					result.totalWillChange++;
				}
			}
		}

		return result;
	}

	/**
	 * Preview renames for a single movie
	 */
	async previewMovie(movieId: string): Promise<RenamePreviewResult> {
		const result = emptyPreviewResult();

		const movie = db.select().from(movies).where(eq(movies.id, movieId)).get();
		if (!movie) {
			return result;
		}

		// Get root folder path and read-only status
		let rootFolderPath = '';
		let rootFolderReadOnly = false;
		if (movie.rootFolderId) {
			const rootFolder = db
				.select()
				.from(rootFolders)
				.where(eq(rootFolders.id, movie.rootFolderId))
				.get();
			if (rootFolder) {
				rootFolderPath = rootFolder.path;
				rootFolderReadOnly = rootFolder.readOnly ?? false;
			}
		}

		// Warn when the folder template uses {Collection} but this movie has no
		// collection data — the token resolves to empty string, so the preview
		// will show the movie moving OUT of its collection folder.
		const namingConfig = namingSettingsService.getConfigSync();
		if (namingConfig.movieFolderFormat?.includes('{Collection}') && !movie.collectionName) {
			result.missingCollectionData = true;
		}

		const files = db.select().from(movieFiles).where(eq(movieFiles.movieId, movieId)).all();
		const localizedTitles = await this.resolveLocalizedTitlesFor(movie.tmdbId, 'movie');

		for (const file of files) {
			const item = this.buildMoviePreviewItem(
				movie,
				file,
				rootFolderPath,
				rootFolderReadOnly,
				localizedTitles
			);
			result.totalFiles++;

			if (item.status === 'error') {
				result.errors.push(item);
				result.totalErrors++;
			} else if (
				item.currentRelativePath === item.newRelativePath &&
				item.currentParentPath === item.newParentPath
			) {
				item.status = 'already_correct';
				result.alreadyCorrect.push(item);
				result.totalAlreadyCorrect++;
			} else {
				item.status = 'will_change';
				result.willChange.push(item);
				result.totalWillChange++;
			}
		}

		// Detect collisions within this movie's files
		this.detectCollisions(result);

		return result;
	}

	/**
	 * Preview renames for a series (all episode files)
	 */
	async previewSeries(seriesId: string): Promise<RenamePreviewResult> {
		const result = emptyPreviewResult();

		const show = db.select().from(series).where(eq(series.id, seriesId)).get();
		if (!show) {
			return result;
		}

		// Get root folder path and read-only status
		let rootFolderPath = '';
		let rootFolderReadOnly = false;
		if (show.rootFolderId) {
			const rootFolder = db
				.select()
				.from(rootFolders)
				.where(eq(rootFolders.id, show.rootFolderId))
				.get();
			if (rootFolder) {
				rootFolderPath = rootFolder.path;
				rootFolderReadOnly = rootFolder.readOnly ?? false;
			}
		}

		const files = db.select().from(episodeFiles).where(eq(episodeFiles.seriesId, seriesId)).all();

		// Load all episodes for this series for title lookup
		const allEpisodes = db.select().from(episodes).where(eq(episodes.seriesId, seriesId)).all();
		const episodeMap = new Map(allEpisodes.map((ep) => [ep.id, ep]));
		const absoluteEpisodeMap = this.buildAbsoluteEpisodeFallbackMap(allEpisodes);
		const localizedTitles = await this.resolveLocalizedTitlesFor(show.tmdbId, 'series');

		for (const file of files) {
			const item = this.buildEpisodePreviewItem(
				show,
				file,
				episodeMap,
				rootFolderPath,
				absoluteEpisodeMap,
				rootFolderReadOnly,
				localizedTitles
			);
			result.totalFiles++;

			if (item.status === 'error') {
				result.errors.push(item);
				result.totalErrors++;
			} else if (
				item.currentRelativePath === item.newRelativePath &&
				item.currentParentPath === item.newParentPath
			) {
				item.status = 'already_correct';
				result.alreadyCorrect.push(item);
				result.totalAlreadyCorrect++;
			} else {
				item.status = 'will_change';
				result.willChange.push(item);
				result.totalWillChange++;
			}
		}

		// Detect collisions within this series' files
		this.detectCollisions(result);

		return result;
	}

	/**
	 * Execute approved file renames.
	 *
	 * Renames only the files themselves within their existing parent folder.
	 * Folder reorganization is a SEPARATE operation (see reorganizeFolder).
	 * This separation eliminates the ordering race condition that can destroy
	 * files when folder and file renames are combined.
	 *
	 * Pattern: Radarr's RenameMovieFileService (files only).
	 */
	async executeRenames(
		fileIds: string[],
		mediaType: 'movie' | 'episode' | 'mixed' = 'mixed'
	): Promise<RenameExecuteResult> {
		return libraryOperationLock.withLock('rename', () =>
			this.executeRenamesLocked(fileIds, mediaType)
		);
	}

	private async executeRenamesLocked(
		fileIds: string[],
		_mediaType: 'movie' | 'episode' | 'mixed' = 'mixed'
	): Promise<RenameExecuteResult> {
		if (diskScanService.scanning) {
			throw new Error(
				'A library scan is in progress; the rename was not started. Retry after the scan completes.'
			);
		}

		const result: RenameExecuteResult = {
			success: true,
			processed: 0,
			succeeded: 0,
			failed: 0,
			results: [],
			warnings: []
		};

		if (fileIds.length === 0) {
			return result;
		}

		// Build target paths only for the requested files (not the entire library).
		const renameMap = await this.buildTargetMap(fileIds, result);
		if (renameMap.size === 0) {
			return result;
		}

		// Audit log: record every file's original path and target before any
		// I/O so a recovery trail exists if something goes wrong.
		logger.info(
			{
				renameCount: renameMap.size,
				files: [...renameMap.entries()].map(([fileId, item]) => ({
					fileId,
					mediaType: item.mediaType,
					mediaId: item.mediaId,
					from: item.currentFullPath,
					to: item.newFullPath,
					status: item.status
				}))
			},
			'[RenamePreviewService] Rename audit log — pre-execution state'
		);

		// Group items by mediaId for parallel processing.
		const groups = new Map<string, RenamePreviewItem[]>();
		for (const item of renameMap.values()) {
			const group = groups.get(item.mediaId) || [];
			group.push(item);
			groups.set(item.mediaId, group);
		}

		const touchedMovieIds = new Set<string>();
		const touchedSeriesIds = new Set<string>();

		// Process media groups in batches to bound concurrency and avoid
		// exhausting file descriptors or OS I/O queues on large renames.
		// Files within each group are processed sequentially to avoid
		// filesystem races inside the same folder.
		const groupEntries = [...groups.entries()];

		const processGroup = async ([mediaId, items]: [string, RenamePreviewItem[]]) => {
			const firstItem = items[0];
			if (firstItem?.mediaType === 'movie') {
				touchedMovieIds.add(mediaId);
			} else if (firstItem?.mediaType === 'episode') {
				touchedSeriesIds.add(mediaId);
			}

			const groupResult: RenameExecuteResult['results'] = [];

			for (const item of items) {
				if (item.status === 'collision') {
					const failResult = {
						fileId: item.fileId,
						mediaType: item.mediaType,
						success: false,
						oldPath: item.currentFullPath,
						newPath: item.newFullPath,
						error: 'Cannot rename: collision with another file'
					};
					groupResult.push(failResult);
					await this.writeRenameHistory(item, failResult.success, failResult.error);
					recordRenamingFailure({
						fileId: item.fileId,
						fileType: item.mediaType,
						sourcePath: item.currentFullPath,
						intendedPath: item.newFullPath,
						reason: 'collision',
						reasonDetail: failResult.error
					}).catch((err) =>
						logger.warn({ err }, '[RenamePreviewService] Failed to record renaming failure')
					);
					continue;
				}

				if (item.status === 'error') {
					const failResult = {
						fileId: item.fileId,
						mediaType: item.mediaType,
						success: false,
						oldPath: item.currentFullPath,
						newPath: item.newFullPath,
						error: item.error ?? 'Cannot rename file'
					};
					groupResult.push(failResult);
					await this.writeRenameHistory(item, failResult.success, failResult.error);
					recordRenamingFailure({
						fileId: item.fileId,
						fileType: item.mediaType,
						sourcePath: item.currentFullPath,
						intendedPath: item.newFullPath,
						reason: 'preview_error',
						reasonDetail: failResult.error
					}).catch((err) =>
						logger.warn({ err }, '[RenamePreviewService] Failed to record renaming failure')
					);
					continue;
				}

				const renameResult = await this.executeFileRename(item, result.warnings);
				groupResult.push(renameResult);
				await this.writeRenameHistory(item, renameResult.success, renameResult.error);
				if (!renameResult.success) {
					recordRenamingFailure({
						fileId: item.fileId,
						fileType: item.mediaType,
						sourcePath: item.currentFullPath,
						intendedPath: item.newFullPath,
						reason: 'io_error',
						reasonDetail: renameResult.error
					}).catch((err) =>
						logger.warn({ err }, '[RenamePreviewService] Failed to record renaming failure')
					);
				}
			}

			// After all files in this group are processed, handle any folder rename.
			// A folder rename occurs when at least one file successfully moved to a
			// new parent path. We update the DB path record, move remaining extra
			// files (artwork, nfo, etc.) to the new folder, and clean up empty dirs.
			const successfulFolderChange = items.find((item) => {
				const matched = groupResult.find((r) => r.fileId === item.fileId);
				return matched?.success && item.currentParentPath !== item.newParentPath;
			});
			if (successfulFolderChange && firstItem) {
				const originalStem = basename(
					successfulFolderChange.currentFullPath,
					extname(successfulFolderChange.currentFullPath)
				);
				const folderWarnings = await this.applyFolderRename(
					mediaId,
					firstItem.mediaType as 'movie' | 'episode',
					successfulFolderChange.currentParentPath,
					successfulFolderChange.newParentPath,
					originalStem
				);
				if (folderWarnings.length > 0) {
					result.warnings ??= [];
					result.warnings.push(...folderWarnings);
				}
			}

			// Clean up empty season subdirectories left behind when files moved
			// between season folders within the same series folder (e.g. Season 00
			// -> Specials). The series-level parent path is unchanged so
			// applyFolderRename never runs, but the old season dir may now be empty.
			const oldSeasonDirs = new Set<string>();
			for (const item of items) {
				const matched = groupResult.find((r) => r.fileId === item.fileId);
				if (!matched?.success) continue;
				const oldSeasonDir = dirname(item.currentFullPath);
				const newSeasonDir = dirname(item.newFullPath);
				if (oldSeasonDir !== newSeasonDir) {
					oldSeasonDirs.add(oldSeasonDir);
				}
			}
			for (const dir of oldSeasonDirs) {
				await this.tryRemoveEmptyDir(dir);
			}

			return groupResult;
		};

		for (let i = 0; i < groupEntries.length; i += EXECUTE_GROUP_BATCH_SIZE) {
			const batch = groupEntries.slice(i, i + EXECUTE_GROUP_BATCH_SIZE);
			const batchResults = await Promise.allSettled(batch.map(processGroup));

			// Aggregate results for this batch.
			for (const settled of batchResults) {
				if (settled.status === 'fulfilled') {
					for (const r of settled.value) {
						result.results.push(r);
						result.processed++;
						if (r.success) {
							result.succeeded++;
						} else {
							result.failed++;
							result.success = false;
						}
					}
				} else {
					result.success = false;
				}
			}

			if (i + EXECUTE_GROUP_BATCH_SIZE < groupEntries.length) {
				await yieldToEventLoop();
			}
		}

		await this.reconcileTouchedMedia(touchedMovieIds, touchedSeriesIds);

		return result;
	}

	/**
	 * Write a permanent rename_history record for audit and recovery.
	 */
	private async writeRenameHistory(
		item: RenamePreviewItem,
		success: boolean,
		error?: string
	): Promise<void> {
		try {
			db.insert(renameHistory)
				.values({
					id: randomUUID(),
					fileId: item.fileId,
					mediaType: item.mediaType,
					oldPath: item.currentFullPath,
					newPath: item.newFullPath,
					success: success ? 1 : 0,
					error: error ?? null,
					operation: 'rename',
					createdAt: new Date().toISOString()
				})
				.run();
		} catch (writeError) {
			logger.error(
				{
					error: writeError instanceof Error ? writeError.message : String(writeError),
					fileId: item.fileId
				},
				'[RenamePreviewService] Failed to write rename history'
			);
		}
	}

	/**
	 * Reorganize the parent folder for a single movie or series.
	 *
	 * This is a SEPARATE operation from file renaming.  The naming config is
	 * re-evaluated, and if the folder name would differ from the current
	 * on-disk folder, the folder is renamed and the DB record updated.
	 *
	 * Pattern: Radarr's MoveMovieService / Sonarr's MoveSeriesService.
	 *
	 * Returns true if the folder was reorganized (or already correct).
	 */
	async reorganizeFolder(
		mediaId: string,
		mediaType: 'movie' | 'series'
	): Promise<{ success: boolean; oldPath?: string; newPath?: string; error?: string }> {
		return libraryOperationLock.withLock('reorganize', () =>
			this.reorganizeFolderLocked(mediaId, mediaType)
		);
	}

	private async reorganizeFolderLocked(
		mediaId: string,
		mediaType: 'movie' | 'series'
	): Promise<{ success: boolean; oldPath?: string; newPath?: string; error?: string }> {
		try {
			if (diskScanService.scanning) {
				throw new Error(
					'A library scan is in progress; the rename was not started. Retry after the scan completes.'
				);
			}

			let rootFolderPath = '';
			let currentPath = '';
			let rootFolderId: string | undefined;
			let mediaTmdbId: number | null = null;

			if (mediaType === 'movie') {
				const movie = db.select().from(movies).where(eq(movies.id, mediaId)).get();
				if (!movie) return { success: false, error: 'Movie not found' };
				currentPath = movie.path;
				rootFolderId = movie.rootFolderId ?? undefined;
				mediaTmdbId = movie.tmdbId;
			} else {
				const show = db.select().from(series).where(eq(series.id, mediaId)).get();
				if (!show) return { success: false, error: 'Series not found' };
				currentPath = show.path;
				rootFolderId = show.rootFolderId ?? undefined;
				mediaTmdbId = show.tmdbId;
			}

			if (!rootFolderId) {
				return { success: false, error: 'No root folder assigned' };
			}

			const rootFolder = db
				.select()
				.from(rootFolders)
				.where(eq(rootFolders.id, rootFolderId))
				.get();
			if (!rootFolder) return { success: false, error: 'Root folder not found' };
			if (rootFolder.readOnly) {
				return { success: false, error: 'Cannot reorganize: the root folder is read-only' };
			}
			rootFolderPath = rootFolder.path;

			// Compute the target folder name using the current naming config.
			const config = namingSettingsService.getConfigSync();
			const naming = new NamingService(config);
			// Parity: folder names must localize {Title:xx} exactly like the
			// preview/execute paths above (shared cache makes this free after
			// the first lookup).
			const localizedTitles = await this.resolveLocalizedTitlesFor(mediaTmdbId, mediaType);

			let newFolderName: string;
			if (mediaType === 'movie') {
				const movie = db.select().from(movies).where(eq(movies.id, mediaId)).get()!;
				newFolderName = naming.generateMovieFolderName({
					title: movie.title,
					originalTitle: movie.originalTitle ?? undefined,
					year: movie.year ?? undefined,
					tmdbId: movie.tmdbId,
					imdbId: movie.imdbId ?? undefined,
					collectionName: movie.collectionName ?? undefined,
					localizedTitles
				});
			} else {
				const show = db.select().from(series).where(eq(series.id, mediaId)).get()!;
				newFolderName = naming.generateSeriesFolderName({
					title: show.title,
					originalTitle: show.originalTitle ?? undefined,
					year: show.year ?? undefined,
					tvdbId: show.tvdbId ?? undefined,
					tmdbId: show.tmdbId,
					imdbId: show.imdbId ?? undefined,
					localizedTitles
				});
			}

			if (currentPath === newFolderName) {
				return { success: true, oldPath: currentPath, newPath: newFolderName };
			}

			const actualOldFolder = join(rootFolderPath, currentPath);
			const actualNewFolder = join(rootFolderPath, newFolderName);

			// Never reorganize a movie/series whose tracked path IS the root folder
			// (path '.' or '' — root-level files from media-matcher, or healed rows).
			// Renaming the root itself would uproot every other title in the library
			// and queue a Deleted for the root, wiping the media server's library.
			if (
				resolve(actualOldFolder) === resolve(rootFolderPath) ||
				resolve(actualNewFolder) === resolve(rootFolderPath)
			) {
				return {
					success: false,
					error: 'Cannot reorganize: this item is tracked at the root folder level'
				};
			}

			if (actualOldFolder === actualNewFolder) {
				return { success: true, oldPath: currentPath, newPath: newFolderName };
			}

			const dirExisted = await fileExists(actualOldFolder);
			if (!dirExisted) {
				return { success: false, error: 'Source folder does not exist', oldPath: currentPath };
			}

			// Media-server cleanup is deliberately deferred until AFTER the disk
			// move (below): Jellyfin/Emby `DELETE /Items/{id}` also deletes the
			// file location (DeleteFileLocation = true upstream), so calling it
			// while the files still exist would destroy the media. Once the move
			// has happened the server's stored path is stale, so the delete
			// removes only the old library entry.

			// Write per-file transition rows BEFORE the disk rename so a hard
			// process-kill between the rename and the DB update below can be
			// healed by the scan-diff path (rename_history is consumed by
			// getRecentRenameTransitions). Best-effort: failures don't block
			// the reorganize.
			await this.writeReorganizeHistory(
				mediaType,
				mediaId,
				rootFolderPath,
				currentPath,
				newFolderName
			);

			// The target parent may not exist yet (e.g. letter-bucket naming like
			// "T/Title (2026) [tmdbid-x]") and rename() does not create intermediate
			// directories — create the parent chain before the move.
			await ensureMediaDirectory(dirname(actualNewFolder));

			// Atomically rename the folder on disk.
			await rename(actualOldFolder, actualNewFolder);

			// Verify the destination exists before updating DB.
			const destExists = await fileExists(actualNewFolder);
			if (!destExists) {
				return {
					success: false,
					error: 'Folder rename verification failed',
					oldPath: currentPath,
					newPath: newFolderName
				};
			}

			// Update the DB record. If this fails the disk is already renamed —
			// roll the rename back so disk and DB stay consistent, otherwise the
			// next scan would delete every file row for this title (stale path).
			try {
				this.updateMediaFolderPath(mediaType, mediaId, newFolderName);
			} catch (dbError) {
				const dbMessage = dbError instanceof Error ? dbError.message : String(dbError);
				let rollbackSucceeded = false;
				try {
					await rename(actualNewFolder, actualOldFolder);
					rollbackSucceeded = true;
				} catch (rollbackError) {
					logger.error(
						{
							err: rollbackError,
							from: actualNewFolder,
							to: actualOldFolder,
							mediaId,
							mediaType
						},
						'[RenamePreviewService] CRITICAL: DB update failed AND disk rollback failed — disk and DB are now inconsistent. Resolve the underlying error and rescan.'
					);
				}
				await recordRenamingFailure({
					fileId: mediaId,
					fileType: mediaType === 'movie' ? 'movie' : 'episode',
					sourcePath: actualOldFolder,
					intendedPath: actualNewFolder,
					reason: 'folder_db_update_failed',
					reasonDetail: dbMessage
				}).catch((err) =>
					logger.warn({ err }, '[RenamePreviewService] Failed to record renaming failure')
				);
				return {
					success: false,
					error: rollbackSucceeded
						? `Folder was renamed on disk but the database update failed; the rename was rolled back. (${dbMessage})`
						: `Database update failed after the folder rename AND the rollback failed — the folder remains at its new path on disk while the database still references the old one. Resolve the underlying error and rescan. (${dbMessage})`,
					oldPath: currentPath,
					newPath: newFolderName
				};
			}

			// Delete the old entry from all enabled Jellyfin/Emby servers now that
			// the move has completed and the DB is updated. The server's stored
			// path is stale at this point, so its file-location deletion is a
			// no-op on disk and only the stale library entry (and its children)
			// is removed — preventing the ghost-entry resurrection loop
			// (jellyfin#16883) without ever touching media files. Plex has no
			// item-delete API and reconciles renames via section refreshes.
			// Best-effort: failures don't block the rename.
			// eventKind 'rename': this is part of a rename flow, so it respects
			// each server's onRename toggle (not onDelete).
			if (mediaTmdbId) {
				const manager = getMediaBrowserManager();
				await manager.deleteMediaItemByTmdb(mediaTmdbId, mediaType as 'movie' | 'series', {
					eventKind: 'rename'
				});
			}

			// Notify media servers of both folder paths: the old one as Deleted so
			// Jellyfin/Emby drops the stale entry, the new one as Modified so the
			// renamed folder is discovered as a fresh item. Different paths, so
			// both survive the notifier's per-path dedup.
			getMediaBrowserNotifier().queueUpdate(actualOldFolder, 'Deleted', 'rename');
			getMediaBrowserNotifier().queueUpdate(actualNewFolder, 'Modified', 'rename');

			// Tidy: when the title moved out of a nested parent (e.g. a letter
			// bucket), remove that parent if the rename left it empty. Never
			// touches the root folder itself. tryRemoveEmptyDir is a no-op on
			// non-empty directories, so siblings in the same bucket are safe.
			const oldParent = dirname(actualOldFolder);
			const resolvedRoot = resolve(rootFolderPath);
			const resolvedOldParent = resolve(oldParent);
			if (resolvedOldParent !== resolvedRoot && resolvedOldParent.startsWith(resolvedRoot + '/')) {
				await this.tryRemoveEmptyDir(oldParent);
			}

			logger.info(
				{ mediaId, mediaType, from: actualOldFolder, to: actualNewFolder },
				'[RenamePreviewService] Folder reorganized'
			);

			return { success: true, oldPath: currentPath, newPath: newFolderName };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(
				{ mediaId, mediaType, error: message },
				'[RenamePreviewService] Folder reorganize failed'
			);
			return { success: false, error: message };
		}
	}

	/**
	 * Write one rename_history transition row per tracked file of the media
	 * being reorganized, mapping each file's full old path to its full new
	 * path. Called BEFORE the folder rename on disk so that a hard process
	 * kill between the rename and the DB update can be healed by the next
	 * scan via getRecentRenameTransitions (the folder's files moved with it,
	 * so their relativePath values are unchanged).
	 *
	 * Best-effort audit: history writing must NEVER block or fail the
	 * reorganize — same philosophy as writeRenameHistory.
	 */
	private async writeReorganizeHistory(
		mediaType: 'movie' | 'series',
		mediaId: string,
		rootFolderPath: string,
		oldFolderRel: string,
		newFolderRel: string
	): Promise<void> {
		try {
			const fileRows =
				mediaType === 'movie'
					? db
							.select({ id: movieFiles.id, relativePath: movieFiles.relativePath })
							.from(movieFiles)
							.where(eq(movieFiles.movieId, mediaId))
							.all()
					: db
							.select({ id: episodeFiles.id, relativePath: episodeFiles.relativePath })
							.from(episodeFiles)
							.where(eq(episodeFiles.seriesId, mediaId))
							.all();

			for (const row of fileRows) {
				db.insert(renameHistory)
					.values({
						id: randomUUID(),
						fileId: row.id,
						mediaType: mediaType === 'movie' ? 'movie' : 'episode',
						oldPath: join(rootFolderPath, oldFolderRel, row.relativePath),
						newPath: join(rootFolderPath, newFolderRel, row.relativePath),
						success: 1,
						error: null,
						operation: 'reorganize',
						createdAt: new Date().toISOString()
					})
					.run();
			}
		} catch (writeError) {
			logger.warn(
				{
					error: writeError instanceof Error ? writeError.message : String(writeError),
					mediaId,
					mediaType
				},
				'[RenamePreviewService] Failed to write reorganize history'
			);
		}
	}

	/**
	 * Update movies.path or series.path. Extracted so failure paths can be
	 * tested and both reorganizeFolder and applyFolderRename share it.
	 */
	private updateMediaFolderPath(
		mediaType: 'movie' | 'series',
		mediaId: string,
		newPath: string
	): void {
		if (mediaType === 'movie') {
			db.update(movies).set({ path: newPath }).where(eq(movies.id, mediaId)).run();
		} else {
			db.update(series).set({ path: newPath }).where(eq(series.id, mediaId)).run();
		}
	}

	/**
	 * Reorganize a batch of movie/series folders while holding the operation
	 * lock once for the entire batch, so no library scan can interleave
	 * between items. Per-item failures are isolated and counted.
	 *
	 * Calls the private reorganizeFolderLocked for each item — the lock is
	 * already held and is NOT re-entrant, so the public reorganizeFolder
	 * wrapper must not be used here (it would deadlock).
	 */
	async reorganizeFolders(
		items: Array<{ mediaId: string; mediaType: 'movie' | 'series' }>
	): Promise<{
		total: number;
		organized: number;
		failed: number;
		errors: string[];
		results: Array<{
			mediaId: string;
			mediaType: 'movie' | 'series';
			success: boolean;
			error?: string;
		}>;
	}> {
		return libraryOperationLock.withLock('reorganize-batch', async () => {
			if (diskScanService.scanning) {
				throw new Error(
					'A library scan is in progress; the rename was not started. Retry after the scan completes.'
				);
			}

			let organized = 0;
			let failed = 0;
			const errors: string[] = [];
			const results: Array<{
				mediaId: string;
				mediaType: 'movie' | 'series';
				success: boolean;
				error?: string;
			}> = [];

			for (const item of items) {
				try {
					const result = await this.reorganizeFolderLocked(item.mediaId, item.mediaType);
					if (result.success) {
						organized++;
						results.push({
							mediaId: item.mediaId,
							mediaType: item.mediaType,
							success: true
						});
					} else {
						failed++;
						errors.push(result.error ?? 'Unknown reorganize error');
						results.push({
							mediaId: item.mediaId,
							mediaType: item.mediaType,
							success: false,
							error: result.error
						});
					}
				} catch (error) {
					failed++;
					const message = error instanceof Error ? error.message : String(error);
					errors.push(message);
					results.push({
						mediaId: item.mediaId,
						mediaType: item.mediaType,
						success: false,
						error: message
					});
				}
			}

			return { total: items.length, organized, failed, errors, results };
		});
	}

	/**
	 * Build a fileId → RenamePreviewItem map for a set of file IDs,
	 * computing target paths for only those files.
	 * Unknown or already-correct files are recorded as failures in `result`.
	 */
	private async buildTargetMap(
		fileIds: string[],
		result: RenameExecuteResult
	): Promise<Map<string, RenamePreviewItem>> {
		const renameMap = new Map<string, RenamePreviewItem>();

		// Pre-load root folder readOnly flags for cheap lookup.
		const allRootFolders = db.select().from(rootFolders).all();
		const readOnlyByFolderId = new Map(allRootFolders.map((rf) => [rf.id, rf.readOnly ?? false]));

		for (const fileId of fileIds) {
			// Try movie first
			const movieFile = db.select().from(movieFiles).where(eq(movieFiles.id, fileId)).get();
			if (movieFile) {
				const movie = db.select().from(movies).where(eq(movies.id, movieFile.movieId)).get();
				if (movie) {
					const rootFolderPath = this.resolveRootFolderPath(movie.rootFolderId, allRootFolders);
					const readOnly = readOnlyByFolderId.get(movie.rootFolderId ?? '') ?? false;
					const localizedTitles = await this.resolveLocalizedTitlesFor(movie.tmdbId, 'movie');
					const item = this.buildMoviePreviewItem(
						movie,
						movieFile,
						rootFolderPath,
						readOnly,
						localizedTitles
					);
					if (
						item.status !== 'error' &&
						item.currentRelativePath === item.newRelativePath &&
						item.currentParentPath === item.newParentPath
					) {
						// Already correct – skip (recorded in caller's result)
						continue;
					}
					renameMap.set(fileId, item);
					continue;
				}
			}

			// Try episode
			const episodeFile = db.select().from(episodeFiles).where(eq(episodeFiles.id, fileId)).get();
			if (episodeFile) {
				const show = db.select().from(series).where(eq(series.id, episodeFile.seriesId)).get();
				if (show) {
					const allEpisodes = db
						.select()
						.from(episodes)
						.where(eq(episodes.seriesId, show.id))
						.all();
					const episodeMap = new Map(allEpisodes.map((ep) => [ep.id, ep]));
					const absoluteEpisodeMap = this.buildAbsoluteEpisodeFallbackMap(allEpisodes);
					const rootFolderPath = this.resolveRootFolderPath(show.rootFolderId, allRootFolders);
					const readOnly = readOnlyByFolderId.get(show.rootFolderId ?? '') ?? false;
					const localizedTitles = await this.resolveLocalizedTitlesFor(show.tmdbId, 'series');
					const item = this.buildEpisodePreviewItem(
						show,
						episodeFile,
						episodeMap,
						rootFolderPath,
						absoluteEpisodeMap,
						readOnly,
						localizedTitles
					);
					if (
						item.status !== 'error' &&
						item.currentRelativePath === item.newRelativePath &&
						item.currentParentPath === item.newParentPath
					) {
						continue;
					}
					renameMap.set(fileId, item);
					continue;
				}
			}

			// File not found in either table
			result.results.push({
				fileId,
				mediaType: 'movie',
				success: false,
				oldPath: '',
				newPath: '',
				error: 'File not found in database'
			});
			result.failed++;
			result.processed++;
		}

		// Detect collisions among the requested file set.
		const pathMap = new Map<string, string[]>();
		for (const [fId, item] of renameMap) {
			if (item.status === 'error') continue;
			const paths = pathMap.get(item.newFullPath) || [];
			paths.push(fId);
			pathMap.set(item.newFullPath, paths);
		}
		for (const fileIds of pathMap.values()) {
			if (fileIds.length > 1) {
				for (const collisionFileId of fileIds) {
					const item = renameMap.get(collisionFileId);
					if (item) {
						item.status = 'collision';
						item.collisionsWith = fileIds.filter((id) => id !== collisionFileId);
					}
				}
			}
		}

		return renameMap;
	}

	/**
	 * Resolve a root folder's absolute path from pre-loaded rows.
	 */
	private resolveRootFolderPath(
		rootFolderId: string | null | undefined,
		allRootFolders: (typeof rootFolders.$inferSelect)[]
	): string {
		if (!rootFolderId) return '';
		const rf = allRootFolders.find((r) => r.id === rootFolderId);
		return rf?.path ?? '';
	}

	/**
	 * Execute a single file rename with safety guards:
	 * - Skips no-op moves (source === dest).
	 * - Verifies the destination exists and has size after a successful move.
	 * - Does NOT delete DB records on failure — that is the reconcile pass's job.
	 */
	private async executeFileRename(
		item: RenamePreviewItem,
		warnings: string[] = []
	): Promise<RenameExecuteResult['results'][0]> {
		try {
			// Check if the file is in a read-only folder
			const isReadOnly = await this.isFileInReadOnlyFolder(item);
			if (isReadOnly) {
				logger.warn(
					{
						fileId: item.fileId,
						mediaType: item.mediaType,
						path: item.currentFullPath
					},
					'[RenamePreviewService] Cannot rename file in read-only folder'
				);
				return {
					fileId: item.fileId,
					mediaType: item.mediaType,
					success: false,
					oldPath: item.currentFullPath,
					newPath: item.newFullPath,
					error: 'Cannot rename files in read-only folder'
				};
			}

			// No-op: source and destination already match (resolved to catch path aliasing)
			if (resolve(item.currentFullPath) === resolve(item.newFullPath)) {
				return {
					fileId: item.fileId,
					mediaType: item.mediaType,
					success: true,
					oldPath: item.currentFullPath,
					newPath: item.newFullPath
				};
			}

			// Verify source file exists
			const sourceExists = await fileExists(item.currentFullPath);
			if (!sourceExists) {
				logger.warn(
					{
						fileId: item.fileId,
						mediaType: item.mediaType,
						path: item.currentFullPath
					},
					'[RenamePreviewService] Source file not found'
				);
				return {
					fileId: item.fileId,
					mediaType: item.mediaType,
					success: false,
					oldPath: item.currentFullPath,
					newPath: item.newFullPath,
					error: 'Source file not found'
				};
			}

			// Check if destination already exists (collision check)
			const destExists = await fileExists(item.newFullPath);
			if (destExists && resolve(item.currentFullPath) !== resolve(item.newFullPath)) {
				logger.warn(
					{
						fileId: item.fileId,
						mediaType: item.mediaType,
						currentPath: item.currentFullPath,
						newPath: item.newFullPath
					},
					'[RenamePreviewService] Destination file already exists'
				);
				return {
					fileId: item.fileId,
					mediaType: item.mediaType,
					success: false,
					oldPath: item.currentFullPath,
					newPath: item.newFullPath,
					error: 'Destination file already exists'
				};
			}

			// Perform the rename using moveFile
			const moveResult = await moveFile(item.currentFullPath, item.newFullPath);

			if (!moveResult.success) {
				logger.warn(
					{
						fileId: item.fileId,
						mediaType: item.mediaType,
						from: item.currentFullPath,
						to: item.newFullPath,
						error: moveResult.error
					},
					'[RenamePreviewService] Move operation failed'
				);

				// Rollback: clean up any incomplete destination and verify source
				// integrity.  Pattern: Radarr's RollbackPartialMove / RollbackCopy.
				try {
					const sourceStillExists = await fileExists(item.currentFullPath);
					const destIncomplete = await fileExists(item.newFullPath);

					if (!sourceStillExists && destIncomplete) {
						// Partial copy: source lost but destination exists incompletely.
						// Attempt to restore by moving the destination back.
						const { rename } = await import('node:fs/promises');
						await rename(item.newFullPath, item.currentFullPath);
						logger.info(
							{ fileId: item.fileId, from: item.currentFullPath },
							'[RenamePreviewService] Rolled back — restored from incomplete destination'
						);
					} else if (destIncomplete) {
						// Destination exists incompletely, source still safe — delete dest.
						const { unlink } = await import('node:fs/promises');
						await unlink(item.newFullPath);
						logger.info(
							{ fileId: item.fileId, path: item.newFullPath },
							'[RenamePreviewService] Rolled back — removed incomplete destination'
						);
					} else if (!sourceStillExists) {
						logger.error(
							{
								fileId: item.fileId,
								path: item.currentFullPath
							},
							'[RenamePreviewService] Source file lost during failed move — data may be unrecoverable'
						);
					}
				} catch (rollbackError) {
					logger.error(
						{
							fileId: item.fileId,
							error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
						},
						'[RenamePreviewService] Rollback failed'
					);
				}

				return {
					fileId: item.fileId,
					mediaType: item.mediaType,
					success: false,
					oldPath: item.currentFullPath,
					newPath: item.newFullPath,
					error: moveResult.error || 'Failed to rename file'
				};
			}

			// Post-rename verification: destination must exist and have content.
			let destSize: number | undefined;
			try {
				const destStat = await stat(item.newFullPath);
				destSize = destStat.size;
			} catch {
				logger.error(
					{
						fileId: item.fileId,
						mediaType: item.mediaType,
						destPath: item.newFullPath
					},
					'[RenamePreviewService] Destination file missing after successful move'
				);
				return {
					fileId: item.fileId,
					mediaType: item.mediaType,
					success: false,
					oldPath: item.currentFullPath,
					newPath: item.newFullPath,
					error: 'Destination file not found after move operation'
				};
			}

			if (destSize !== undefined && destSize === 0) {
				logger.warn(
					{
						fileId: item.fileId,
						mediaType: item.mediaType,
						path: item.newFullPath
					},
					'[RenamePreviewService] Destination file is empty after move'
				);
			}

			// Update database with new relative path
			if (item.mediaType === 'movie') {
				db.update(movieFiles)
					.set({ relativePath: item.newRelativePath })
					.where(eq(movieFiles.id, item.fileId))
					.run();
			} else {
				db.update(episodeFiles)
					.set({ relativePath: item.newRelativePath })
					.where(eq(episodeFiles.id, item.fileId))
					.run();
			}

			logger.info(
				{
					fileId: item.fileId,
					mediaType: item.mediaType,
					from: item.currentRelativePath,
					to: item.newRelativePath
				},
				'[RenamePreviewService] File renamed successfully'
			);

			// Notify media servers of both file paths: old as Deleted (drop the
			// stale entry), new as Modified (discover the renamed file). Different
			// paths, so both survive the notifier's per-path dedup.
			getMediaBrowserNotifier().queueUpdate(item.currentFullPath, 'Deleted', 'rename');
			getMediaBrowserNotifier().queueUpdate(item.newFullPath, 'Modified', 'rename');

			// Carry stem-matched sibling subtitles along on in-place renames so
			// external subs stay associated with the renamed video.
			await this.renameSubtitleCompanions(item.currentFullPath, item.newFullPath, warnings, {
				mediaType: item.mediaType,
				mediaId: item.mediaId
			});

			// Carry the generated .nfo along too, same-folder or cross-folder -
			// its path is a deterministic stem match (no directory scan needed,
			// unlike subtitles), so unlike renameSubtitleCompanions this isn't
			// restricted to same-directory renames. Without this the old .nfo
			// is orphaned under the stale name while nothing regenerates a new
			// one to match - at best a missing sidecar, at worst a stale
			// duplicate sitting next to the renamed video.
			await this.renameNfoCompanion(item.currentFullPath, item.newFullPath, warnings);

			return {
				fileId: item.fileId,
				mediaType: item.mediaType,
				success: true,
				oldPath: item.currentFullPath,
				newPath: item.newFullPath
			};
		} catch (error) {
			logger.error(
				{
					fileId: item.fileId,
					error: error instanceof Error ? error.message : String(error)
				},
				'[RenamePreviewService] Failed to rename file'
			);

			return {
				fileId: item.fileId,
				mediaType: item.mediaType,
				success: false,
				oldPath: item.currentFullPath,
				newPath: item.newFullPath,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	/**
	 * Rename sibling subtitle files whose stem matches the old video stem to
	 * the new video stem, preserving language/flag suffix chains (.en.hi,
	 * .forced, .sdh, ...). Only applies to same-directory renames — folder
	 * changes carry all companions via applyFolderRename. Best-effort:
	 * failures produce warnings, never fail the rename.
	 */
	private async renameSubtitleCompanions(
		oldPath: string,
		newPath: string,
		warnings: string[],
		context: { mediaType: 'movie' | 'episode'; mediaId: string }
	): Promise<void> {
		const dir = dirname(oldPath);
		if (dir !== dirname(newPath)) return;
		const oldStem = basename(oldPath, extname(oldPath));
		const newStem = basename(newPath, extname(newPath));
		if (oldStem === newStem) return;

		// Subtitle files: video-stem + optional dot-separated language/flag
		// chain + subtitle extension. e.g. "Movie.en.srt", "Show.en.hi.ass",
		// "Ep.forced.srt", "Ep.sdh.cc.sub"
		const suffixRe =
			/^(\.[a-z]{2,3}(-[a-zA-Z]{2,4})?|\.(forced|cc|sdh|default))*(\.(srt|ass|ssa|sub|vtt))$/i;
		const renamed: Array<{ from: string; to: string }> = [];
		try {
			const entries = await readdir(dir);
			for (const entry of entries) {
				const ext = extname(entry);
				if (!/\.(srt|ass|ssa|sub|vtt)$/i.test(ext)) continue;
				if (!entry.startsWith(oldStem)) continue;
				const suffix = entry.slice(oldStem.length);
				if (!suffixRe.test(suffix)) continue;
				const from = join(dir, entry);
				const to = join(dir, newStem + suffix);
				if (await fileExists(to)) continue;
				try {
					await rename(from, to);
					renamed.push({ from, to });
					logger.info({ from, to }, '[RenamePreviewService] Renamed subtitle companion');
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					warnings.push(`Subtitle "${entry}" could not be renamed: ${message}`);
					logger.warn({ err, from, to }, '[RenamePreviewService] Subtitle companion rename failed');
				}
			}
		} catch (err) {
			// Directory unreadable — non-fatal.
			logger.warn({ err, dir }, '[RenamePreviewService] Could not scan for subtitle companions');
		}

		// Keep DB rows pointing at the renamed sidecars (best-effort).
		if (renamed.length > 0) {
			try {
				await syncSubtitleRowsForRenames({
					mediaType: context.mediaType,
					mediaId: context.mediaId,
					mappings: renamed
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				warnings.push(`Subtitle database paths could not be updated after rename: ${message}`);
				logger.warn(
					{ err, mediaType: context.mediaType, mediaId: context.mediaId },
					'[RenamePreviewService] Failed to sync subtitle rows after companion rename'
				);
			}
		}
	}

	/**
	 * Move the generated .nfo sidecar to match the renamed video's new stem
	 * and/or folder. Best-effort: failures produce a warning, never fail the
	 * rename - the video file itself already moved successfully by this point.
	 */
	private async renameNfoCompanion(
		oldVideoPath: string,
		newVideoPath: string,
		warnings: string[]
	): Promise<void> {
		const oldNfoPath = nfoPathFor(oldVideoPath);
		const newNfoPath = nfoPathFor(newVideoPath);
		if (oldNfoPath === newNfoPath) return;
		if (!(await fileExists(oldNfoPath))) return;
		if (await fileExists(newNfoPath)) {
			// A .nfo already exists at the destination (e.g. from an earlier
			// partial rename) - leave both alone rather than overwrite it.
			return;
		}

		try {
			await rename(oldNfoPath, newNfoPath);
			logger.info(
				{ from: oldNfoPath, to: newNfoPath },
				'[RenamePreviewService] Renamed .nfo companion'
			);
		} catch {
			try {
				const moveResult = await moveFile(oldNfoPath, newNfoPath);
				if (!moveResult.success) throw new Error(moveResult.error);
				logger.info(
					{ from: oldNfoPath, to: newNfoPath },
					'[RenamePreviewService] Moved .nfo companion (cross-filesystem)'
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				warnings.push(`.nfo sidecar could not be renamed: ${message}`);
				logger.warn(
					{ err, from: oldNfoPath, to: newNfoPath },
					'[RenamePreviewService] .nfo companion rename failed'
				);
			}
		}
	}

	/**
	 * After file renames move media into a new parent folder:
	 * 1. Update movie.path / series.path in the DB so the library entry reflects the new location.
	 * 2. Move any remaining files (artwork, nfo, subtitles, etc.) from the old folder to the new one.
	 * 3. Remove the old folder tree if it is now empty.
	 */
	// Extensions that identify companion files (artwork, metadata, subtitles).
	// Used for stem-matched carry when the media file lives in the root folder.
	private static readonly COMPANION_EXTENSIONS = new Set([
		'.nfo',
		'.jpg',
		'.jpeg',
		'.png',
		'.webp',
		'.tbn',
		'.srt',
		'.sub',
		'.ass',
		'.ssa',
		'.vtt',
		'.sup',
		'.idx'
	]);

	private async applyFolderRename(
		mediaId: string,
		mediaType: 'movie' | 'episode',
		oldParentPath: string,
		newParentPath: string,
		originalFileStem: string
	): Promise<string[]> {
		const warnings: string[] = [];
		try {
			let rootFolderId: string | undefined;
			if (mediaType === 'movie') {
				const movie = db.select().from(movies).where(eq(movies.id, mediaId)).get();
				rootFolderId = movie?.rootFolderId ?? undefined;
			} else {
				const show = db.select().from(series).where(eq(series.id, mediaId)).get();
				rootFolderId = show?.rootFolderId ?? undefined;
			}
			if (!rootFolderId) return warnings;

			const rootFolder = db
				.select()
				.from(rootFolders)
				.where(eq(rootFolders.id, rootFolderId))
				.get();
			if (!rootFolder) return warnings;

			const rootFolderPath = rootFolder.path;
			const oldFolder = join(rootFolderPath, oldParentPath);
			const newFolder = join(rootFolderPath, newParentPath);
			const isRootFolder = resolve(oldFolder) === resolve(rootFolderPath);

			// 1. Update DB path record so the library entry shows the correct folder.
			// A failure here leaves series.path/movies.path stale while files have
			// already moved — surface it loudly and record it for the failures
			// report instead of silently reporting batch success.
			try {
				this.updateMediaFolderPath(
					mediaType === 'movie' ? 'movie' : 'series',
					mediaId,
					newParentPath
				);
				logger.info(
					{ mediaId, mediaType, from: oldFolder, to: newFolder, isRootFolder },
					'[RenamePreviewService] Folder path updated in DB after file renames'
				);
			} catch (dbError) {
				const dbMessage = dbError instanceof Error ? dbError.message : String(dbError);
				logger.error(
					{ mediaId, mediaType, from: oldParentPath, to: newParentPath, err: dbError },
					'[RenamePreviewService] Failed to update parent path after file renames'
				);
				warnings.push(
					`The folder path could not be updated in the database (${oldParentPath} → ${newParentPath}): ${dbMessage}. A library rescan may be required.`
				);
				await recordRenamingFailure({
					fileId: mediaId,
					fileType: mediaType === 'movie' ? 'movie' : 'episode',
					sourcePath: oldFolder,
					intendedPath: newFolder,
					reason: 'folder_db_update_failed',
					reasonDetail: dbMessage
				}).catch((err) =>
					logger.warn({ err }, '[RenamePreviewService] Failed to record renaming failure')
				);
			}

			// Notify media servers of the folder change so Jellyfin/Emby drops the
			// old path (Deleted) and scans the new one (Modified). Skipped when the
			// old folder is the library root — a Deleted for the root folder would
			// wipe the whole library entry on the media server. Different paths, so
			// both survive the notifier's per-path dedup.
			if (!isRootFolder && oldFolder !== newFolder) {
				getMediaBrowserNotifier().queueUpdate(oldFolder, 'Deleted', 'rename');
				getMediaBrowserNotifier().queueUpdate(newFolder, 'Modified', 'rename');
			}

			// 2. Move companion files from the old folder to the new folder.
			// When the media file is in a dedicated subfolder, carry everything (the
			// whole folder belongs to this title). When it is in the root folder,
			// only carry files whose names start with the original media file's stem
			// to avoid carrying unrelated files into this title's new subfolder.
			try {
				const entries = await readdir(oldFolder, { withFileTypes: true });
				const unmatchedCompanions: string[] = [];
				const movedSubtitles: Array<{ from: string; to: string }> = [];

				for (const entry of entries) {
					if (!entry.isFile()) continue;

					if (isRootFolder) {
						const entryStem = basename(entry.name, extname(entry.name));
						const entryExt = extname(entry.name).toLowerCase();
						const stemMatches = entryStem.startsWith(originalFileStem);

						if (!stemMatches) {
							// Track companion-extension files we couldn't safely match.
							if (RenamePreviewService.COMPANION_EXTENSIONS.has(entryExt)) {
								unmatchedCompanions.push(entry.name);
							}
							continue;
						}
					}

					const src = join(oldFolder, entry.name);
					const dest = join(newFolder, entry.name);
					if (await fileExists(dest)) continue;
					try {
						await rename(src, dest);
					} catch {
						await moveFile(src, dest);
					}
					if (isSubtitleExtension(extname(entry.name))) {
						movedSubtitles.push({ from: src, to: dest });
					}
				}

				// Keep subtitle rows resolving to the moved sidecars. The media path
				// was already updated above, so this uses the destination-dir fallback
				// matching in syncSubtitleRowsForRenames; most rows already resolve
				// correctly and are left untouched.
				if (movedSubtitles.length > 0) {
					try {
						await syncSubtitleRowsForRenames({
							mediaType,
							mediaId,
							mappings: movedSubtitles
						});
					} catch (err) {
						warnings.push(
							`Subtitle database paths could not be updated after the folder move: ${
								err instanceof Error ? err.message : String(err)
							}`
						);
						logger.warn(
							{ err, mediaId, mediaType },
							'[RenamePreviewService] Failed to sync subtitle rows after folder move'
						);
					}
				}

				if (unmatchedCompanions.length > 0) {
					warnings.push(
						`Some companion files could not be automatically matched to "${originalFileStem}" ` +
							`and were left in the root folder: ${unmatchedCompanions.join(', ')}. ` +
							`Move them manually if needed.`
					);
					logger.info(
						{ mediaId, unmatchedCompanions },
						'[RenamePreviewService] Unmatched companion files left in root folder'
					);
				}
			} catch {
				// Old folder may not exist or be unreadable — not fatal.
			}

			// 3. Remove the old folder tree if empty (handles empty season subfolders for series).
			// Skip when the old folder is the root — never remove the root folder.
			if (!isRootFolder) {
				await this.tryRemoveEmptyDir(oldFolder);
			}
		} catch (error) {
			logger.warn(
				{
					mediaId,
					mediaType,
					error: error instanceof Error ? error.message : String(error)
				},
				'[RenamePreviewService] applyFolderRename cleanup failed (non-fatal)'
			);
		}
		return warnings;
	}

	/**
	 * Recursively remove a directory only if it is entirely empty.
	 * Descends into subdirectories first so empty trees are cleaned bottom-up.
	 * Directories that still contain files are left untouched.
	 */
	private async tryRemoveEmptyDir(dirPath: string): Promise<void> {
		try {
			const entries = await readdir(dirPath, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					await this.tryRemoveEmptyDir(join(dirPath, entry.name));
				}
			}
			await rmdir(dirPath); // no-op fails silently if not empty
		} catch {
			// Directory has remaining files or doesn't exist — both are fine.
		}
	}

	private async reconcileTouchedMedia(
		movieIds: Set<string>,
		seriesIds: Set<string>
	): Promise<void> {
		for (const movieId of movieIds) {
			await this.reconcileMovieFileRecords(movieId);
		}

		for (const seriesId of seriesIds) {
			await this.reconcileSeriesFileRecords(seriesId);
		}
	}

	private async reconcileMovieFileRecords(movieId: string): Promise<void> {
		const movie = db
			.select({ path: movies.path, rootFolderId: movies.rootFolderId, hasFile: movies.hasFile })
			.from(movies)
			.where(eq(movies.id, movieId))
			.get();

		if (!movie?.rootFolderId) {
			return;
		}

		const rootFolder = db
			.select({ path: rootFolders.path })
			.from(rootFolders)
			.where(eq(rootFolders.id, movie.rootFolderId))
			.get();

		if (!rootFolder) {
			return;
		}

		const files = db.select().from(movieFiles).where(eq(movieFiles.movieId, movieId)).all();
		let fileExistsCount = 0;

		for (const file of files) {
			const fullPath = join(rootFolder.path, movie.path, file.relativePath);
			if (await fileExists(fullPath)) {
				fileExistsCount++;
			}
		}

		// Non-destructive: only update hasFile status, never delete records.
		const currentHasFile = !!movie.hasFile;
		const shouldHaveFile = fileExistsCount > 0;

		if (currentHasFile !== shouldHaveFile) {
			db.update(movies).set({ hasFile: shouldHaveFile }).where(eq(movies.id, movieId)).run();
		}
	}

	private async reconcileSeriesFileRecords(seriesId: string): Promise<void> {
		const show = db
			.select({ path: series.path, rootFolderId: series.rootFolderId })
			.from(series)
			.where(eq(series.id, seriesId))
			.get();

		if (!show?.rootFolderId) {
			return;
		}

		const rootFolder = db
			.select({ path: rootFolders.path })
			.from(rootFolders)
			.where(eq(rootFolders.id, show.rootFolderId))
			.get();

		if (!rootFolder) {
			return;
		}

		const allEpisodes = db.select().from(episodes).where(eq(episodes.seriesId, seriesId)).all();
		const files = db.select().from(episodeFiles).where(eq(episodeFiles.seriesId, seriesId)).all();
		const episodeIdsWithFiles = new Set<string>();

		for (const file of files) {
			const fullPath = join(rootFolder.path, show.path, file.relativePath);
			if (await fileExists(fullPath)) {
				for (const episodeId of file.episodeIds ?? []) {
					episodeIdsWithFiles.add(episodeId);
				}
			}
			// Non-destructive: never delete file records.
		}

		for (const episode of allEpisodes) {
			const shouldHaveFile = episodeIdsWithFiles.has(episode.id);
			const hasFile = episode.hasFile ?? false;

			if (shouldHaveFile === hasFile) {
				continue;
			}

			db.update(episodes)
				.set({
					hasFile: shouldHaveFile,
					lastSearchTime: shouldHaveFile ? episode.lastSearchTime : null
				})
				.where(eq(episodes.id, episode.id))
				.run();
		}

		await this.recalculateSeriesEpisodeCounts(seriesId);
	}

	private async recalculateSeriesEpisodeCounts(seriesId: string): Promise<void> {
		const allEpisodes = db.select().from(episodes).where(eq(episodes.seriesId, seriesId)).all();

		const today = todayDateString();
		const isAired = (ep: typeof episodes.$inferSelect) =>
			Boolean(ep.airDate && ep.airDate !== '' && ep.airDate <= today);

		const regularEpisodes = allEpisodes.filter((e) => e.seasonNumber !== 0 && isAired(e));
		const regularEpisodesWithFiles = regularEpisodes.filter((episode) => episode.hasFile);

		db.update(series)
			.set({
				episodeFileCount: regularEpisodesWithFiles.length,
				episodeCount: regularEpisodes.length
			})
			.where(eq(series.id, seriesId))
			.run();

		const seasonCounts = new Map<number, { total: number; withFiles: number }>();
		for (const episode of allEpisodes) {
			if (!isAired(episode)) continue;
			const existing = seasonCounts.get(episode.seasonNumber) ?? { total: 0, withFiles: 0 };
			existing.total += 1;
			if (episode.hasFile) {
				existing.withFiles += 1;
			}
			seasonCounts.set(episode.seasonNumber, existing);
		}

		for (const [seasonNumber, counts] of seasonCounts) {
			db.update(seasons)
				.set({
					episodeCount: counts.total,
					episodeFileCount: counts.withFiles
				})
				.where(and(eq(seasons.seriesId, seriesId), eq(seasons.seasonNumber, seasonNumber)))
				.run();
		}
	}

	/**
	 * Build a preview item for a movie file
	 */
	private buildMoviePreviewItem(
		movie: typeof movies.$inferSelect,
		file: typeof movieFiles.$inferSelect,
		rootFolderPath: string,
		rootFolderReadOnly = false,
		localizedTitles: Record<string, string> = {}
	): RenamePreviewItem {
		if (rootFolderReadOnly) {
			const movieFolderPath = join(rootFolderPath, movie.path);
			return {
				fileId: file.id,
				mediaType: 'movie',
				mediaId: movie.id,
				mediaTitle: movie.title,
				currentParentPath: movie.path,
				currentRelativePath: file.relativePath,
				currentFullPath: join(movieFolderPath, file.relativePath),
				newParentPath: movie.path,
				newRelativePath: file.relativePath,
				newFullPath: join(movieFolderPath, file.relativePath),
				status: 'error',
				error: 'Cannot rename files in read-only folder'
			};
		}

		try {
			// Get current filename for fallback parsing
			const currentFileName = basename(file.relativePath);

			// Parse for quality info - prefer sceneName (original release name) over current filename
			// The sceneName contains the original release info (e.g., "Movie.2024.1080p.BluRay.x264-GROUP")
			// while relativePath may have been renamed and lost metadata (e.g., "Movie (2024) [BluRay-1080p].mkv")
			const parsedFromFilename = this.parseFilenameForQuality(
				chooseBestParsedRelease({
					sceneName: file.sceneName,
					currentFileName,
					actualTitle: movie.title,
					actualYear: movie.year ?? undefined
				}).value
			);

			// Build MediaNamingInfo with the following priority:
			//
			// For VIDEO (resolution, source, codec, HDR):
			//   1. file.quality (from release parsing at import time)
			//   2. parsedFromFilename (re-parsed from current filename)
			//   3. file.mediaInfo (from FFprobe scan - last resort for video)
			//
			// For AUDIO (codec, channels):
			//   1. file.mediaInfo (from FFprobe scan - PREFERRED, as release names are often wrong)
			//   2. parsedFromFilename (fallback if no scan data)
			//
			// For AUDIO LANGUAGES: only FFprobe scan data is evidence. Filename-
			// parsed languages are never proof — absent scan data renders `und`.
			// Rationale: Audio codec in release names is frequently mislabeled (e.g., labeled as
			// DTS but actually contains EAC3). FFprobe scans the actual file and reports what's
			// really there, so renamed files will reflect the true audio format.
			const namingInfo: MediaNamingInfo = {
				title: movie.title,
				originalTitle: movie.originalTitle ?? undefined,
				year: movie.year ?? undefined,
				tmdbId: movie.tmdbId,
				imdbId: movie.imdbId ?? undefined,
				collectionName: movie.collectionName ?? undefined,
				localizedTitles,
				edition: file.edition ?? parsedFromFilename.edition ?? undefined,

				// Video info: prefer release parsing, fall back to filename, then mediaInfo
				resolution: file.quality?.resolution ?? parsedFromFilename.resolution,
				source: file.quality?.source ?? parsedFromFilename.source,
				codec: file.quality?.codec ?? parsedFromFilename.codec ?? file.mediaInfo?.videoCodec,
				hdr: file.quality?.hdr ?? parsedFromFilename.hdr ?? file.mediaInfo?.videoHdrFormat,
				bitDepth: file.mediaInfo?.videoBitDepth?.toString() ?? parsedFromFilename.bitDepth,

				// Audio info: prefer mediaInfo (actual file scan) over filename parsing
				// This ensures renamed files reflect the true audio codec, not mislabeled release names
				audioCodec: file.mediaInfo?.audioCodec ?? parsedFromFilename.audioCodec,
				audioChannels:
					formatAudioChannels(file.mediaInfo?.audioChannels) ?? parsedFromFilename.audioChannels,
				// Audio languages need real scan evidence: filename-parsed values are
				// never audio proof, so absent scan data renders as `und`.
				audioLanguages: resolveAudioLanguages(file.mediaInfo?.audioLanguages),

				releaseGroup: file.releaseGroup ?? parsedFromFilename.releaseGroup,
				proper: parsedFromFilename.proper,
				repack: parsedFromFilename.repack,
				originalExtension: extname(file.relativePath)
			};

			// Generate new filename and folder name
			const newFolderName = this.namingService.generateMovieFolderName(namingInfo);
			const newFileName = this.namingService.generateMovieFileName(namingInfo);

			// Full paths - join root folder path with movie folder and file path
			const currentFolderPath = join(rootFolderPath, movie.path);
			const newFolderPath = join(rootFolderPath, newFolderName);
			const currentFullPath = join(currentFolderPath, file.relativePath);
			// The new full path has the new folder name AND the new file name
			const newFullPath = join(newFolderPath, newFileName);

			return {
				fileId: file.id,
				mediaType: 'movie',
				mediaId: movie.id,
				mediaTitle: movie.title,
				currentParentPath: movie.path,
				currentRelativePath: currentFileName,
				currentFullPath,
				newParentPath: newFolderName,
				newRelativePath: newFileName,
				newFullPath,
				status: 'will_change' // Will be updated based on comparison
			};
		} catch (error) {
			const movieFolderPath = join(rootFolderPath, movie.path);
			return {
				fileId: file.id,
				mediaType: 'movie',
				mediaId: movie.id,
				mediaTitle: movie.title,
				currentParentPath: movie.path,
				currentRelativePath: file.relativePath,
				currentFullPath: join(movieFolderPath, file.relativePath),
				newParentPath: movie.path,
				newRelativePath: file.relativePath,
				newFullPath: join(movieFolderPath, file.relativePath),
				status: 'error',
				error: error instanceof Error ? error.message : 'Failed to generate filename'
			};
		}
	}

	/**
	 * Build a preview item for an episode file
	 */
	private buildEpisodePreviewItem(
		show: typeof series.$inferSelect,
		file: typeof episodeFiles.$inferSelect,
		episodeMap: Map<string, typeof episodes.$inferSelect>,
		rootFolderPath: string,
		absoluteEpisodeMap: Map<string, number>,
		rootFolderReadOnly = false,
		localizedTitles: Record<string, string> = {}
	): RenamePreviewItem {
		if (rootFolderReadOnly) {
			const seriesFolderPath = join(rootFolderPath, show.path);
			return {
				fileId: file.id,
				mediaType: 'episode',
				mediaId: show.id,
				mediaTitle: `${show.title} - S${String(file.seasonNumber).padStart(2, '0')}E${String(file.episodeIds?.[0] ?? '').padStart(2, '0')}`,
				currentParentPath: show.path,
				currentRelativePath: file.relativePath,
				currentFullPath: join(seriesFolderPath, file.relativePath),
				newParentPath: show.path,
				newRelativePath: file.relativePath,
				newFullPath: join(seriesFolderPath, file.relativePath),
				status: 'error',
				error: 'Cannot rename files in read-only folder'
			};
		}

		try {
			// Get current filename for fallback parsing
			const currentFileName = basename(file.relativePath);

			// Parse for quality info - prefer sceneName (original release name) over current filename
			// The sceneName contains the original release info (e.g., "Show.S01E01.1080p.WEB-DL.x264-GROUP")
			// while relativePath may have been renamed and lost metadata
			const parsedFromFilename = this.parseFilenameForQuality(
				chooseBestParsedRelease({
					sceneName: file.sceneName,
					currentFileName,
					actualTitle: show.title,
					actualYear: show.year ?? undefined
				}).value
			);

			// Get episode info from the file's episode IDs
			const episodeIds = file.episodeIds || [];
			const fileEpisodes = episodeIds
				.map((id) => episodeMap.get(id))
				.filter((ep): ep is typeof episodes.$inferSelect => ep !== undefined)
				.sort((a, b) => a.episodeNumber - b.episodeNumber);

			if (fileEpisodes.length === 0) {
				throw new Error('No episode data found for file');
			}

			const firstEpisode = fileEpisodes[0];
			const episodeNumbers = fileEpisodes.map((ep) => ep.episodeNumber);

			// Determine if anime/daily based on series type
			const isAnime = show.seriesType === 'anime';
			const isDaily = show.seriesType === 'daily';

			// Build MediaNamingInfo with the following priority:
			//
			// For VIDEO (resolution, source, codec, HDR):
			//   1. file.quality (from release parsing at import time)
			//   2. parsedFromFilename (re-parsed from current filename)
			//   3. file.mediaInfo (from FFprobe scan - last resort for video)
			//
			// For AUDIO (codec, channels):
			//   1. file.mediaInfo (from FFprobe scan - PREFERRED, as release names are often wrong)
			//   2. parsedFromFilename (fallback if no scan data)
			//
			// For AUDIO LANGUAGES: only FFprobe scan data is evidence. Filename-
			// parsed languages are never proof — absent scan data renders `und`.
			// Rationale: Audio codec in release names is frequently mislabeled (e.g., labeled as
			// DTS but actually contains EAC3). FFprobe scans the actual file and reports what's
			// really there, so renamed files will reflect the true audio format.
			const namingInfo: MediaNamingInfo = {
				title: show.title,
				originalTitle: show.originalTitle ?? undefined,
				year: show.year ?? undefined,
				tvdbId: show.tvdbId ?? undefined,
				tmdbId: show.tmdbId,
				localizedTitles,
				seasonNumber: file.seasonNumber,
				episodeNumbers,
				episodeTitle: firstEpisode.title ?? undefined,
				absoluteNumber:
					firstEpisode.absoluteEpisodeNumber ??
					absoluteEpisodeMap.get(firstEpisode.id) ??
					undefined,
				airDate: firstEpisode.airDate ?? undefined,
				isAnime,
				isDaily,
				edition: file.edition ?? parsedFromFilename.edition ?? undefined,

				// Video info: prefer release parsing, fall back to filename, then mediaInfo
				resolution: file.quality?.resolution ?? parsedFromFilename.resolution,
				source: file.quality?.source ?? parsedFromFilename.source,
				codec: file.quality?.codec ?? parsedFromFilename.codec ?? file.mediaInfo?.videoCodec,
				hdr: file.quality?.hdr ?? parsedFromFilename.hdr ?? file.mediaInfo?.videoHdrFormat,
				bitDepth: file.mediaInfo?.videoBitDepth?.toString() ?? parsedFromFilename.bitDepth,

				// Audio info: prefer mediaInfo (actual file scan) over filename parsing
				// This ensures renamed files reflect the true audio codec, not mislabeled release names
				audioCodec: file.mediaInfo?.audioCodec ?? parsedFromFilename.audioCodec,
				audioChannels:
					formatAudioChannels(file.mediaInfo?.audioChannels) ?? parsedFromFilename.audioChannels,
				audioLanguages: resolveAudioLanguages(file.mediaInfo?.audioLanguages),
				releaseGroup: file.releaseGroup ?? parsedFromFilename.releaseGroup,
				proper: parsedFromFilename.proper,
				repack: parsedFromFilename.repack,
				originalExtension: extname(file.relativePath)
			};

			// Generate new filename and folder name
			const newFolderName = this.namingService.generateSeriesFolderName(namingInfo);
			const newFileName = this.namingService.generateEpisodeFileName(namingInfo);

			// Episode files may include season folder in relative path
			// e.g., "Season 01/Episode.mkv" or just "Episode.mkv"
			const _currentDir = dirname(file.relativePath);

			// Determine if we should use season folders
			const useSeasonFolders = show.seasonFolder ?? true;
			let newRelativePath: string;

			if (useSeasonFolders) {
				const seasonFolder = this.namingService.generateSeasonFolderName(
					file.seasonNumber,
					namingInfo
				);
				newRelativePath = join(seasonFolder, newFileName);
			} else {
				newRelativePath = newFileName;
			}

			// Full paths - join root folder path with series folder and file path
			const currentFolderPath = join(rootFolderPath, show.path);
			const newFolderPath = join(rootFolderPath, newFolderName);
			const currentFullPath = join(currentFolderPath, file.relativePath);
			const newFullPath = join(newFolderPath, newRelativePath);

			return {
				fileId: file.id,
				mediaType: 'episode',
				mediaId: show.id,
				mediaTitle: `${show.title} - S${String(file.seasonNumber).padStart(2, '0')}E${String(episodeNumbers[0]).padStart(2, '0')}`,
				currentParentPath: show.path,
				currentRelativePath: file.relativePath,
				currentFullPath,
				newParentPath: newFolderName,
				newRelativePath,
				newFullPath,
				status: 'will_change'
			};
		} catch (error) {
			const seriesFolderPath = join(rootFolderPath, show.path);
			return {
				fileId: file.id,
				mediaType: 'episode',
				mediaId: show.id,
				mediaTitle: show.title,
				currentParentPath: show.path,
				currentRelativePath: file.relativePath,
				currentFullPath: join(seriesFolderPath, file.relativePath),
				newParentPath: show.path,
				newRelativePath: file.relativePath,
				newFullPath: join(seriesFolderPath, file.relativePath),
				status: 'error',
				error: error instanceof Error ? error.message : 'Failed to generate filename'
			};
		}
	}

	private buildAbsoluteEpisodeFallbackMap(
		allEpisodes: Array<typeof episodes.$inferSelect>
	): Map<string, number> {
		const absoluteEpisodeMap = new Map<string, number>();
		let lastAbsolute = 0;

		const regularEpisodes = [...allEpisodes]
			.filter((episode) => episode.seasonNumber > 0)
			.sort((a, b) => {
				if (a.seasonNumber !== b.seasonNumber) {
					return a.seasonNumber - b.seasonNumber;
				}
				return a.episodeNumber - b.episodeNumber;
			});

		for (const episode of regularEpisodes) {
			if (typeof episode.absoluteEpisodeNumber === 'number' && episode.absoluteEpisodeNumber > 0) {
				lastAbsolute = episode.absoluteEpisodeNumber;
				absoluteEpisodeMap.set(episode.id, episode.absoluteEpisodeNumber);
				continue;
			}

			lastAbsolute += 1;
			absoluteEpisodeMap.set(episode.id, lastAbsolute);
		}

		return absoluteEpisodeMap;
	}

	/**
	 * Check if a file is in a read-only root folder
	 */
	private async isFileInReadOnlyFolder(item: RenamePreviewItem): Promise<boolean> {
		if (item.mediaType === 'movie') {
			// Get movie's root folder
			const movie = db
				.select({ rootFolderId: movies.rootFolderId })
				.from(movies)
				.where(eq(movies.id, item.mediaId))
				.get();

			if (movie?.rootFolderId) {
				const folder = db
					.select({ readOnly: rootFolders.readOnly })
					.from(rootFolders)
					.where(eq(rootFolders.id, movie.rootFolderId))
					.get();
				return folder?.readOnly ?? false;
			}
		} else {
			// Get series' root folder (mediaId is seriesId for episodes)
			const show = db
				.select({ rootFolderId: series.rootFolderId })
				.from(series)
				.where(eq(series.id, item.mediaId))
				.get();

			if (show?.rootFolderId) {
				const folder = db
					.select({ readOnly: rootFolders.readOnly })
					.from(rootFolders)
					.where(eq(rootFolders.id, show.rootFolderId))
					.get();
				return folder?.readOnly ?? false;
			}
		}
		return false;
	}

	/**
	 * Detect collisions in a preview result
	 * Two files collide if they would be renamed to the same path
	 */
	private detectCollisions(result: RenamePreviewResult): void {
		// Build a map of newFullPath -> items
		const pathMap = new Map<string, RenamePreviewItem[]>();

		for (const item of result.willChange) {
			const existing = pathMap.get(item.newFullPath) || [];
			existing.push(item);
			pathMap.set(item.newFullPath, existing);
		}

		// Find collisions (paths with more than one item)
		for (const [_path, items] of pathMap) {
			if (items.length > 1) {
				// Mark all items as collisions
				for (const item of items) {
					item.status = 'collision';
					item.collisionsWith = items.filter((i) => i.fileId !== item.fileId).map((i) => i.fileId);

					// Move from willChange to collisions
					const idx = result.willChange.indexOf(item);
					if (idx !== -1) {
						result.willChange.splice(idx, 1);
						result.collisions.push(item);
						result.totalWillChange--;
						result.totalCollisions++;
					}
				}
			}
		}
	}
}
