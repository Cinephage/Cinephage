/**
 * Disk Scan Service
 *
 * Recursively scans root folders for video files, filters out samples/extras,
 * and detects new, changed, or removed files by comparing against the database.
 */

import {
	recalculateMovieShortfall,
	recalculateSeriesShortfall
} from '#lib/server/languages/language-shortfall.js';
import { readdir, stat } from 'fs/promises';
import { join, dirname, relative, basename } from 'path';
import { db } from '#lib/server/db/index.js';
import { todayDateString } from '#lib/utils/format.js';
import {
	rootFolders,
	movies,
	movieFiles,
	series,
	seasons,
	episodes,
	episodeFiles,
	unmatchedFiles,
	libraryScanHistory,
	renameHistory
} from '#lib/server/db/schema.js';
import { eq, and, inArray, gte } from 'drizzle-orm';
import { isVideoFile, mediaInfoService } from './media-info.js';
import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import { EventEmitter } from 'events';
import { createChildLogger } from '#lib/logging/index.js';
import { DOWNLOAD } from '#lib/config/constants.js';
import {
	findOverlappingRootFolder,
	getRootFolderOverlapMessage
} from '#lib/server/filesystem/root-folder-overlap.js';
import { libraryMediaEvents } from './LibraryMediaEvents.js';
import { getMediaParseStem } from './media-utils.js';
import { matchEpisodesByIdentifier, resolveTvEpisodeIdentifier } from './tv-episode-resolver.js';
import {
	matchSpecialEpisodeByTitle,
	type SpecialEpisodeTitleMatch
} from './episode-title-matcher.js';
import { StreamingDiskScanner } from './jobs/StreamingDiskScanner.js';
import { libraryOperationLock } from './library-operation-lock.js';

const logger = createChildLogger({ logDomain: 'scans' as const });

/**
 * Patterns to filter out sample/extra files
 * Based on Radarr/Sonarr patterns
 */
const EXCLUDED_PATTERNS = {
	samples: [/\bsample\b/i],
	excludedFolders: [
		/^\./,
		/^@/,
		/^#recycle$/i,
		/^lost\+found$/i,
		/^\$recycle\.bin$/i,
		/^system volume information$/i,
		/^thumbs\.db$/i,
		/^\.ds_store$/i,
		/^samples?$/i,
		/^extras?$/i,
		/^featurettes?$/i,
		/^behind[\s._-]?the[\s._-]?scenes?$/i,
		/^deleted[\s._-]?scenes?$/i,
		/^specials?$/i,
		/^subs?$/i,
		/^subtitles?$/i
	]
};

/**
 * SQLite has a practical limit on bound parameters; keep IN queries chunked.
 */
const DB_CHUNK_SIZE = 400;

/** How long after a rename its old→new transition remains eligible for scan-diff healing. */
const RENAME_TRANSITION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * If a DB-tracked path is missing on disk but a recent successful rename
 * moved it to a path that IS present, return the new path so the row can be
 * healed instead of deleted. Returns null when the file should be removed.
 */
export function findRenameHealTarget(
	missingPath: string,
	transitions: Map<string, string>,
	seenPaths: Set<string>
): string | null {
	const target = transitions.get(missingPath);
	return target && seenPaths.has(target) ? target : null;
}

/**
 * Correlate missing tracked paths with newly-seen on-disk paths that share
 * the same file basename and size — the signature of a folder rename made
 * outside Cinephage (user, Sonarr, file manager). Returns a map
 * oldFullPath → newFullPath for confident matches only: same basename, same
 * size (when the DB row has a size), unambiguous (exactly one candidate),
 * and one-to-one (each new path is claimed by at most one missing row).
 *
 * Heuristic limits: a false positive requires an identical filename AND an
 * identical byte size within a single root scan — e.g. two copies of the
 * same release kept under different folders (one tracked at the old path,
 * one newly discovered) would heal the tracked row onto the copy. Duplicate
 * basenames with equal sizes are treated as ambiguous and never matched,
 * and a new path can only ever claim a single missing row.
 */
export function findExternalRenameMatches(
	missingFiles: Array<{
		id: string;
		path: string;
		size: number | null;
		allowStrmProbe: boolean;
		source: 'tracked' | 'unmatched';
	}>,
	newDiskFiles: Array<{ path: string; size: number }>
): Map<string, string> {
	const byBasename = new Map<string, Array<{ path: string; size: number }>>();
	for (const file of newDiskFiles) {
		const list = byBasename.get(basename(file.path));
		if (list) {
			list.push(file);
		} else {
			byBasename.set(basename(file.path), [file]);
		}
	}

	const matches = new Map<string, string>();
	const claimed = new Set<string>();
	for (const missing of missingFiles) {
		const candidates = (byBasename.get(basename(missing.path)) ?? []).filter(
			(candidate) => missing.size == null || candidate.size === missing.size
		);
		if (candidates.length !== 1) continue;

		const candidate = candidates[0];
		if (claimed.has(candidate.path)) continue;

		claimed.add(candidate.path);
		matches.set(missing.path, candidate.path);
	}
	return matches;
}

/**
 * Discovered file information
 */
export interface DiscoveredFile {
	path: string;
	relativePath: string;
	size: number;
	modifiedAt: Date;
	parentFolder: string;
	contentCategory?: 'main' | 'bonus';
	structureMatch?: {
		seriesTitle?: string;
		year?: number;
		season?: number;
		episode?: number;
		isBonus: boolean;
	} | null;
}

/**
 * Scan progress information
 */
export interface ScanProgress {
	phase: 'scanning' | 'processing' | 'matching' | 'complete';
	rootFolderId: string;
	rootFolderPath: string;
	filesFound: number;
	filesProcessed: number;
	filesAdded: number;
	filesUpdated: number;
	filesRemoved: number;
	unmatchedCount: number;
	currentFile?: string;
	error?: string;
}

/**
 * Scan result summary
 */
export interface ScanResult {
	success: boolean;
	scanId: string;
	rootFolderId: string;
	rootFolderPath: string;
	filesScanned: number;
	filesAdded: number;
	filesUpdated: number;
	filesRemoved: number;
	unmatchedFiles: number;
	duration: number;
	error?: string;
}

/**
 * DiskScanService - Scan filesystem for media files
 */
export class DiskScanService extends EventEmitter {
	private static instance: DiskScanService;
	private parser: ReleaseParser;
	private isScanning = false;
	private currentScanId: string | null = null;
	private scanAborted = false;
	private shouldCancel: (() => Promise<boolean>) | null = null;

