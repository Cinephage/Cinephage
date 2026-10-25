/**
 * Unmatched File Service
 *
 * Centralized service for managing unmatched files.
 * Handles CRUD operations, matching, and folder grouping.
 */

import { randomUUID } from 'node:crypto';
import { db } from '#lib/server/db/index.js';
import { unmatchedFiles, rootFolders } from '#lib/server/db/schema.js';
import { eq, and, sql, desc, asc } from 'drizzle-orm';
import { dirname, basename } from 'path';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'scans' as const });
import { mediaMatcherService } from './media-matcher.js';
import { parseRelease } from '#lib/server/indexers/parser/ReleaseParser.js';
import { getMediaParseStem } from './media-utils.js';
import { resolveTvEpisodeIdentifier } from './tv-episode-resolver.js';
import type {
	UnmatchedFile,
	UnmatchedFolder,
	UnmatchedFilters,
	PaginationState,
	MatchRequest,
	MatchResult,
	BatchMatchResult,
	ProcessResult,
	UnmatchedReason
} from '#lib/types/unmatched.js';

interface ListOptions {
	filters?: UnmatchedFilters;
	pagination?: { page: number; limit: number };
	sortBy?: 'discoveredAt' | 'path' | 'parsedTitle';
	sortOrder?: 'asc' | 'desc';
}

interface FolderGroupOptions {
	filters?: UnmatchedFilters;
	groupBy?: 'immediate' | 'show';
}

/**
 * UnmatchedFileService - Centralized service for unmatched file operations
 */
export class UnmatchedFileService {
	private static instance: UnmatchedFileService;

	private constructor() {}

	static getInstance(): UnmatchedFileService {
		if (!UnmatchedFileService.instance) {
			UnmatchedFileService.instance = new UnmatchedFileService();
		}
		return UnmatchedFileService.instance;
	}

	/**
	 * Get unmatched files with optional filtering and pagination
	 */
	async getUnmatchedFiles(options: ListOptions = {}): Promise<{
		files: UnmatchedFile[];
		pagination: PaginationState;
	}> {
		const { filters = {}, pagination, sortBy = 'discoveredAt', sortOrder = 'desc' } = options;

		// Build where conditions
		const whereConditions: (ReturnType<typeof eq> | ReturnType<typeof sql>)[] = [];

		if (filters.mediaType) {
			whereConditions.push(eq(unmatchedFiles.mediaType, filters.mediaType));
		}

		if (filters.search) {
			const searchTerm = `%${filters.search}%`;
			whereConditions.push(
				sql`${unmatchedFiles.path} LIKE ${searchTerm} OR ${unmatchedFiles.parsedTitle} LIKE ${searchTerm}`
			);
		}

		// Get total count for pagination
		const countQuery = db.select({ count: sql<number>`count(*)` }).from(unmatchedFiles);

		const countResult =
			whereConditions.length > 0
				? await countQuery.where(and(...whereConditions))
				: await countQuery;

		const total = countResult[0]?.count || 0;

		// Build main query dynamically
		const baseQuery = db
			.select({
				id: unmatchedFiles.id,
				path: unmatchedFiles.path,
				rootFolderId: unmatchedFiles.rootFolderId,
				rootFolderPath: rootFolders.path,
				mediaType: unmatchedFiles.mediaType,
				size: unmatchedFiles.size,
				parsedTitle: unmatchedFiles.parsedTitle,
				parsedYear: unmatchedFiles.parsedYear,
				parsedSeason: unmatchedFiles.parsedSeason,
				parsedEpisode: unmatchedFiles.parsedEpisode,
				suggestedMatches: unmatchedFiles.suggestedMatches,
				reason: unmatchedFiles.reason,
				discoveredAt: unmatchedFiles.discoveredAt
			})
			.from(unmatchedFiles)
			.leftJoin(rootFolders, eq(unmatchedFiles.rootFolderId, rootFolders.id));

		// Apply where, orderBy, limit, offset in chain
		const orderByColumn =
			sortBy === 'path'
				? unmatchedFiles.path
				: sortBy === 'parsedTitle'
					? unmatchedFiles.parsedTitle
					: unmatchedFiles.discoveredAt;

		const orderByClause = sortOrder === 'asc' ? asc(orderByColumn) : desc(orderByColumn);

		let files;
		if (whereConditions.length > 0) {
			if (pagination) {
				const offset = (pagination.page - 1) * pagination.limit;
				files = await baseQuery
					.where(and(...whereConditions))
					.orderBy(orderByClause)
					.limit(pagination.limit)
					.offset(offset);
			} else {
				files = await baseQuery.where(and(...whereConditions)).orderBy(orderByClause);
			}
		} else {
			if (pagination) {
				const offset = (pagination.page - 1) * pagination.limit;
				files = await baseQuery.orderBy(orderByClause).limit(pagination.limit).offset(offset);
			} else {
				files = await baseQuery.orderBy(orderByClause);
			}
		}

		return {
			files: files.map((f) => this.mapToUnmatchedFile(f)),
			pagination: {
				page: pagination?.page || 1,
				limit: pagination?.limit || total,
				total,
				totalPages: pagination ? Math.ceil(total / pagination.limit) : 1
			}
		};
	}

