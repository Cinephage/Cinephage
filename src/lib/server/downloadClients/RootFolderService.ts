/**
 * RootFolderService - Manages media library destination folders.
 * Handles path validation and free space checking.
 */

import { db } from '#lib/server/db/index.js';
import { rootFolders as rootFoldersTable } from '#lib/server/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ValidationError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'imports' as const });
import {
	findOverlappingRootFolder,
	getRootFolderOverlapMessage
} from '#lib/server/filesystem/root-folder-overlap.js';
import {
	isAnimeRootFolderEnforcementEnabled,
	setAnimeRootFolderEnforcement
} from '#lib/server/library/anime-root-enforcement-settings.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';
import { libraryWatcherService } from '#lib/server/library/library-watcher.js';

import type {
	RootFolder,
	PathValidationResult,
	RootFolderMediaType,
	RootFolderMediaSubType
} from '#lib/types/downloadClient.js';

/**
 * Configuration for creating/updating a root folder.
 */
export interface RootFolderInput {
	name: string;
	path: string;
	mediaType: RootFolderMediaType;
	mediaSubType?: RootFolderMediaSubType;
	isDefault?: boolean;
	readOnly?: boolean;
	preserveSymlinks?: boolean;
	defaultMonitored?: boolean;
	skipFolderPatterns?: string[];
	blockedVideoExtensions?: string[];
}

export interface DeleteRootFolderResult {
	autoDisabledAnimeEnforcement: boolean;
}

export interface UpdateRootFolderResult {
	folder: RootFolder;
	autoDisabledAnimeEnforcement: boolean;
}

/**
 * Service for managing root folders (media library destinations).
 */
export class RootFolderService {
	/**
	 * Get all root folders with current accessibility status.
	 */
	async getFolders(): Promise<RootFolder[]> {
		const rows = await db.select().from(rootFoldersTable);
		const folders: RootFolder[] = [];

		for (const row of rows) {
			const folder = await this.rowToFolder(row);
			folders.push(folder);
		}

		return folders;
	}

	/**
	 * Get root folders by media type.
	 */
	async getFoldersByType(mediaType: RootFolderMediaType): Promise<RootFolder[]> {
		const rows = await db
			.select()
			.from(rootFoldersTable)
			.where(eq(rootFoldersTable.mediaType, mediaType));

		const folders: RootFolder[] = [];
		for (const row of rows) {
			const folder = await this.rowToFolder(row);
			folders.push(folder);
		}

		return folders;
	}

	/**
	 * Get a specific folder by ID.
	 */
	async getFolder(id: string): Promise<RootFolder | undefined> {
		const rows = await db.select().from(rootFoldersTable).where(eq(rootFoldersTable.id, id));
		if (!rows[0]) return undefined;
		return this.rowToFolder(rows[0]);
	}

	/**
	 * Get the default folder for a media type and optional subtype.
	 */
	async getDefaultFolder(
		mediaType: RootFolderMediaType,
		mediaSubType?: RootFolderMediaSubType
	): Promise<RootFolder | undefined> {
		const whereClause = mediaSubType
			? and(
					eq(rootFoldersTable.mediaType, mediaType),
					eq(rootFoldersTable.mediaSubType, mediaSubType),
					eq(rootFoldersTable.isDefault, true)
				)
			: and(eq(rootFoldersTable.mediaType, mediaType), eq(rootFoldersTable.isDefault, true));

		const rows = await db.select().from(rootFoldersTable).where(whereClause);

		if (!rows[0]) return undefined;
		return this.rowToFolder(rows[0]);
	}