	setCancelCheck(fn: (() => Promise<boolean>) | null): void {
		this.shouldCancel = fn;
	}

	private constructor() {
		super();
		this.parser = new ReleaseParser();
	}

	static getInstance(): DiskScanService {
		if (!DiskScanService.instance) {
			DiskScanService.instance = new DiskScanService();
		}
		return DiskScanService.instance;
	}

	get scanning(): boolean {
		return this.isScanning;
	}

	get activeScanId(): string | null {
		return this.currentScanId;
	}

	cancelScan(): void {
		this.scanAborted = true;
	}

	private shouldExcludeFolder(folderName: string, customPatterns: string[] = []): boolean {
		if (EXCLUDED_PATTERNS.excludedFolders.some((pattern) => pattern.test(folderName))) {
			return true;
		}
		const lower = folderName.toLowerCase();
		return customPatterns.some((p) => p.toLowerCase() === lower);
	}

	private shouldExcludeFile(
		fileName: string,
		filePath: string,
		customPatterns: string[] = [],
		blockedExtensions: string[] = []
	): boolean {
		if (EXCLUDED_PATTERNS.samples.some((pattern) => pattern.test(fileName))) {
			return true;
		}

		if (blockedExtensions.length > 0) {
			const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
			if (blockedExtensions.includes(ext)) {
				return true;
			}
		}

		const pathParts = filePath.split('/');
		for (const part of pathParts) {
			if (this.shouldExcludeFolder(part, customPatterns)) {
				return true;
			}
		}

		return false;
	}

	private async discoverFiles(
		rootPath: string,
		currentPath: string = rootPath,
		customPatterns: string[] = [],
		blockedExtensions: string[] = []
	): Promise<DiscoveredFile[]> {
		const files: DiscoveredFile[] = [];

		try {
			const entries = await readdir(currentPath, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = join(currentPath, entry.name);

				if (entry.isDirectory()) {
					if (this.shouldExcludeFolder(entry.name, customPatterns)) {
						continue;
					}

					const subFiles = await this.discoverFiles(
						rootPath,
						fullPath,
						customPatterns,
						blockedExtensions
					);
					files.push(...subFiles);
				} else if (entry.isFile()) {
					if (!isVideoFile(entry.name)) {
						continue;
					}

					const relativePath = relative(rootPath, fullPath);
					if (this.shouldExcludeFile(entry.name, relativePath, customPatterns, blockedExtensions)) {
						continue;
					}

					try {
						const stats = await stat(fullPath);

						if (
							stats.size < DOWNLOAD.MIN_SCAN_SIZE_BYTES &&
							!entry.name.toLowerCase().endsWith('.strm')
						) {
							continue;
						}

						files.push({
							path: fullPath,
							relativePath,
							size: stats.size,
							modifiedAt: stats.mtime,
							parentFolder: dirname(relativePath) || '.'
						});
					} catch (statError) {
						logger.warn(
							{
								fullPath,
								error: statError instanceof Error ? statError.message : String(statError)
							},
							'[DiskScan] Could not stat file'
						);
					}
				} else if (entry.isSymbolicLink()) {
					if (!isVideoFile(entry.name)) {
						continue;
					}

					const relativePath = relative(rootPath, fullPath);
					if (this.shouldExcludeFile(entry.name, relativePath, customPatterns, blockedExtensions)) {
						continue;
					}

					try {
						const stats = await stat(fullPath);
						if (!stats.isFile()) {
							continue;
						}

						if (
							stats.size < DOWNLOAD.MIN_SCAN_SIZE_BYTES &&
							!entry.name.toLowerCase().endsWith('.strm')
						) {
							continue;
						}

						files.push({
							path: fullPath,
							relativePath,
							size: stats.size,
							modifiedAt: stats.mtime,
							parentFolder: dirname(relativePath) || '.'
						});
					} catch (statError) {
						logger.warn(
							{
								fullPath,
								error: statError instanceof Error ? statError.message : String(statError)
							},
							'[DiskScan] Could not stat symlinked file'
						);
					}
				}
			}
		} catch (error) {
			logger.error(
				{ err: error instanceof Error ? error : undefined, ...{ currentPath } },
				'[DiskScan] Error reading directory'
			);
		}

		return files;
	}