	/**
	 * Get unmatched files grouped by folders
	 */
	async getUnmatchedFolders(options: FolderGroupOptions = {}): Promise<UnmatchedFolder[]> {
		const { filters = {}, groupBy = 'immediate' } = options;

		const { files } = await this.getUnmatchedFiles({
			filters,
			sortBy: 'path',
			sortOrder: 'asc',
			pagination: { page: 1, limit: 10000 }
		});

		if (groupBy === 'show') {
			return this.groupByShowFolder(files);
		}

		return this.groupByImmediateFolder(files);
	}

	/**
	 * Get a single unmatched file by ID
	 */
	async getUnmatchedFileById(id: string): Promise<UnmatchedFile | null> {
		const [file] = await db
			.select({
				id: unmatchedFiles.id,
				path: unmatchedFiles.path,
				rootFolderId: unmatchedFiles.rootFolderId,
				rootFolderPath: rootFolders.path,
				mediaType: unmatchedFiles.mediaType,
				size: unmatchedFiles.size,
				parsedTitle: unmatchedFiles.parsedTitle,
				parsedYear: unmatchedFiles.parsedYear,
				parsedSeason: unmatchedFiles.parsedSeason,
				parsedEpisode: unmatchedFiles.parsedEpisode,
				suggestedMatches: unmatchedFiles.suggestedMatches,
				reason: unmatchedFiles.reason,
				discoveredAt: unmatchedFiles.discoveredAt,
				correlationId: unmatchedFiles.correlationId
			})
			.from(unmatchedFiles)
			.leftJoin(rootFolders, eq(unmatchedFiles.rootFolderId, rootFolders.id))
			.where(eq(unmatchedFiles.id, id));

		return file ? this.mapToUnmatchedFile(file) : null;
	}

	/**
	 * Delete unmatched file(s) - optionally delete from disk
	 */
	async deleteUnmatchedFiles(
		ids: string[],
		deleteFromDisk: boolean = false
	): Promise<{ deleted: number; errors: string[] }> {
		const errors: string[] = [];
		let deleted = 0;

		for (const id of ids) {
			try {
				const file = await this.getUnmatchedFileById(id);
				if (!file) {
					errors.push(`File not found: ${id}`);
					continue;
				}

				// Check if root folder is read-only
				if (deleteFromDisk && file.rootFolderId) {
					const [rootFolder] = await db
						.select({ readOnly: rootFolders.readOnly })
						.from(rootFolders)
						.where(eq(rootFolders.id, file.rootFolderId));

					if (rootFolder?.readOnly) {
						errors.push(`Cannot delete from read-only folder: ${file.path}`);
						continue;
					}
				}

				// Delete from disk if requested
				if (deleteFromDisk && file.path) {
					try {
						const { unlink } = await import('node:fs/promises');
						await unlink(file.path);
						logger.debug({ path: file.path }, '[UnmatchedFileService] Deleted file from disk');
					} catch (err) {
						logger.warn(
							{
								path: file.path,
								err
							},
							'[UnmatchedFileService] Could not delete file from disk'
						);
						errors.push(`Could not delete file from disk: ${file.path}`);
						continue;
					}
				}

				// Delete from database
				await db.delete(unmatchedFiles).where(eq(unmatchedFiles.id, id));
				deleted++;
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				logger.error({ id, err }, '[UnmatchedFileService] Error deleting file');
				errors.push(`Error deleting ${id}: ${errorMsg}`);
			}
		}

		return { deleted, errors };
	}

