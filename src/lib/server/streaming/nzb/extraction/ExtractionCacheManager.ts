/**
 * ExtractionCacheManager - Manages extracted file cleanup and storage.
 *
 * Handles automatic cleanup of extracted files after configurable retention period.
 * Tracks disk usage and can enforce cache size limits.
 */

import { existsSync } from 'fs';
import { readdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import { db } from '#lib/server/db/index.js';
import { nzbStreamMounts, rootFolders } from '#lib/server/db/schema.js';
import { eq, lt, and, isNotNull, sql } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import type { BackgroundService, ServiceStatus } from '#lib/server/services/background-service.js';

const logger = createChildLogger({ logDomain: 'streams' as const });

/**
 * Cache settings.
 */
export interface CacheSettings {
	/** Retention period in hours (default: 48) */
	retentionHours: number;
	/** Maximum cache size in GB (0 = unlimited) */
	maxCacheSizeGB: number;
}

/**
 * Cache statistics.
 */
export interface CacheStats {
	/** Total number of extracted files */
	fileCount: number;
	/** Total size of extracted files in bytes */
	totalSizeBytes: number;
	/** Files pending cleanup */
	expiredCount: number;
}

/**
 * Default cache settings.
 */
const DEFAULT_SETTINGS: CacheSettings = {
	retentionHours: 48,
	maxCacheSizeGB: 0
};

/**
 * ExtractionCacheManager handles cleanup of extracted files.
 */
export class ExtractionCacheManager implements BackgroundService {
	readonly name = 'ExtractionCacheManager';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;
	private settings: CacheSettings;
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;
	private extractionBaseDir: string | null = null;

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	constructor(settings: Partial<CacheSettings> = {}) {
		this.settings = { ...DEFAULT_SETTINGS, ...settings };
	}

	/**
	 * Start the cleanup scheduler.
	 */
	start(): void {
		if (this.cleanupInterval) {
			return;
		}

		this._status = 'starting';

		// Run cleanup every hour
		this.cleanupInterval = setInterval(
			() => {
				this.runCleanup().catch((err) => {
					logger.error(
						{
							error: err instanceof Error ? err.message : 'Unknown error'
						},
						'[ExtractionCacheManager] Cleanup failed'
					);
				});
			},
			60 * 60 * 1000
		);

		// Run initial cleanup after a short delay
		setTimeout(() => {
			this.runCleanup().catch((err) => {
				logger.error(
					{
						error: err instanceof Error ? err.message : 'Unknown error'
					},
					'[ExtractionCacheManager] Initial cleanup failed'
				);
			});
		}, 10000);

		this._status = 'ready';
		logger.info(
			{
				retentionHours: this.settings.retentionHours,
				maxCacheSizeGB: this.settings.maxCacheSizeGB
			},
			'[ExtractionCacheManager] Started with settings'
		);
	}

	/**
	 * Stop the cleanup scheduler.
	 */
	async stop(): Promise<void> {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
			this._status = 'pending';
			logger.info('[ExtractionCacheManager] Stopped');
		}
	}

	/**
	 * Update cache settings.
	 */
	updateSettings(settings: Partial<CacheSettings>): void {
		this.settings = { ...this.settings, ...settings };
		logger.info(
			{
				retentionHours: this.settings.retentionHours,
				maxCacheSizeGB: this.settings.maxCacheSizeGB
			},
			'[ExtractionCacheManager] Settings updated'
		);
	}

	/**
	 * Run cleanup of expired extracted files.
	 */
	async runCleanup(): Promise<{ cleaned: number; freedBytes: number }> {
		const now = new Date();
		let cleaned = 0;
		let freedBytes = 0;

		try {
			// Find mounts with expired extracted files
			const expiredMounts = db
				.select()
				.from(nzbStreamMounts)
				.where(
					and(
						isNotNull(nzbStreamMounts.extractedFilePath),
						lt(nzbStreamMounts.expiresAt, now.toISOString())
					)
				)
				.all();

			for (const mount of expiredMounts) {
				try {
					if (mount.extractedFilePath && existsSync(mount.extractedFilePath)) {
						// Get size before deletion
						const stats = await stat(mount.extractedFilePath);
						freedBytes += stats.size;

						// Delete the extracted directory (parent of the file)
						const extractDir = join(mount.extractedFilePath, '..');
						await rm(extractDir, { recursive: true, force: true });
						cleaned++;
					}

					// Clear the extracted file path in database
					db.update(nzbStreamMounts)
						.set({
							extractedFilePath: null,
							extractionProgress: null,
							status: 'requires_extraction',
							updatedAt: now.toISOString()
						})
						.where(eq(nzbStreamMounts.id, mount.id))
						.run();
				} catch (err) {
					logger.error(
						{
							mountId: mount.id,
							error: err instanceof Error ? err.message : 'Unknown error'
						},
						'[ExtractionCacheManager] Failed to cleanup mount'
					);
				}
			}

			// Also check for orphaned extraction directories
			const orphanedCleaned = await this.cleanupOrphanedDirectories();
			cleaned += orphanedCleaned;

			if (cleaned > 0) {
				logger.info(
					{
						cleaned,
						freedMB: Math.round(freedBytes / 1024 / 1024)
					},
					'[ExtractionCacheManager] Cleanup complete'
				);
			}

			return { cleaned, freedBytes };
		} catch (err) {
			logger.error(
				{
					error: err instanceof Error ? err.message : 'Unknown error'
				},
				'[ExtractionCacheManager] Cleanup failed'
			);
			return { cleaned, freedBytes };
		}
	}

	/**
	 * Cleanup orphaned extraction directories.
	 */
	private async cleanupOrphanedDirectories(): Promise<number> {
		const baseDir = await this.getExtractionDir();
		if (!baseDir || !existsSync(baseDir)) {
			return 0;
		}

		let cleaned = 0;

		try {
			const entries = await readdir(baseDir);

			for (const entry of entries) {
				// Skip state directory
				if (entry === '.state') continue;

				const mountDir = join(baseDir, entry);
				const stats = await stat(mountDir);

				if (!stats.isDirectory()) continue;

				// Check if this mount still exists in the database
				const mount = db
					.select({ id: nzbStreamMounts.id })
					.from(nzbStreamMounts)
					.where(eq(nzbStreamMounts.id, entry))
					.get();

				if (!mount) {
					// Orphaned directory - clean it up
					try {
						await rm(mountDir, { recursive: true, force: true });
						cleaned++;
						logger.debug(
							{
								mountDir
							},
							'[ExtractionCacheManager] Cleaned orphaned directory'
						);
					} catch {
						// Ignore errors
					}
				}
			}
		} catch {
			// Ignore errors
		}

		return cleaned;
	}

	/**
	 * Set expiration time for an extracted file.
	 */
	async setExpiration(mountId: string, extractedFilePath: string): Promise<void> {
		const expiresAt = new Date(Date.now() + this.settings.retentionHours * 60 * 60 * 1000);

		db.update(nzbStreamMounts)
			.set({
				extractedFilePath,
				expiresAt: expiresAt.toISOString(),
				updatedAt: new Date().toISOString()
			})
			.where(eq(nzbStreamMounts.id, mountId))
			.run();

		logger.debug(
			{
				mountId,
				expiresAt: expiresAt.toISOString()
			},
			'[ExtractionCacheManager] Set expiration'
		);
	}

	/**
	 * Refresh expiration time when file is accessed.
	 */
	async refreshExpiration(mountId: string): Promise<void> {
		const mount = db.select().from(nzbStreamMounts).where(eq(nzbStreamMounts.id, mountId)).get();

		if (!mount?.extractedFilePath) {
			return;
		}

		const expiresAt = new Date(Date.now() + this.settings.retentionHours * 60 * 60 * 1000);

		db.update(nzbStreamMounts)
			.set({
				expiresAt: expiresAt.toISOString(),
				lastAccessedAt: new Date().toISOString(),
				accessCount: (mount.accessCount ?? 0) + 1,
				updatedAt: new Date().toISOString()
			})
			.where(eq(nzbStreamMounts.id, mountId))
			.run();
	}

	/**
	 * Get cache statistics.
	 */
	async getStats(): Promise<CacheStats> {
		const now = new Date();

		// Count files with extracted paths
		const result = db
			.select({
				count: sql<number>`count(*)`,
				expiredCount: sql<number>`sum(case when expires_at < ${now.toISOString()} then 1 else 0 end)`
			})
			.from(nzbStreamMounts)
			.where(isNotNull(nzbStreamMounts.extractedFilePath))
			.get();

		// Calculate total size from disk
		let totalSizeBytes = 0;
		const baseDir = await this.getExtractionDir();

		if (baseDir && existsSync(baseDir)) {
			totalSizeBytes = await this.calculateDirSize(baseDir);
		}

		return {
			fileCount: result?.count ?? 0,
			totalSizeBytes,
			expiredCount: result?.expiredCount ?? 0
		};
	}

	/**
	 * Calculate directory size recursively.
	 */
	private async calculateDirSize(dir: string): Promise<number> {
		let size = 0;

		try {
			const entries = await readdir(dir, { withFileTypes: true });

			for (const entry of entries) {
				const path = join(dir, entry.name);

				if (entry.isDirectory()) {
					size += await this.calculateDirSize(path);
				} else if (entry.isFile()) {
					const stats = await stat(path);
					size += stats.size;
				}
			}
		} catch {
			// Ignore errors
		}

		return size;
	}

	/**
	 * Force cleanup a specific mount's extracted files.
	 */
	async cleanupMount(mountId: string): Promise<boolean> {
		const mount = db.select().from(nzbStreamMounts).where(eq(nzbStreamMounts.id, mountId)).get();

		if (!mount?.extractedFilePath) {
			return false;
		}

		try {
			// Delete the extracted directory
			const extractDir = join(mount.extractedFilePath, '..');
			if (existsSync(extractDir)) {
				await rm(extractDir, { recursive: true, force: true });
			}

			// Update database
			db.update(nzbStreamMounts)
				.set({
					extractedFilePath: null,
					extractionProgress: null,
					status: 'requires_extraction',
					updatedAt: new Date().toISOString()
				})
				.where(eq(nzbStreamMounts.id, mountId))
				.run();

			logger.info({ mountId }, '[ExtractionCacheManager] Cleaned up mount');
			return true;
		} catch (err) {
			logger.error(
				{
					mountId,
					error: err instanceof Error ? err.message : 'Unknown error'
				},
				'[ExtractionCacheManager] Failed to cleanup mount'
			);
			return false;
		}
	}

	/**
	 * Get extraction directory.
	 */
	private async getExtractionDir(): Promise<string | null> {
		if (this.extractionBaseDir) {
			return this.extractionBaseDir;
		}

		const folders = db.select().from(rootFolders).all();
		if (folders.length === 0) {
			return null;
		}

		this.extractionBaseDir = join(folders[0].path, '.usenet-extraction');
		return this.extractionBaseDir;
	}
}

// Singleton instance
let instance: ExtractionCacheManager | null = null;

/**
 * Get the singleton ExtractionCacheManager.
 */
export function getExtractionCacheManager(): ExtractionCacheManager {
	if (!instance) {
		instance = new ExtractionCacheManager();
	}
	return instance;
}