	async scanRootFolder(rootFolderId: string): Promise<ScanResult> {
		if (this.isScanning) {
			throw new Error('A scan is already in progress');
		}

		if (libraryOperationLock.isLocked) {
			throw new Error(
				`Scan deferred: a rename/reorganize operation (${libraryOperationLock.holder}) is in progress`
			);
		}

		const startTime = Date.now();
		this.isScanning = true;
		this.scanAborted = false;

		const [rootFolder] = await db
			.select()
			.from(rootFolders)
			.where(eq(rootFolders.id, rootFolderId));

		if (!rootFolder) {
			this.isScanning = false;
			throw new Error(`Root folder not found: ${rootFolderId}`);
		}

		const [scanRecord] = await db
			.insert(libraryScanHistory)
			.values({
				scanType: 'folder',
				rootFolderId,
				status: 'running'
			})
			.returning();

		this.currentScanId = scanRecord.id;

		const progress: ScanProgress = {
			phase: 'scanning',
			rootFolderId,
			rootFolderPath: rootFolder.path,
			filesFound: 0,
			filesProcessed: 0,
			filesAdded: 0,
			filesUpdated: 0,
			filesRemoved: 0,
			unmatchedCount: 0
		};

		try {
			this.emit('progress', progress);
			await this.assertNoRootFolderOverlap(rootFolderId, rootFolder.path);

			const customPatterns = rootFolder.skipFolderPatterns
				? (JSON.parse(rootFolder.skipFolderPatterns) as string[])
				: [];
			let blockedExtensions: string[];
			if (rootFolder.blockedVideoExtensions) {
				blockedExtensions = JSON.parse(rootFolder.blockedVideoExtensions) as string[];
			} else {
				const { getBlockedVideoExtensions } =
					await import('#lib/server/settings/blocked-extensions.js');
				const global = await getBlockedVideoExtensions();
				blockedExtensions = global.extensions;
			}

			const existingFiles = await this.getExistingFiles(rootFolderId, rootFolder.mediaType);
			const transitions = await this.getRecentRenameTransitions();
			const scanner = new StreamingDiskScanner({
				batchSize: 500,
				customExcludedFolders: customPatterns,
				blockedExtensions,
				alwaysScanPaths: [
					...[...existingFiles.values()]
						.filter((file) => file.source === 'tracked')
						.map((file) => file.path),
					...transitions.values()
				]
			});

			let filesFound = 0;
			const seenPaths = new Set<string>();
			// New on-disk files (not tracked in existingFiles by construction) that
			// may be the relocated copy of a missing tracked file whose folder was
			// renamed outside Cinephage. Auto-linked files are subtracted before
			// external-rename correlation because they already own a tracked row.
			const newDiskFiles: Array<{ path: string; size: number }> = [];
			const autoLinkedPaths = new Set<string>();
			// Unmatched insertions are deferred until after the removal loop: a
			// pending file may turn out to be the heal target of an
			// externally-renamed tracked row, in which case inserting an
			// unmatchedFiles row would duplicate it.
			const pendingUnmatched: DiscoveredFile[] = [];

			for await (const batch of scanner.scan(rootFolder.path)) {
				let fileIndex = 0;
				for (const file of batch) {
					progress.currentFile = file.relativePath;

					seenPaths.add(file.path);
					const existingFile = existingFiles.get(file.path);

					if (!existingFile) {
						newDiskFiles.push({ path: file.path, size: file.size });

						let wasLinked = false;

						if (rootFolder.mediaType === 'tv') {
							wasLinked = await this.tryAutoLinkTvFile(file, rootFolderId, rootFolder.path);
						}

						if (wasLinked) {
							autoLinkedPaths.add(file.path);
						} else {
							pendingUnmatched.push(file);
						}

						progress.filesAdded++;
					} else if (existingFile.size !== file.size) {
						await this.updateFileMediaInfo(
							existingFile.id,
							file,
							rootFolder.mediaType,
							existingFile.allowStrmProbe
						);
						progress.filesUpdated++;
					}

					filesFound++;
					progress.filesProcessed = filesFound;

					// Yield every 10 files so HTTP requests (health checks, API calls)
					// can be served even during large initial scans on slow filesystems.
					// Without this, 500 synchronous SQLite inserts run as microtasks and
					// starve the event loop on ZFS/NFS mounts for 10+ seconds.
					if (++fileIndex % 10 === 0) {
						await new Promise<void>((resolve) => setImmediate(resolve));
					}
				}

				progress.filesFound = filesFound;
				progress.phase = 'processing';
				this.emit('progress', progress);

				if (this.scanAborted) {
					throw new Error('Scan was cancelled');
				}

				await new Promise<void>((resolve) => setImmediate(resolve));
			}

			progress.filesFound = filesFound;
			this.emit('progress', progress);

			// Data-safety guard: a scan that saw zero files while the database
			// still tracks files for this folder almost always means the folder
			// was unreadable or unmounted mid-scan, not that the user deleted
			// their library. Refuse to wipe records on an empty result.
			if (filesFound === 0 && existingFiles.size > 0) {
				throw new Error(
					`Root folder ${rootFolder.path} scanned as empty but ${existingFiles.size} tracked file(s) exist; refusing to remove records. Verify the folder is mounted and readable, then rescan.`
				);
			}

			// External-rename correlation: match missing tracked rows against
			// newly-seen files that share basename+size and did not auto-link.
			// Candidates never include already-tracked paths because newDiskFiles
			// only collects files that were absent from existingFiles.
			const missingFiles = [...existingFiles.values()].filter((file) => !seenPaths.has(file.path));
			const externalCandidates = newDiskFiles.filter((file) => !autoLinkedPaths.has(file.path));
			const externalMatches = findExternalRenameMatches(missingFiles, externalCandidates);
			// New paths claimed by any heal must not also get an unmatchedFiles row.
			const claimedHealTargets = new Set<string>(externalMatches.values());

			for (const [path, existingFile] of existingFiles) {
				if (seenPaths.has(path)) continue;

				const healTarget = findRenameHealTarget(path, transitions, seenPaths);
				if (healTarget) {
					try {
						const healResult = await this.healRenamedFile(
							existingFile,
							healTarget,
							rootFolder.path,
							rootFolder.mediaType
						);
						if (healResult === 'healed') {
							progress.filesUpdated++;
							claimedHealTargets.add(healTarget);
							logger.info(
								{ from: path, to: healTarget, fileId: existingFile.id },
								'[DiskScan] Healed renamed file row instead of delete+recreate'
							);
						}
						continue;
					} catch (healError) {
						logger.warn(
							{ err: healError, from: path, to: healTarget, fileId: existingFile.id },
							'[DiskScan] Rename heal failed; falling back to row removal'
						);
					}
				}

				const externalTarget = externalMatches.get(path);
				if (externalTarget) {
					try {
						const healResult = await this.healRenamedFile(
							existingFile,
							externalTarget,
							rootFolder.path,
							rootFolder.mediaType
						);
						if (healResult === 'healed') {
							progress.filesUpdated++;
							logger.info(
								{ from: path, to: externalTarget, fileId: existingFile.id },
								'[DiskScan] Healed externally-renamed file row (no rename_history entry)'
							);
							continue;
						}
					} catch (healError) {
						logger.warn(
							{ err: healError, from: path, to: externalTarget, fileId: existingFile.id },
							'[DiskScan] External rename heal failed; falling back to row removal'
						);
					}
				}

				logger.warn(
					{ path, fileId: existingFile.id, mediaType: rootFolder.mediaType },
					'[DiskScan] Removing missing file row after rename healing found no target'
				);
				await this.removeFile(existingFile.id, rootFolder.mediaType);
				progress.filesRemoved++;
			}

			// Insert unmatched rows for new files that neither auto-linked nor
			// served as a heal target.
			for (const file of pendingUnmatched) {
				if (claimedHealTargets.has(file.path)) continue;
				await this.addUnmatchedFile(file, rootFolderId, rootFolder.mediaType);
				progress.unmatchedCount++;
			}

			if (this.shouldCancel && (await this.shouldCancel())) {
				throw new Error('Scan cancelled by job controller');
			}

			if (rootFolder.mediaType === 'tv') {
				await this.retryUnmatchedTvFiles(rootFolderId, rootFolder.path);
			}

			await this.reconcileMediaPresence(rootFolderId, rootFolder.mediaType);

			await db
				.update(libraryScanHistory)
				.set({
					status: 'completed',
					completedAt: new Date().toISOString(),
					filesScanned: progress.filesFound,
					filesAdded: progress.filesAdded,
					filesUpdated: progress.filesUpdated,
					filesRemoved: progress.filesRemoved,
					unmatchedFiles: progress.unmatchedCount
				})
				.where(eq(libraryScanHistory.id, scanRecord.id));

			progress.phase = 'complete';
			this.emit('progress', progress);

			return {
				success: true,
				scanId: scanRecord.id,
				rootFolderId,
				rootFolderPath: rootFolder.path,
				filesScanned: progress.filesFound,
				filesAdded: progress.filesAdded,
				filesUpdated: progress.filesUpdated,
				filesRemoved: progress.filesRemoved,
				unmatchedFiles: progress.unmatchedCount,
				duration: Date.now() - startTime
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';

			await db
				.update(libraryScanHistory)
				.set({
					status: 'failed',
					completedAt: new Date().toISOString(),
					errorMessage
				})
				.where(eq(libraryScanHistory.id, scanRecord.id));

			progress.phase = 'complete';
			progress.error = errorMessage;
			this.emit('progress', progress);

			return {
				success: false,
				scanId: scanRecord.id,
				rootFolderId,
				rootFolderPath: rootFolder.path,
				filesScanned: progress.filesFound,
				filesAdded: progress.filesAdded,
				filesUpdated: progress.filesUpdated,
				filesRemoved: progress.filesRemoved,
				unmatchedFiles: progress.unmatchedCount,
				duration: Date.now() - startTime,
				error: errorMessage
			};
		} finally {
			this.isScanning = false;
			this.currentScanId = null;
		}
	}

	private chunkArray<T>(values: T[], chunkSize = DB_CHUNK_SIZE): T[][] {
		if (values.length === 0) return [];
		const chunks: T[][] = [];
		for (let i = 0; i < values.length; i += chunkSize) {
			chunks.push(values.slice(i, i + chunkSize));
		}
		return chunks;
	}

	private async assertNoRootFolderOverlap(
		rootFolderId: string,
		rootFolderPath: string
	): Promise<void> {
		const existingFolders = await db
			.select({
				id: rootFolders.id,
				path: rootFolders.path,
				name: rootFolders.name
			})
			.from(rootFolders);
		const overlap = await findOverlappingRootFolder(rootFolderPath, existingFolders, rootFolderId);
		if (overlap) {
			throw new Error(getRootFolderOverlapMessage(rootFolderPath, overlap));
		}
	}

	private async reconcileMediaPresence(rootFolderId: string, mediaType: string): Promise<void> {
		if (mediaType === 'movie') {
			await this.reconcileMoviePresence(rootFolderId);
			return;
		}

		if (mediaType === 'tv') {
			await this.repairOrphanedEpisodeFiles(rootFolderId);
			await this.reconcileEpisodePresence(rootFolderId);
		}
	}

	/**
	 * Finds episodeFiles whose episodeIds contain UUIDs that no longer exist
	 * (e.g. after a series refresh wipes and recreates episode rows) and
	 * re-resolves them from the filename so the file appears linked again.
	 */
	private async repairOrphanedEpisodeFiles(rootFolderId: string): Promise<void> {
		const seriesInFolder = await db
			.select({ id: series.id, path: series.path, seriesType: series.seriesType })
			.from(series)
			.where(eq(series.rootFolderId, rootFolderId));

		if (seriesInFolder.length === 0) return;

		const seriesIds = seriesInFolder.map((s) => s.id);

		// Build a set of all valid episode UUIDs and a lookup by (seriesId, season, episode).
		const currentEpisodeRows: Array<{
			id: string;
			seriesId: string;
			seasonNumber: number;
			episodeNumber: number;
			absoluteEpisodeNumber: number | null;
			airDate: string | null;
		}> = [];
		for (const chunk of this.chunkArray(seriesIds)) {
			const rows = await db
				.select({
					id: episodes.id,
					seriesId: episodes.seriesId,
					seasonNumber: episodes.seasonNumber,
					episodeNumber: episodes.episodeNumber,
					absoluteEpisodeNumber: episodes.absoluteEpisodeNumber,
					airDate: episodes.airDate
				})
				.from(episodes)
				.where(inArray(episodes.seriesId, chunk));
			currentEpisodeRows.push(...rows);
		}

		const validEpisodeIds = new Set(currentEpisodeRows.map((e) => e.id));

		const allEpisodeFiles: Array<{
			id: string;
			seriesId: string;
			seasonNumber: number;
			relativePath: string;
			episodeIds: string[] | null;
		}> = [];
		for (const chunk of this.chunkArray(seriesIds)) {
			const rows = await db
				.select({
					id: episodeFiles.id,
					seriesId: episodeFiles.seriesId,
					seasonNumber: episodeFiles.seasonNumber,
					relativePath: episodeFiles.relativePath,
					episodeIds: episodeFiles.episodeIds
				})
				.from(episodeFiles)
				.where(inArray(episodeFiles.seriesId, chunk));
			allEpisodeFiles.push(...rows);
		}

		// Identify files where any episodeId is no longer valid.
		const orphaned = allEpisodeFiles.filter((ef) => {
			const ids = ef.episodeIds ?? [];
			return ids.length === 0 || ids.some((id) => !validEpisodeIds.has(id));
		});

		if (orphaned.length === 0) return;

		// For each orphaned file, re-resolve episode mapping from the filename
		// (same logic as tryAutoLinkTvFile) and update episodeIds.
		const seriesEpisodesCache = new Map<string, typeof currentEpisodeRows>();
		for (const s of seriesInFolder) {
			seriesEpisodesCache.set(
				s.id,
				currentEpisodeRows.filter((e) => e.seriesId === s.id)
			);
		}

		let repaired = 0;
		for (const ef of orphaned) {
			const s = seriesInFolder.find((x) => x.id === ef.seriesId);
			if (!s) continue;

			const fileName = getMediaParseStem(ef.relativePath);
			const parsed = this.parser.parse(fileName);
			const identifier = resolveTvEpisodeIdentifier({
				filePath: ef.relativePath,
				parsed,
				seriesType: s.seriesType === 'anime' || s.seriesType === 'daily' ? s.seriesType : 'standard'
			});

			if (!identifier) continue;

			const seriesEps = seriesEpisodesCache.get(s.id) ?? [];
			const matched = matchEpisodesByIdentifier(seriesEps, identifier);
			const newIds = matched.map((e) => e.id);

			if (newIds.length === 0) continue;

			await db.update(episodeFiles).set({ episodeIds: newIds }).where(eq(episodeFiles.id, ef.id));
			repaired++;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		if (repaired > 0) {
			logger.info({ rootFolderId, repaired }, '[DiskScan] Re-linked orphaned episode file records');
		}
	}

	private async reconcileMoviePresence(rootFolderId: string): Promise<void> {
		const moviesInFolder = await db
			.select({ id: movies.id, hasFile: movies.hasFile })
			.from(movies)
			.where(eq(movies.rootFolderId, rootFolderId));

		if (moviesInFolder.length === 0) {
			return;
		}

		const movieIds = moviesInFolder.map((movie) => movie.id);
		const moviesWithFiles = new Set<string>();

		for (const idChunk of this.chunkArray(movieIds)) {
			const fileRows = await db
				.select({ movieId: movieFiles.movieId })
				.from(movieFiles)
				.where(inArray(movieFiles.movieId, idChunk));

			for (const row of fileRows) {
				moviesWithFiles.add(row.movieId);
			}
		}

		const gained: string[] = [];
		const lost: string[] = [];
		const changedMovieIds: string[] = [];

		for (const movie of moviesInFolder) {
			const shouldHaveFile = moviesWithFiles.has(movie.id);
			const currentlyHasFile = movie.hasFile ?? false;
			if (shouldHaveFile === currentlyHasFile) continue;
			changedMovieIds.push(movie.id);
			if (shouldHaveFile) gained.push(movie.id);
			else lost.push(movie.id);
		}

		for (const chunk of this.chunkArray(gained)) {
			await db.transaction((tx) => {
				tx.update(movies).set({ hasFile: true }).where(inArray(movies.id, chunk)).run();
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		for (const chunk of this.chunkArray(lost)) {
			await db.transaction((tx) => {
				tx.update(movies)
					.set({ hasFile: false, lastSearchTime: null })
					.where(inArray(movies.id, chunk))
					.run();
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		if (changedMovieIds.length > 0) {
			logger.info(
				{
					rootFolderId,
					changedMovies: changedMovieIds.length
				},
				'[DiskScan] Reconciled movie file state'
			);

			for (const movieId of changedMovieIds) {
				libraryMediaEvents.emitMovieUpdated(movieId);
			}
		}
	}

	private async reconcileEpisodePresence(rootFolderId: string): Promise<void> {
		const seriesInFolder = await db
			.select({ id: series.id })
			.from(series)
			.where(eq(series.rootFolderId, rootFolderId));

		if (seriesInFolder.length === 0) {
			return;
		}

		const seriesIds = seriesInFolder.map((show) => show.id);
		const episodesInFolder: Array<{ id: string; seriesId: string; hasFile: boolean | null }> = [];

		for (const seriesChunk of this.chunkArray(seriesIds)) {
			const rows = await db
				.select({
					id: episodes.id,
					seriesId: episodes.seriesId,
					hasFile: episodes.hasFile
				})
				.from(episodes)
				.where(inArray(episodes.seriesId, seriesChunk));
			episodesInFolder.push(...rows);
		}

		const episodeIdsWithFiles = new Set<string>();
		for (const seriesChunk of this.chunkArray(seriesIds)) {
			const fileRows = await db
				.select({ episodeIds: episodeFiles.episodeIds })
				.from(episodeFiles)
				.where(inArray(episodeFiles.seriesId, seriesChunk));

			for (const file of fileRows) {
				const ids = file.episodeIds as string[] | null;
				for (const episodeId of ids ?? []) {
					episodeIdsWithFiles.add(episodeId);
				}
			}
		}

		const episodeIdsToSetTrue: string[] = [];
		const episodeIdsToSetFalse: string[] = [];
		const touchedSeriesIds = new Set<string>();

		for (const episode of episodesInFolder) {
			const shouldHaveFile = episodeIdsWithFiles.has(episode.id);
			const currentlyHasFile = episode.hasFile ?? false;

			if (shouldHaveFile && !currentlyHasFile) {
				episodeIdsToSetTrue.push(episode.id);
				touchedSeriesIds.add(episode.seriesId);
			} else if (!shouldHaveFile && currentlyHasFile) {
				episodeIdsToSetFalse.push(episode.id);
				touchedSeriesIds.add(episode.seriesId);
			}
		}

		for (const idChunk of this.chunkArray(episodeIdsToSetTrue)) {
			await db.transaction((tx) => {
				tx.update(episodes).set({ hasFile: true }).where(inArray(episodes.id, idChunk)).run();
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		for (const idChunk of this.chunkArray(episodeIdsToSetFalse)) {
			await db.transaction((tx) => {
				tx.update(episodes)
					.set({ hasFile: false, lastSearchTime: null })
					.where(inArray(episodes.id, idChunk))
					.run();
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		for (const seriesId of seriesIds) {
			await this.updateSeriesAndSeasonStats(seriesId);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		if (episodeIdsToSetTrue.length > 0 || episodeIdsToSetFalse.length > 0) {
			logger.info(
				{
					rootFolderId,
					episodesSetTrue: episodeIdsToSetTrue.length,
					episodesSetFalse: episodeIdsToSetFalse.length
				},
				'[DiskScan] Reconciled episode file state'
			);
		}

		for (const seriesId of touchedSeriesIds) {
			libraryMediaEvents.emitSeriesUpdated(seriesId);
		}
	}

	async scanAll(): Promise<ScanResult[]> {
		const allRootFolders = await db.select().from(rootFolders);
		const results: ScanResult[] = [];

		for (const folder of allRootFolders) {
			try {
				const result = await this.scanRootFolder(folder.id);
				results.push(result);
			} catch (error) {
				logger.error(
					{ err: error instanceof Error ? error : undefined, ...{ folderPath: folder.path } },
					'[DiskScan] Error scanning folder'
				);
			}
		}

		return results;
	}

	/**
	 * Re-attempt linking unmatched TV files that fall under a known series directory.
	 * Files are added to unmatchedFiles when no series exists for them at scan time.
	 * When a series is later added (or re-added), subsequent scans skip those files
	 * because they are already in the existingFiles map. This method runs after the
	 * main scan walk to give those files a second chance at being linked.
	 */
	private async retryUnmatchedTvFiles(rootFolderId: string, rootFolderPath: string): Promise<void> {
		const seriesInFolder = await db
			.select({ id: series.id, path: series.path })
			.from(series)
			.where(eq(series.rootFolderId, rootFolderId));

		if (seriesInFolder.length === 0) return;

		const unmatched = await db
			.select({ id: unmatchedFiles.id, path: unmatchedFiles.path, size: unmatchedFiles.size })
			.from(unmatchedFiles)
			.where(eq(unmatchedFiles.rootFolderId, rootFolderId));

		let linked = 0;
		for (const uf of unmatched) {
			const underSeries = seriesInFolder.some((s) => {
				const seriesDir = join(rootFolderPath, s.path);
				return uf.path.startsWith(seriesDir + '/') || uf.path.startsWith(seriesDir + '\\');
			});
			if (!underSeries) continue;

			const relPath = relative(rootFolderPath, uf.path);
			const file: DiscoveredFile = {
				path: uf.path,
				relativePath: relPath,
				size: uf.size ?? 0,
				modifiedAt: new Date(),
				parentFolder: dirname(uf.path)
			};
			const wasLinked = await this.tryAutoLinkTvFile(file, rootFolderId, rootFolderPath);
			if (wasLinked) {
				await db.delete(unmatchedFiles).where(eq(unmatchedFiles.id, uf.id));
				linked++;
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		if (linked > 0) {
			logger.info({ rootFolderId, linked }, '[DiskScan] Re-linked previously unmatched TV files');
		}
	}

	private async getExistingFiles(
		rootFolderId: string,
		mediaType: string
	): Promise<
		Map<
			string,
			{
				id: string;
				path: string;
				size: number | null;
				allowStrmProbe: boolean;
				source: 'tracked' | 'unmatched';
			}
		>
	> {
		const existingMap = new Map<
			string,
			{
				id: string;
				path: string;
				size: number | null;
				allowStrmProbe: boolean;
				source: 'tracked' | 'unmatched';
			}
		>();

		if (mediaType === 'movie') {
			const moviesInFolder = await db
				.select({ id: movies.id, path: movies.path, scoringProfileId: movies.scoringProfileId })
				.from(movies)
				.where(eq(movies.rootFolderId, rootFolderId));

			const movieIds = moviesInFolder.map((m) => m.id);
			if (movieIds.length > 0) {
				const files = await db
					.select({
						id: movieFiles.id,
						movieId: movieFiles.movieId,
						relativePath: movieFiles.relativePath,
						size: movieFiles.size
					})
					.from(movieFiles)
					.where(inArray(movieFiles.movieId, movieIds));

				const [folder] = await db
					.select({ path: rootFolders.path })
					.from(rootFolders)
					.where(eq(rootFolders.id, rootFolderId));

				if (folder) {
					for (const file of files) {
						const movie = moviesInFolder.find((m) => m.id === file.movieId);
						if (movie) {
							const fullPath = join(folder.path, movie.path, file.relativePath);
							existingMap.set(fullPath, {
								id: file.id,
								path: fullPath,
								size: file.size,
								allowStrmProbe: movie.scoringProfileId !== 'streamer',
								source: 'tracked'
							});
						}
					}
				}
			}
		} else {
			const seriesInFolder = await db
				.select({ id: series.id, path: series.path, scoringProfileId: series.scoringProfileId })
				.from(series)
				.where(eq(series.rootFolderId, rootFolderId));

			const seriesIds = seriesInFolder.map((s) => s.id);
			if (seriesIds.length > 0) {
				const files = await db
					.select({
						id: episodeFiles.id,
						seriesId: episodeFiles.seriesId,
						relativePath: episodeFiles.relativePath,
						size: episodeFiles.size
					})
					.from(episodeFiles)
					.where(inArray(episodeFiles.seriesId, seriesIds));

				const [folder] = await db
					.select({ path: rootFolders.path })
					.from(rootFolders)
					.where(eq(rootFolders.id, rootFolderId));

				if (folder) {
					for (const file of files) {
						const seriesItem = seriesInFolder.find((s) => s.id === file.seriesId);
						if (seriesItem) {
							const fullPath = join(folder.path, seriesItem.path, file.relativePath);
							existingMap.set(fullPath, {
								id: file.id,
								path: fullPath,
								size: file.size,
								allowStrmProbe: seriesItem.scoringProfileId !== 'streamer',
								source: 'tracked'
							});
						}
					}
				}
			}
		}

		const unmatched = await db
			.select({ id: unmatchedFiles.id, path: unmatchedFiles.path, size: unmatchedFiles.size })
			.from(unmatchedFiles)
			.where(eq(unmatchedFiles.rootFolderId, rootFolderId));

		for (const file of unmatched) {
			existingMap.set(file.path, {
				id: file.id,
				path: file.path,
				size: file.size,
				allowStrmProbe: true,
				source: 'unmatched'
			});
		}

		return existingMap;
	}

	private async tryAutoLinkTvFile(
		file: DiscoveredFile,
		rootFolderId: string,
		rootFolderPath: string
	): Promise<boolean> {
		const seriesInFolder = await db
			.select({
				id: series.id,
				path: series.path,
				title: series.title,
				seasonFolder: series.seasonFolder,
				seriesType: series.seriesType
			})
			.from(series)
			.where(eq(series.rootFolderId, rootFolderId));

		for (const s of seriesInFolder) {
			const seriesFullPath = join(rootFolderPath, s.path);

			if (file.path.startsWith(seriesFullPath + '/')) {
				const relativePath = relative(seriesFullPath, file.path);
				const fileName = getMediaParseStem(file.path);
				const parsed = this.parser.parse(fileName);
				const identifier = resolveTvEpisodeIdentifier({
					filePath: file.path,
					parsed,
					seriesType:
						s.seriesType === 'anime' || s.seriesType === 'daily' ? s.seriesType : 'standard'
				});

				const existingFile = await db
					.select()
					.from(episodeFiles)
					.where(and(eq(episodeFiles.seriesId, s.id), eq(episodeFiles.relativePath, relativePath)))
					.limit(1);

				if (existingFile.length > 0) {
					logger.debug({ relativePath }, '[DiskScan] File already linked');
					return true;
				}

				const seriesEpisodes = await db.select().from(episodes).where(eq(episodes.seriesId, s.id));

				let matchingEpisodes: (typeof episodes.$inferSelect)[];
				let titleMatch: SpecialEpisodeTitleMatch<typeof episodes.$inferSelect> | null = null;

				if (identifier) {
					matchingEpisodes = matchEpisodesByIdentifier(seriesEpisodes, identifier);
				} else {
					// Sonarr-style fallback: title-only files ("Razor (2007).mp4")
					// match season 0 specials by contained episode title. The
					// series folder itself is not a candidate — a special sharing
					// the series title would self-match.
					const parentFolder = basename(dirname(file.path));
					const candidates =
						parentFolder !== basename(seriesFullPath) ? [fileName, parentFolder] : [fileName];
					titleMatch = matchSpecialEpisodeByTitle(seriesEpisodes, candidates, parsed.year, s.title);
					matchingEpisodes = titleMatch ? [titleMatch.episode] : [];
				}

				const episodeIds = matchingEpisodes.map((ep) => ep.id);
				const seasonNum = matchingEpisodes[0]?.seasonNumber;
				const episodeNums = matchingEpisodes.map((ep) => ep.episodeNumber);

				if (episodeIds.length === 0 || seasonNum === undefined) {
					if (!identifier) {
						logger.debug(
							{ fileName },
							'[DiskScan] Could not resolve episode mapping from filename'
						);
					} else {
						logger.debug(
							{
								fileName,
								identifier,
								seriesId: s.id
							},
							'[DiskScan] No matching episodes in DB for file'
						);
					}
					return false;
				}

				const quality = {
					resolution: parsed.resolution ?? undefined,
					source: parsed.source ?? undefined,
					codec: parsed.codec ?? undefined,
					hdr: parsed.hdr ?? undefined
				};

				await db.transaction((tx) => {
					tx.insert(episodeFiles)
						.values({
							seriesId: s.id,
							seasonNumber: seasonNum,
							episodeIds,
							relativePath,
							size: file.size,
							dateAdded: new Date().toISOString(),
							releaseGroup: parsed.releaseGroup ?? undefined,
							releaseType: episodeNums.length > 1 ? 'multiEpisode' : 'singleEpisode',
							quality
						})
						.onConflictDoNothing()
						.run();

					for (const epId of episodeIds) {
						tx.update(episodes).set({ hasFile: true }).where(eq(episodes.id, epId)).run();
					}
				});

				await this.updateSeriesAndSeasonStats(s.id);

				if (titleMatch) {
					logger.info(
						{
							relativePath,
							season: seasonNum,
							episodes: episodeNums,
							method: titleMatch.method,
							position: titleMatch.position,
							coverage: titleMatch.coverage,
							candidate: titleMatch.candidate
						},
						'[DiskScan] Auto-linked special by title'
					);
				} else {
					logger.info(
						{
							relativePath,
							season: seasonNum,
							episodes: episodeNums
						},
						'[DiskScan] Auto-linked episode file'
					);
				}
				return true;
			}
		}

		return false;
	}

	private async updateSeriesAndSeasonStats(seriesId: string): Promise<void> {
		const allEpisodes = await db.select().from(episodes).where(eq(episodes.seriesId, seriesId));

		const [seriesData] = await db
			.select({ monitorSpecials: series.monitorSpecials })
			.from(series)
			.where(eq(series.id, seriesId));
		const monitorSpecials = seriesData?.monitorSpecials ?? false;

		const today = todayDateString();
		const isAired = (episode: typeof episodes.$inferSelect) =>
			episode.airDate && episode.airDate !== '' && episode.airDate <= today;

		const episodesForStats = allEpisodes.filter(
			(episode) => isAired(episode) && (monitorSpecials || episode.seasonNumber !== 0)
		);
		const episodesWithFiles = episodesForStats.filter((episode) => episode.hasFile);

		const seasonMap = new Map<number, { total: number; withFiles: number }>();
		for (const episode of allEpisodes) {
			if (!isAired(episode)) continue;
			const stats = seasonMap.get(episode.seasonNumber) || { total: 0, withFiles: 0 };
			stats.total++;
			if (episode.hasFile) stats.withFiles++;
			seasonMap.set(episode.seasonNumber, stats);
		}

		await db.transaction((tx) => {
			tx.update(series)
				.set({
					episodeFileCount: episodesWithFiles.length,
					episodeCount: episodesForStats.length
				})
				.where(eq(series.id, seriesId))
				.run();

			for (const [seasonNumber, stats] of seasonMap) {
				tx.update(seasons)
					.set({
						episodeFileCount: stats.withFiles,
						episodeCount: stats.total
					})
					.where(and(eq(seasons.seriesId, seriesId), eq(seasons.seasonNumber, seasonNumber)))
					.run();
			}
		});
	}

	private async addUnmatchedFile(
		file: DiscoveredFile,
		rootFolderId: string,
		mediaType: string
	): Promise<void> {
		const fileName = getMediaParseStem(file.path);
		const parsed = this.parser.parse(fileName);
		const identifier = resolveTvEpisodeIdentifier({
			filePath: file.path,
			parsed
		});

		await db.insert(unmatchedFiles).values({
			path: file.path,
			rootFolderId,
			mediaType,
			size: file.size,
			parsedTitle: parsed.cleanTitle || null,
			parsedYear: parsed.year || null,
			parsedSeason: identifier?.numbering === 'standard' ? identifier.seasonNumber : null,
			parsedEpisode:
				identifier?.numbering === 'standard'
					? identifier.episodeNumbers[0]
					: identifier?.numbering === 'absolute'
						? identifier.absoluteEpisode
						: null,
			reason: 'no_match'
		});
	}

	private async updateFileMediaInfo(
		fileId: string,
		file: DiscoveredFile,
		mediaType: string,
		allowStrmProbe = true
	): Promise<void> {
		const mediaInfo = await mediaInfoService.extractMediaInfo(file.path, { allowStrmProbe });

		if (mediaType === 'movie') {
			await db
				.update(movieFiles)
				.set({
					size: file.size,
					mediaInfo
				})
				.where(eq(movieFiles.id, fileId));
			const [row] = await db
				.select({ movieId: movieFiles.movieId })
				.from(movieFiles)
				.where(eq(movieFiles.id, fileId))
				.limit(1);
			if (row?.movieId) await recalculateMovieShortfall(row.movieId);
		} else {
			await db
				.update(episodeFiles)
				.set({
					size: file.size,
					mediaInfo
				})
				.where(eq(episodeFiles.id, fileId));
			const [row] = await db
				.select({ seriesId: episodeFiles.seriesId })
				.from(episodeFiles)
				.where(eq(episodeFiles.id, fileId))
				.limit(1);
			if (row?.seriesId) await recalculateSeriesShortfall(row.seriesId);
		}
	}

	/**
	 * Recent successful file/folder renames and reorganize moves (old full
	 * path → new full path), most recent winning on duplicates. Consumes the
	 * rename_history audit table written by executeRenames (operation
	 * 'rename') and reorganizeFolderLocked (operation 'reorganize').
	 */
	private async getRecentRenameTransitions(): Promise<Map<string, string>> {
		const cutoff = new Date(Date.now() - RENAME_TRANSITION_WINDOW_MS).toISOString();
		const rows = await db
			.select({
				oldPath: renameHistory.oldPath,
				newPath: renameHistory.newPath
			})
			.from(renameHistory)
			.where(
				and(
					eq(renameHistory.success, 1),
					inArray(renameHistory.operation, ['rename', 'reorganize']),
					gte(renameHistory.createdAt, cutoff)
				)
			)
			// Oldest first so the most recent rename wins when old paths collide.
			.orderBy(renameHistory.createdAt);

		const map = new Map<string, string>();
		for (const row of rows) {
			map.set(row.oldPath, row.newPath);
		}
		return map;
	}

	/**
	 * A tracked file row's path disappeared but a recent rename moved it to a
	 * path that now exists on disk: update the DB rows to the new location
	 * instead of delete+recreate, preserving mediaInfo, linkage, and stats.
	 *
	 * Returns 'healed' when the DB rows were updated, or 'skipped-stale' when
	 * nothing was healed (the row was already consistent or could not be
	 * resolved) — the caller leaves such rows alone so they self-heal on the
	 * next scan.
	 *
	 * Public (not private) so tests can exercise the healing logic directly
	 * without running a full scan.
	 */
	async healRenamedFile(
		existingFile: {
			id: string;
			path: string;
			size: number | null;
			allowStrmProbe: boolean;
			source: 'tracked' | 'unmatched';
		},
		newFullPath: string,
		rootFolderPath: string,
		mediaType: string
	): Promise<'healed' | 'skipped-stale'> {
		if (existingFile.source === 'unmatched') {
			await db
				.update(unmatchedFiles)
				.set({ path: newFullPath })
				.where(eq(unmatchedFiles.id, existingFile.id));
			return 'healed';
		}

		if (mediaType === 'movie') {
			const [row] = await db
				.select({ movieId: movieFiles.movieId, relativePath: movieFiles.relativePath })
				.from(movieFiles)
				.where(eq(movieFiles.id, existingFile.id));
			if (!row) return 'skipped-stale';
			const [movie] = await db
				.select({ path: movies.path })
				.from(movies)
				.where(eq(movies.id, row.movieId));
			if (!movie) return 'skipped-stale';

			// Staleness guard: the scan diff built existingFile.path once at scan
			// start. When several files of the same externally-renamed folder
			// heal, the first heal already updated the parent path (movies.path),
			// so exact reconstruction against the CURRENT parent would fail for
			// every later file and those rows would fall through to deletion.
			// A suffix check on the row's relativePath (posix separators, the
			// same format getExistingFiles uses to join paths) still confirms
			// this map entry belongs to this row while tolerating a parent that
			// moved since the map was built.
			if (!existingFile.path.endsWith(row.relativePath)) {
				return 'skipped-stale';
			}

			const { newParentRel, newRelative } = this.splitRenamedPath(
				newFullPath,
				rootFolderPath,
				row.relativePath
			);

			if (movie.path !== newParentRel) {
				await db.update(movies).set({ path: newParentRel }).where(eq(movies.id, row.movieId));
			}
			await db
				.update(movieFiles)
				.set({ relativePath: newRelative })
				.where(eq(movieFiles.id, existingFile.id));
			return 'healed';
		} else {
			const [row] = await db
				.select({ seriesId: episodeFiles.seriesId, relativePath: episodeFiles.relativePath })
				.from(episodeFiles)
				.where(eq(episodeFiles.id, existingFile.id));
			if (!row) return 'skipped-stale';
			const [seriesItem] = await db
				.select({ path: series.path })
				.from(series)
				.where(eq(series.id, row.seriesId));
			if (!seriesItem) return 'skipped-stale';

			// Staleness guard, relaxed to a suffix check for the same reason as
			// the movie branch above: after the first file of an
			// externally-renamed series folder heals and updates series.path,
			// later files of the same folder must still pass this guard so they
			// heal in the same scan instead of being deleted. splitRenamedPath
			// still keys off this row's old relativePath depth, which the
			// relaxation leaves untouched.
			if (!existingFile.path.endsWith(row.relativePath)) {
				return 'skipped-stale';
			}

			const { newParentRel, newRelative } = this.splitRenamedPath(
				newFullPath,
				rootFolderPath,
				row.relativePath
			);

			if (seriesItem.path !== newParentRel) {
				await db.update(series).set({ path: newParentRel }).where(eq(series.id, row.seriesId));
			}
			await db
				.update(episodeFiles)
				.set({ relativePath: newRelative })
				.where(eq(episodeFiles.id, existingFile.id));
			return 'healed';
		}
	}

	/**
	 * Split a renamed file's new full path into (parent path relative to the
	 * root folder, path relative to that parent), preserving the old relative
	 * path's segment depth so structure like season folders stays inside
	 * relativePath instead of leaking into the media folder path.
	 */
	private splitRenamedPath(
		newFullPath: string,
		rootFolderPath: string,
		oldRelativePath: string
	): { newParentRel: string; newRelative: string } {
		const segments = newFullPath.split(/[\\/]+/).filter(Boolean);
		const rootDepth = rootFolderPath.split(/[\\/]+/).filter(Boolean).length;
		const oldDepth = oldRelativePath.split(/[\\/]+/).filter(Boolean).length;

		const available = Math.max(segments.length - rootDepth, 1);
		const depth = Math.min(Math.max(oldDepth, 1), available);

		const newRelative = segments.slice(-depth).join('/');
		const newParentRel = segments.slice(rootDepth, segments.length - depth).join('/');

		return { newParentRel, newRelative };
	}

	private async removeFile(fileId: string, mediaType: string): Promise<void> {
		if (mediaType === 'movie') {
			await db.delete(movieFiles).where(eq(movieFiles.id, fileId));
		} else {
			await db.delete(episodeFiles).where(eq(episodeFiles.id, fileId));
		}

		await db.delete(unmatchedFiles).where(eq(unmatchedFiles.id, fileId));
	}
}

export const diskScanService = DiskScanService.getInstance();