	/**
	 * Process (re-match) a single unmatched file
	 */
	async processUnmatchedFile(id: string): Promise<MatchResult> {
		try {
			const result = await mediaMatcherService.processUnmatchedFile(id);
			return result;
		} catch (err) {
			logger.error(
				{
					id,
					err
				},
				'[UnmatchedFileService] Error processing file'
			);
			return {
				fileId: id,
				filePath: '',
				matched: false,
				confidence: 0,
				reason: err instanceof Error ? err.message : 'Unknown error'
			};
		}
	}

	/**
	 * Process all unmatched files
	 */
	async processAllUnmatchedFiles(): Promise<ProcessResult> {
		const { files } = await this.getUnmatchedFiles();
		const results: MatchResult[] = [];

		for (const file of files) {
			const result = await this.processUnmatchedFile(file.id);
			results.push(result);

			// Small delay to avoid rate limiting
			await new Promise((resolve) => setTimeout(resolve, 250));
		}

		const matched = results.filter((r) => r.matched).length;
		const failed = results.filter((r) => !r.matched).length;

		return {
			success: true,
			processed: results.length,
			matched,
			failed,
			results
		};
	}

	/**
	 * Match files to TMDB entry
	 */
	async matchFiles(request: MatchRequest): Promise<BatchMatchResult> {
		const { fileIds, tmdbId, mediaType, season, episode, episodeMapping } = request;
		const errors: string[] = [];
		let matched = 0;
		let failed = 0;
		let mediaId: string | undefined;

		for (const fileId of fileIds) {
			try {
				const file = await this.getUnmatchedFileById(fileId);
				if (!file) {
					errors.push(`File not found: ${fileId}`);
					failed++;
					continue;
				}

				if (mediaType === 'movie') {
					const result = await this.matchMovieFile(file, tmdbId);
					if (result.success) {
						matched++;
						mediaId = result.mediaId;
					} else {
						errors.push(result.error || `Failed to match ${fileId}`);
						failed++;
					}
				} else {
					// TV show - determine season/episode
					let fileSeason = season;
					let fileEpisode: number | undefined;

					if (episodeMapping?.[fileId]) {
						fileSeason = episodeMapping[fileId].season;
						fileEpisode = episodeMapping[fileId].episode;
					} else {
						fileSeason = fileSeason ?? file.parsedSeason ?? undefined;
						fileEpisode = episode ?? file.parsedEpisode ?? undefined;

						// If episode still missing, re-parse the filename (handles absolute episode
						// numbering for files indexed before this was stored in parsedEpisode)
						if (fileEpisode === undefined) {
							const fileStem = getMediaParseStem(file.path);
							const parsed = parseRelease(fileStem);
							const tvId = resolveTvEpisodeIdentifier({
								filePath: file.path,
								parsed,
								seasonHint: fileSeason
							});
							if (tvId?.numbering === 'standard') {
								fileSeason = fileSeason ?? tvId.seasonNumber;
								fileEpisode = tvId.episodeNumbers[0];
							} else if (tvId?.numbering === 'absolute') {
								fileEpisode = tvId.absoluteEpisode;
							}
						}
					}

					if (fileSeason === undefined || fileEpisode === undefined) {
						const reason = `Could not determine ${fileSeason === undefined ? 'season' : 'episode'} for "${file.path}" - the filename could not be parsed and no value was provided`;
						logger.warn(
							{ fileId, filePath: file.path, fileSeason, fileEpisode },
							`[UnmatchedFileService] ${reason}`
						);
						errors.push(reason);
						failed++;
						continue;
					}

					const result = await this.matchEpisodeFile(file, tmdbId, fileSeason, fileEpisode);
					if (result.success) {
						matched++;
						mediaId = result.mediaId;
					} else {
						errors.push(result.error || `Failed to match ${fileId}`);
						failed++;
					}
				}
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				errors.push(`Error matching ${fileId}: ${errorMsg}`);
				failed++;
			}
		}

		return {
			success: matched > 0,
			matched,
			failed,
			errors,
			mediaId
		};
	}