	/**
	 * Create a new root folder.
	 */
	async createFolder(input: RootFolderInput): Promise<{ folder: RootFolder; scanJobId: string }> {
		// Validate path exists (use read-only mode if specified)
		const validation = await this.validatePath(input.path, input.readOnly ?? false);
		if (!validation.valid) {
			throw new ValidationError(validation.error || 'Invalid path', { path: input.path });
		}

		await this.assertNoPathOverlap(input.path);

		// If this is being set as default, unset any existing defaults for this media type + subtype.
		const mediaSubType = input.mediaSubType ?? 'standard';
		if (input.isDefault) {
			await db
				.update(rootFoldersTable)
				.set({ isDefault: false })
				.where(
					and(
						eq(rootFoldersTable.mediaType, input.mediaType),
						eq(rootFoldersTable.mediaSubType, mediaSubType)
					)
				);
		}

		const id = randomUUID();
		const now = new Date().toISOString();

		await db.insert(rootFoldersTable).values({
			id,
			name: input.name,
			path: input.path,
			mediaType: input.mediaType,
			mediaSubType,
			isDefault: input.isDefault ?? false,
			readOnly: input.readOnly ?? false,
			preserveSymlinks: input.preserveSymlinks ?? false,
			defaultMonitored: input.defaultMonitored ?? true,
			freeSpaceBytes: input.readOnly ? null : validation.freeSpaceBytes,
			lastCheckedAt: now,
			createdAt: now,
			skipFolderPatterns:
				input.skipFolderPatterns && input.skipFolderPatterns.length > 0
					? JSON.stringify(input.skipFolderPatterns)
					: null,
			blockedVideoExtensions:
				input.blockedVideoExtensions && input.blockedVideoExtensions.length > 0
					? JSON.stringify(input.blockedVideoExtensions)
					: null
		});

		logger.info(
			{
				id,
				name: input.name,
				path: input.path,
				readOnly: input.readOnly ?? false,
				preserveSymlinks: input.preserveSymlinks ?? false
			},
			'Root folder created'
		);

		// Enqueue initial scan for the new folder via job service
		const scanJob = await libraryJobService.enqueueRootFolderScan(id);

		// Start watching this folder for changes
		libraryWatcherService.watchFolder(id, input.path).catch((error) => {
			logger.warn(
				{
					id,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to start watching new folder'
			);
		});

		await this.syncSystemLibraries();

		const created = await this.getFolder(id);
		if (!created) {
			throw new Error('Failed to create root folder');
		}

		return { folder: created, scanJobId: scanJob.id };
	}

	/**
	 * Update a root folder.
	 */
	async updateFolder(
		id: string,
		updates: Partial<RootFolderInput>
	): Promise<UpdateRootFolderResult> {
		const existing = await this.getFolder(id);
		if (!existing) {
			throw new Error(`Root folder not found: ${id}`);
		}

		// Determine read-only mode (use new value if provided, else existing)
		const readOnly = updates.readOnly ?? existing.readOnly;

		// If path is being updated, validate it (use read-only mode if applicable)
		if (updates.path && updates.path !== existing.path) {
			const validation = await this.validatePath(updates.path, readOnly);
			if (!validation.valid) {
				throw new ValidationError(validation.error || 'Invalid path', {
					path: updates.path
				});
			}
		}

		await this.assertNoPathOverlap(updates.path ?? existing.path, id);

		// If this is being set as default, unset any existing defaults for this media type + subtype.
		const mediaType = updates.mediaType ?? existing.mediaType;
		const mediaSubType = updates.mediaSubType ?? existing.mediaSubType;
		if (updates.isDefault) {
			await db
				.update(rootFoldersTable)
				.set({ isDefault: false })
				.where(
					and(
						eq(rootFoldersTable.mediaType, mediaType),
						eq(rootFoldersTable.mediaSubType, mediaSubType)
					)
				);
		}

		const updateData: Record<string, unknown> = {};
		if (updates.name !== undefined) updateData.name = updates.name;
		if (updates.path !== undefined) updateData.path = updates.path;
		if (updates.mediaType !== undefined) updateData.mediaType = updates.mediaType;
		if (updates.mediaSubType !== undefined) updateData.mediaSubType = updates.mediaSubType;
		if (updates.isDefault !== undefined) updateData.isDefault = updates.isDefault;
		if (updates.readOnly !== undefined) updateData.readOnly = updates.readOnly;
		if (updates.preserveSymlinks !== undefined)
			updateData.preserveSymlinks = updates.preserveSymlinks;
		if (updates.defaultMonitored !== undefined)
			updateData.defaultMonitored = updates.defaultMonitored;
		if (updates.skipFolderPatterns !== undefined)
			updateData.skipFolderPatterns =
				updates.skipFolderPatterns.length > 0 ? JSON.stringify(updates.skipFolderPatterns) : null;
		if (updates.blockedVideoExtensions !== undefined)
			updateData.blockedVideoExtensions =
				updates.blockedVideoExtensions.length > 0
					? JSON.stringify(updates.blockedVideoExtensions)
					: null;

		await db.update(rootFoldersTable).set(updateData).where(eq(rootFoldersTable.id, id));

		logger.info({ id }, 'Root folder updated');

		const updated = await this.getFolder(id);
		if (!updated) {
			throw new Error('Failed to update root folder');
		}

		await this.syncSystemLibraries();

		const autoDisabledAnimeEnforcement = await this.disableAnimeEnforcementIfNoAnimeFolders();

		return { folder: updated, autoDisabledAnimeEnforcement };
	}

	/**
	 * Delete a root folder.
	 */
	async deleteFolder(id: string): Promise<DeleteRootFolderResult> {
		const existing = await this.getFolder(id);
		if (!existing) {
			throw new Error(`Root folder not found: ${id}`);
		}

		// Stop watching before delete
		await libraryWatcherService.unwatchFolder(id);

		await db.delete(rootFoldersTable).where(eq(rootFoldersTable.id, id));
		logger.info({ id }, 'Root folder deleted');

		await this.syncSystemLibraries();

		const autoDisabledAnimeEnforcement = await this.disableAnimeEnforcementIfNoAnimeFolders();

		return { autoDisabledAnimeEnforcement };
	}

	private async disableAnimeEnforcementIfNoAnimeFolders(): Promise<boolean> {
		const remainingAnimeFolders = await db
			.select({ id: rootFoldersTable.id })
			.from(rootFoldersTable)
			.where(eq(rootFoldersTable.mediaSubType, 'anime'))
			.limit(1);

		if (remainingAnimeFolders.length > 0) {
			return false;
		}

		if (await isAnimeRootFolderEnforcementEnabled()) {
			await setAnimeRootFolderEnforcement(false);
			logger.warn(
				'Anime root folder enforcement auto-disabled because no anime subtype root folders remain'
			);
			return true;
		}

		return false;
	}

	private async syncSystemLibraries(): Promise<void> {
		try {
			await getLibraryEntityService().reconcileAll();
		} catch (error) {
			logger.warn(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to synchronize system libraries after root folder update'
			);
		}
	}

	/**
	 * Validate a path exists and is accessible.
	 * @param folderPath - The path to validate
	 * @param readOnly - If true, only check read access (skip write check)
	 */
	async validatePath(
		folderPath: string,
		readOnly = false,
		excludeId?: string
	): Promise<PathValidationResult> {
		try {
			// Normalize path
			const normalizedPath = path.resolve(folderPath);

			// Check if path exists
			let stats;
			try {
				stats = await fs.stat(normalizedPath);
			} catch {
				return {
					valid: false,
					exists: false,
					writable: false,
					error: 'Path does not exist'
				};
			}

			// Check if it's a directory
			if (!stats.isDirectory()) {
				return {
					valid: false,
					exists: true,
					writable: false,
					error: 'Path is not a directory'
				};
			}

			// For read-only folders (like NZBDav mounts), only check read access
			if (readOnly) {
				try {
					await fs.access(normalizedPath, fs.constants.R_OK);
					const overlapMessage = await this.getPathOverlapMessage(normalizedPath, excludeId);
					if (overlapMessage) {
						return {
							valid: false,
							exists: true,
							writable: false,
							error: overlapMessage
						};
					}

					return {
						valid: true,
						exists: true,
						writable: false // Read-only folders are not writable
						// No free space for read-only folders (N/A)
					};
				} catch {
					return {
						valid: false,
						exists: true,
						writable: false,
						error: 'Path is not readable'
					};
				}
			}

			// Check if writable by actually attempting to write a test file
			const isWritable = await this.testWriteAccess(normalizedPath);
			if (!isWritable) {
				logger.warn({ path: normalizedPath }, 'Write test failed for path');
				return {
					valid: false,
					exists: true,
					writable: false,
					error: 'Path is not writable'
				};
			}

			// Get free space
			const freeSpaceBytes = await this.getFreeSpace(normalizedPath);
			const overlapMessage = await this.getPathOverlapMessage(normalizedPath, excludeId);
			if (overlapMessage) {
				return {
					valid: false,
					exists: true,
					writable: true,
					error: overlapMessage,
					freeSpaceBytes,
					freeSpaceFormatted: this.formatBytes(freeSpaceBytes)
				};
			}

			return {
				valid: true,
				exists: true,
				writable: true,
				freeSpaceBytes,
				freeSpaceFormatted: this.formatBytes(freeSpaceBytes)
			};
		} catch (error) {
			return {
				valid: false,
				exists: false,
				writable: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	private async getPathOverlapMessage(
		folderPath: string,
		excludeId?: string
	): Promise<string | null> {
		const existingFolders = await db
			.select({
				id: rootFoldersTable.id,
				path: rootFoldersTable.path,
				name: rootFoldersTable.name
			})
			.from(rootFoldersTable);

		const overlap = await findOverlappingRootFolder(folderPath, existingFolders, excludeId);
		if (!overlap) {
			return null;
		}

		return getRootFolderOverlapMessage(folderPath, overlap);
	}

	private async assertNoPathOverlap(folderPath: string, excludeId?: string): Promise<void> {
		const overlapMessage = await this.getPathOverlapMessage(folderPath, excludeId);
		if (overlapMessage) {
			throw new ValidationError(overlapMessage, { path: folderPath, excludeId });
		}
	}

	/**
	 * Get free space for a path in bytes.
	 */
	async getFreeSpace(folderPath: string): Promise<number> {
		try {
			// Use statfs to get filesystem info
			const stats = await fs.statfs(folderPath);
			return stats.bfree * stats.bsize;
		} catch {
			// Fallback: return 0 if unable to determine
			return 0;
		}
	}

	/**
	 * Get total filesystem capacity for a path in bytes.
	 */
	async getTotalSpace(folderPath: string): Promise<number> {
		try {
			const stats = await fs.statfs(folderPath);
			return stats.blocks * stats.bsize;
		} catch {
			return 0;
		}
	}

	/**
	 * Refresh free space for all folders.
	 */
	async refreshFreeSpace(): Promise<void> {
		const folders = await this.getFolders();
		const now = new Date().toISOString();

		for (const folder of folders) {
			try {
				const freeSpaceBytes = await this.getFreeSpace(folder.path);
				const totalSpaceBytes = await this.getTotalSpace(folder.path);
				await db
					.update(rootFoldersTable)
					.set({
						freeSpaceBytes,
						totalSpaceBytes,
						lastCheckedAt: now
					})
					.where(eq(rootFoldersTable.id, folder.id));
			} catch (error) {
				logger.warn(
					{
						folderId: folder.id,
						path: folder.path,
						error: error instanceof Error ? error.message : String(error)
					},
					'Failed to refresh free space for folder'
				);
			}
		}
	}

	/**
	 * Format bytes to human-readable string.
	 */
	formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';

		const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
		const k = 1024;
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		const value = bytes / Math.pow(k, i);

		return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
	}

	/**
	 * Test if a directory is actually writable by creating and deleting a temp directory.
	 * This is more reliable than fs.access() which only checks permission bits.
	 */
	private async testWriteAccess(dirPath: string): Promise<boolean> {
		let testDir: string | null = null;
		try {
			testDir = await fs.mkdtemp(path.join(dirPath, '.cinephage-write-test-'));
			// mkdtemp creates the dir 0700 (owner-only). Other processes watch
			// these folders (e.g. Jellyfin) and log permission errors when they
			// react to a transient entry they cannot read — relax the mode.
			await fs.chmod(testDir, 0o755);
			await fs.rmdir(testDir);
			return true;
		} catch (err) {
			const errObj = err as NodeJS.ErrnoException;
			logger.warn(
				{
					path: dirPath,
					testDir,
					errorCode: errObj.code,
					errorMessage: errObj.message
				},
				'testWriteAccess failed'
			);
			// Attempt cleanup in case mkdir succeeded but rmdir failed
			if (testDir) {
				try {
					await fs.rmdir(testDir);
				} catch {
					// Ignore cleanup errors
				}
			}
			return false;
		}
	}

	/**
	 * Convert database row to RootFolder with live accessibility check.
	 */
	private async rowToFolder(row: typeof rootFoldersTable.$inferSelect): Promise<RootFolder> {
		// Check current accessibility
		let accessible: boolean;
		let freeSpaceBytes: number | null = null;
		let totalSpaceBytes: number | null = null;
		let freeSpaceFormatted: string | undefined;
		const isReadOnly = !!row.readOnly;

		try {
			// Check read access first
			await fs.access(row.path, fs.constants.R_OK);

			if (isReadOnly) {
				// For read-only folders, only check read access (no write test, no free space)
				accessible = true;
			} else {
				// For normal folders, test actual write capability
				accessible = await this.testWriteAccess(row.path);

				// Update free space if it's stale (older than 5 minutes)
				const lastChecked = row.lastCheckedAt ? new Date(row.lastCheckedAt) : null;
				const isStale = !lastChecked || Date.now() - lastChecked.getTime() > 5 * 60 * 1000;

				if (isStale || row.freeSpaceBytes === null) {
					freeSpaceBytes = await this.getFreeSpace(row.path);
				} else {
					freeSpaceBytes = row.freeSpaceBytes;
				}
				totalSpaceBytes = await this.getTotalSpace(row.path);

				if (freeSpaceBytes) {
					freeSpaceFormatted = this.formatBytes(freeSpaceBytes);
				}
			}
		} catch {
			accessible = false;
		}

		return {
			id: row.id,
			name: row.name,
			path: row.path,
			mediaType: row.mediaType as RootFolderMediaType,
			mediaSubType: (row.mediaSubType ?? 'standard') as RootFolderMediaSubType,
			isDefault: !!row.isDefault,
			readOnly: isReadOnly,
			preserveSymlinks: !!row.preserveSymlinks,
			defaultMonitored: row.defaultMonitored ?? true,
			freeSpaceBytes,
			totalSpaceBytes,
			freeSpaceFormatted,
			accessible,
			lastCheckedAt: row.lastCheckedAt ?? undefined,
			createdAt: row.createdAt ?? undefined,
			skipFolderPatterns: row.skipFolderPatterns
				? (JSON.parse(row.skipFolderPatterns) as string[])
				: [],
			blockedVideoExtensions: row.blockedVideoExtensions
				? (JSON.parse(row.blockedVideoExtensions) as string[])
				: []
		};
	}

	/**
	 * Check if a root folder is read-only.
	 * Uses a simple cache to avoid repeated DB queries within the same request cycle.
	 */
	private readOnlyCache = new Map<string, boolean>();

	async isReadOnlyFolder(rootFolderId: string | null | undefined): Promise<boolean> {
		if (!rootFolderId) return false;

		// Check cache first
		const cached = this.readOnlyCache.get(rootFolderId);
		if (cached !== undefined) return cached;

		// Query database
		const [folder] = await db
			.select({ readOnly: rootFoldersTable.readOnly })
			.from(rootFoldersTable)
			.where(eq(rootFoldersTable.id, rootFolderId))
			.limit(1);

		const isReadOnly = folder?.readOnly ?? false;
		this.readOnlyCache.set(rootFolderId, isReadOnly);
		return isReadOnly;
	}

	/**
	 * Clear the read-only cache.
	 * Call this when root folder settings change.
	 */
	clearReadOnlyCache(): void {
		this.readOnlyCache.clear();
	}
}

/** Singleton instance */
let serviceInstance: RootFolderService | null = null;

/** Get the singleton RootFolderService */
export function getRootFolderService(): RootFolderService {
	if (!serviceInstance) {
		serviceInstance = new RootFolderService();
	}
	return serviceInstance;
}

/** Reset the singleton (for testing) */
export function resetRootFolderService(): void {
	serviceInstance = null;
}