	/**
	 * Match a single file as a movie
	 */
	private async matchMovieFile(
		file: UnmatchedFile,
		tmdbId: number
	): Promise<{ success: boolean; mediaId?: string; error?: string }> {
		const correlationId = file.correlationId ?? randomUUID();
		const matchLogger = createChildLogger({ logDomain: 'scans' as const, correlationId });
		try {
			matchLogger.info(
				{ fileId: file.id, filePath: file.path, tmdbId },
				'[UnmatchedFileService] Manual movie match started'
			);
			// Deliberate manual match: retire a displaced old file instead of
			// leaving a duplicate when the generated filename differs (#627).
			await mediaMatcherService.acceptMatch(file.id, tmdbId, 'movie', { allowReplace: true });
			matchLogger.info(
				{ fileId: file.id, tmdbId },
				'[UnmatchedFileService] Manual movie match successful'
			);
			return { success: true };
		} catch (err) {
			matchLogger.error(
				{ fileId: file.id, filePath: file.path, tmdbId, err },
				'[UnmatchedFileService] Movie match failed'
			);
			return {
				success: false,
				error: err instanceof Error ? err.message : 'Failed to match movie'
			};
		}
	}

	/**
	 * Match a single file as a TV episode
	 */
	private async matchEpisodeFile(
		file: UnmatchedFile,
		tmdbId: number,
		season: number,
		episode: number
	): Promise<{ success: boolean; mediaId?: string; error?: string }> {
		const correlationId = file.correlationId ?? randomUUID();
		const matchLogger = createChildLogger({ logDomain: 'scans' as const, correlationId });
		try {
			const [fileRecord] = await db
				.select()
				.from(unmatchedFiles)
				.where(eq(unmatchedFiles.id, file.id));

			if (!fileRecord) {
				return { success: false, error: 'File record not found' };
			}

			matchLogger.info(
				{ fileId: file.id, filePath: file.path, tmdbId, season, episode },
				'[UnmatchedFileService] Manual episode match started'
			);

			// Write season/episode before acceptMatch reads them from the DB
			await db
				.update(unmatchedFiles)
				.set({ parsedSeason: season, parsedEpisode: episode })
				.where(eq(unmatchedFiles.id, file.id));

			// Deliberate manual match: retire files the coverage rule says
			// this one displaces, instead of leaving a duplicate (#627).
			await mediaMatcherService.acceptMatch(file.id, tmdbId, 'tv', { allowReplace: true });
			matchLogger.info(
				{ fileId: file.id, tmdbId, season, episode },
				'[UnmatchedFileService] Manual episode match successful'
			);
			return { success: true };
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : 'Failed to match episode';
			matchLogger.error(
				{ fileId: file.id, filePath: file.path, tmdbId, season, episode, err },
				`[UnmatchedFileService] Episode match failed: ${errorMsg}`
			);
			return { success: false, error: errorMsg };
		}
	}

	/**
	 * Group files by immediate parent folder
	 */
	private groupByImmediateFolder(files: UnmatchedFile[]): UnmatchedFolder[] {
		const folderMap = new Map<string, UnmatchedFolder>();

		for (const file of files) {
			const parentPath = dirname(file.path);
			const folderName = basename(parentPath);

			if (!folderMap.has(parentPath)) {
				folderMap.set(parentPath, {
					folderPath: parentPath,
					folderName,
					mediaType: file.mediaType,
					fileCount: 0,
					files: [],
					reasons: [],
					commonParsedTitle: null,
					isShowFolder: false
				});
			}

			const folder = folderMap.get(parentPath)!;
			folder.files.push(file);
			folder.fileCount++;
			if (file.reason && !folder.reasons.includes(file.reason)) {
				folder.reasons.push(file.reason);
			}
		}

		// Process each folder
		const folders = Array.from(folderMap.values()).map((folder) => ({
			...folder,
			commonParsedTitle: this.getMostCommonParsedTitle(folder.files)
		}));

		// Sort by file count (descending)
		return folders.sort((a, b) => b.fileCount - a.fileCount);
	}

	/**
	 * Group files by show folder (detect Season subfolders)
	 */
	private groupByShowFolder(files: UnmatchedFile[]): UnmatchedFolder[] {
		const folderMap = new Map<string, UnmatchedFolder>();
		const seasonPattern = /season\s*(\d+)|^s(\d+)$/i;

		// First pass: identify which folders are season folders
		const fileParentFolders = new Map<
			string,
			{ path: string; name: string; isSeason: boolean; seasonNumber?: number }
		>();

		for (const file of files) {
			const parentPath = dirname(file.path);
			const folderName = basename(parentPath);

			if (!fileParentFolders.has(parentPath)) {
				const match = folderName.match(seasonPattern);
				const seasonNumber = match ? parseInt(match[1] || match[2], 10) : undefined;
				fileParentFolders.set(parentPath, {
					path: parentPath,
					name: folderName,
					isSeason: !!seasonNumber,
					seasonNumber
				});
			}
		}

		// Second pass: group files
		for (const file of files) {
			const parentPath = dirname(file.path);
			const parentFolder = fileParentFolders.get(parentPath)!;

			let groupPath: string;
			let groupName: string;
			let isShowFolder: boolean;
			let showName: string | undefined;
			let seasonInfo: { path: string; name: string; seasonNumber?: number } | undefined;

			if (parentFolder.isSeason) {
				// This file is in a Season folder, group by parent (show folder)
				groupPath = dirname(parentPath);
				groupName = basename(groupPath);
				isShowFolder = true;
				showName = groupName;
				seasonInfo = {
					path: parentPath,
					name: parentFolder.name,
					seasonNumber: parentFolder.seasonNumber
				};
			} else {
				// This file is not in a season folder, use immediate parent
				groupPath = parentPath;
				groupName = parentFolder.name;
				isShowFolder = false;
			}

			if (!folderMap.has(groupPath)) {
				folderMap.set(groupPath, {
					folderPath: groupPath,
					folderName: groupName,
					mediaType: file.mediaType,
					fileCount: 0,
					files: [],
					reasons: [],
					commonParsedTitle: null,
					isShowFolder,
					showName,
					seasonFolders: []
				});
			}

			const folder = folderMap.get(groupPath)!;
			folder.files.push(file);
			folder.fileCount++;
			if (file.reason && !folder.reasons.includes(file.reason)) {
				folder.reasons.push(file.reason);
			}

			// Track season subfolders for show folders
			if (seasonInfo && isShowFolder) {
				const existingSeason = folder.seasonFolders?.find((s) => s.path === seasonInfo!.path);
				if (!existingSeason) {
					folder.seasonFolders!.push({
						...seasonInfo,
						fileCount: 1
					});
				} else {
					existingSeason.fileCount++;
				}
			}
		}

		// Process each folder
		const folders = Array.from(folderMap.values()).map((folder) => {
			// Sort season folders
			if (folder.seasonFolders) {
				folder.seasonFolders.sort((a, b) => (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0));
			}

			return {
				...folder,
				commonParsedTitle: this.getMostCommonParsedTitle(folder.files)
			};
		});

		// Sort by file count (descending), show folders first
		return folders.sort((a, b) => {
			if (a.isShowFolder && !b.isShowFolder) return -1;
			if (!a.isShowFolder && b.isShowFolder) return 1;
			return b.fileCount - a.fileCount;
		});
	}

	/**
	 * Get the most common parsed title from a list of files
	 */
	private getMostCommonParsedTitle(files: UnmatchedFile[]): string | null {
		const titleCounts = new Map<string, number>();

		for (const file of files) {
			if (file.parsedTitle) {
				titleCounts.set(file.parsedTitle, (titleCounts.get(file.parsedTitle) || 0) + 1);
			}
		}

		let mostCommonTitle: string | null = null;
		let maxCount = 0;

		for (const [title, count] of titleCounts) {
			if (count > maxCount) {
				mostCommonTitle = title;
				maxCount = count;
			}
		}

		return mostCommonTitle;
	}

	/**
	 * Map database record to UnmatchedFile type
	 */
	private mapToUnmatchedFile(record: {
		id: string;
		path: string;
		rootFolderId: string | null;
		rootFolderPath: string | null;
		mediaType: string;
		size: number | null;
		parsedTitle: string | null;
		parsedYear: number | null;
		parsedSeason: number | null;
		parsedEpisode: number | null;
		suggestedMatches: unknown;
		reason: string | null;
		discoveredAt: string | null;
		correlationId?: string | null;
	}): UnmatchedFile {
		return {
			id: record.id,
			path: record.path,
			rootFolderId: record.rootFolderId,
			rootFolderPath: record.rootFolderPath,
			mediaType: record.mediaType as 'movie' | 'tv',
			size: record.size,
			parsedTitle: record.parsedTitle,
			parsedYear: record.parsedYear,
			parsedSeason: record.parsedSeason,
			parsedEpisode: record.parsedEpisode,
			suggestedMatches: record.suggestedMatches as UnmatchedFile['suggestedMatches'],
			reason: record.reason as UnmatchedReason,
			discoveredAt: record.discoveredAt || new Date().toISOString(),
			correlationId: record.correlationId ?? null
		};
	}
}

export const unmatchedFileService = UnmatchedFileService.getInstance();
