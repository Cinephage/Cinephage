/**
 * NzbMountManager - Manages NZB stream mount lifecycle.
 *
 * Handles creation, retrieval, and cleanup of stream mounts in the database.
 */

import { randomUUID } from 'node:crypto';
import { eq, lt, and, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { nzbStreamMounts } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { parseNzb } from '#lib/server/streaming/usenet/NzbParser.js';
import { encryptCredential } from '#lib/server/crypto/credentialsCrypto.js';

const logger = createChildLogger({ logDomain: 'streams' as const });
import type { NzbFile } from '#lib/server/streaming/usenet/types.js';
import { getSegmentCacheService } from '#lib/server/streaming/usenet/SegmentCacheService.js';

/**
 * Mount status values.
 */
export type MountStatus = 'pending' | 'parsing' | 'ready' | 'downloading' | 'error' | 'expired';

/**
 * Streamability info for a mount.
 */
export interface StreamabilityInfo {
	/** Whether content can be streamed directly */
	canStream: boolean;
	/** Detected archive type */
	archiveType?: 'rar' | '7z' | 'zip' | 'none';
	/** Compression method (0 = stored, >0 = compressed) */
	compressionMethod?: number;
	/** Whether password is required */
	requiresPassword?: boolean;
	/** Error message if not streamable */
	error?: string;
}

/**
 * Mount creation input.
 */
export interface CreateMountInput {
	title: string;
	nzbContent: Buffer | string;
	indexerId?: string;
	downloadUrl?: string;
	movieId?: string;
	seriesId?: string;
	seasonNumber?: number;
	episodeIds?: string[];
	password?: string;
}

/**
 * Mount info returned from queries.
 */
export interface MountInfo {
	id: string;
	nzbHash: string;
	title: string;
	status: MountStatus;
	fileCount: number;
	totalSize: number;
	mediaFiles: NzbFile[];
	rarInfo?: {
		hasRar: boolean;
		isEncrypted: boolean;
		partCount: number;
	};
	/** Streamability info (populated after checkStreamability is called) */
	streamability?: StreamabilityInfo;
	/** Path to extracted file if extraction completed */
	extractedFilePath?: string;
	/** Extraction progress (0-100) */
	extractionProgress?: number;
	movieId?: string;
	seriesId?: string;
	errorMessage?: string;
	createdAt: string;
	expiresAt?: string;
}

/**
 * Default mount expiration (24 hours).
 */
const DEFAULT_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/**
 * NzbMountManager manages stream mount records.
 */
class NzbMountManager {
	/**
	 * Create a new mount from NZB content.
	 */
	async createMount(input: CreateMountInput): Promise<MountInfo> {
		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + DEFAULT_EXPIRATION_MS).toISOString();

		try {
			// Parse the NZB
			const parsed = parseNzb(input.nzbContent);

			// Check for RAR files
			const rarFiles = parsed.files.filter((f) => f.isRar);
			const rarInfo =
				rarFiles.length > 0
					? {
							hasRar: true,
							isEncrypted: false, // Will be determined when streaming
							partCount: rarFiles.length
						}
					: undefined;

			// Store all files with segments for streaming
			// Note: RAR files are stored for detection but streaming will be rejected
			const filesToStore = parsed.files;

			const mediaFilesData = filesToStore.map((f) => ({
				index: f.index,
				name: f.name,
				size: f.size,
				isRar: f.isRar,
				segments: f.segments.map((s) => ({
					messageId: s.messageId,
					bytes: s.bytes,
					number: s.number
				})),
				groups: f.groups
			}));

			// Insert mount record and get generated ID. The id is generated
			// client-side so the RAR password envelope can bind to it (AAD).
			const mountId = randomUUID();
			const [inserted] = await db
				.insert(nzbStreamMounts)
				.values({
					id: mountId,
					nzbHash: parsed.hash,
					title: input.title,
					indexerId: input.indexerId,
					downloadUrl: input.downloadUrl,
					movieId: input.movieId,
					seriesId: input.seriesId,
					seasonNumber: input.seasonNumber,
					episodeIds: input.episodeIds,
					fileCount: parsed.files.length,
					totalSize: parsed.totalSize,
					mediaFiles: mediaFilesData,
					rarInfo: rarInfo
						? {
								isMultiPart: rarFiles.length > 1,
								isEncrypted: false,
								compressionMethod: 0,
								format: 'rar5' as const,
								innerFiles: []
							}
						: undefined,
					password: input.password
						? encryptCredential('nzb-mount-password', mountId, input.password)
						: undefined,
					status: 'ready',
					expiresAt
				})
				.returning();

			logger.info(
				{
					id: inserted.id,
					title: input.title,
					hash: parsed.hash.slice(0, 12),
					files: parsed.files.length,
					mediaFiles: parsed.mediaFiles.length
				},
				'[NzbMountManager] Created mount'
			);

			// Prefetch critical segments for fast FFmpeg probing (async, non-blocking)
			if (parsed.mediaFiles.length > 0) {
				const mainFile = parsed.mediaFiles.reduce((best, f) => (f.size > best.size ? f : best));
				setImmediate(async () => {
					try {
						await getSegmentCacheService().prefetchCriticalSegments(
							inserted.id,
							mainFile.index,
							mainFile
						);
					} catch (error) {
						logger.warn(
							{
								mountId: inserted.id,
								error: error instanceof Error ? error.message : String(error)
							},
							'[NzbMountManager] Prefetch failed (non-fatal)'
						);
					}
				});
			}

			return {
				id: inserted.id,
				nzbHash: parsed.hash,
				title: input.title,
				status: 'ready',
				fileCount: parsed.files.length,
				totalSize: parsed.totalSize,
				mediaFiles: parsed.mediaFiles,
				rarInfo,
				movieId: input.movieId,
				seriesId: input.seriesId,
				createdAt: inserted.createdAt ?? now,
				expiresAt
			};
		} catch (error) {
			// Create error mount record
			const errorHash = randomUUID();
			await db.insert(nzbStreamMounts).values({
				nzbHash: errorHash,
				title: input.title,
				indexerId: input.indexerId,
				downloadUrl: input.downloadUrl,
				movieId: input.movieId,
				seriesId: input.seriesId,
				fileCount: 0,
				totalSize: 0,
				mediaFiles: [],
				status: 'error',
				errorMessage: error instanceof Error ? error.message : 'Unknown parse error'
			});

			logger.error(
				{
					title: input.title,
					error: error instanceof Error ? error.message : 'Unknown error'
				},
				'[NzbMountManager] Failed to create mount'
			);

			throw error;
		}
	}

	/**
	 * Get mount by ID.
	 */
	async getMount(id: string): Promise<MountInfo | null> {
		const result = await db
			.select()
			.from(nzbStreamMounts)
			.where(eq(nzbStreamMounts.id, id))
			.limit(1);

		if (result.length === 0) {
			return null;
		}

		const mount = result[0];
		return this.toMountInfo(mount);
	}

	/**
	 * Get mount by NZB hash.
	 */
	async getMountByHash(hash: string): Promise<MountInfo | null> {
		const result = await db
			.select()
			.from(nzbStreamMounts)
			.where(eq(nzbStreamMounts.nzbHash, hash))
			.limit(1);

		if (result.length === 0) {
			return null;
		}

		return this.toMountInfo(result[0]);
	}

	/**
	 * Update mount access time.
	 */
	async touchMount(id: string): Promise<void> {
		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + DEFAULT_EXPIRATION_MS).toISOString();

		await db
			.update(nzbStreamMounts)
			.set({
				lastAccessedAt: now,
				accessCount: sql`${nzbStreamMounts.accessCount} + 1`,
				expiresAt,
				updatedAt: now
			})
			.where(eq(nzbStreamMounts.id, id));
	}

	/**
	 * Delete a mount.
	 */
	async deleteMount(id: string): Promise<boolean> {
		// Clear segment cache for this mount
		try {
			await getSegmentCacheService().clearMountCache(id);
		} catch (error) {
			logger.warn(
				{
					mountId: id,
					error: error instanceof Error ? error.message : String(error)
				},
				'[NzbMountManager] Failed to clear segment cache'
			);
		}

		const result = await db.delete(nzbStreamMounts).where(eq(nzbStreamMounts.id, id));

		return result.changes > 0;
	}

	/**
	 * Update mount status.
	 */
	async updateStatus(
		id: string,
		status: MountStatus,
		options?: {
			streamability?: StreamabilityInfo;
			extractedFilePath?: string;
			extractionProgress?: number;
			errorMessage?: string;
		}
	): Promise<void> {
		const now = new Date().toISOString();

		const updateData: Record<string, unknown> = {
			status,
			updatedAt: now
		};

		if (options?.streamability) {
			updateData.streamability = options.streamability;
		}

		if (options?.extractedFilePath !== undefined) {
			updateData.extractedFilePath = options.extractedFilePath;
		}

		if (options?.extractionProgress !== undefined) {
			updateData.extractionProgress = options.extractionProgress;
		}

		if (options?.errorMessage !== undefined) {
			updateData.errorMessage = options.errorMessage;
		}

		await db.update(nzbStreamMounts).set(updateData).where(eq(nzbStreamMounts.id, id));

		logger.debug(
			{
				id,
				status,
				hasStreamability: !!options?.streamability
			},
			'[NzbMountManager] Updated mount status'
		);
	}

	/**
	 * Clean up expired mounts.
	 */
	async cleanupExpired(): Promise<number> {
		const now = new Date().toISOString();

		const result = await db
			.delete(nzbStreamMounts)
			.where(and(lt(nzbStreamMounts.expiresAt, now), eq(nzbStreamMounts.status, 'ready')));

		if (result.changes > 0) {
			logger.info({ count: result.changes }, '[NzbMountManager] Cleaned up expired mounts');
		}

		return result.changes;
	}

	/**
	 * Get all mounts for a movie.
	 */
	async getMountsForMovie(movieId: string): Promise<MountInfo[]> {
		const results = await db
			.select()
			.from(nzbStreamMounts)
			.where(eq(nzbStreamMounts.movieId, movieId));

		return results.map((m) => this.toMountInfo(m));
	}

	/**
	 * Get all mounts for a series.
	 */
	async getMountsForSeries(seriesId: string): Promise<MountInfo[]> {
		const results = await db
			.select()
			.from(nzbStreamMounts)
			.where(eq(nzbStreamMounts.seriesId, seriesId));

		return results.map((m) => this.toMountInfo(m));
	}

	/**
	 * Convert database row to MountInfo.
	 */
	private toMountInfo(row: typeof nzbStreamMounts.$inferSelect): MountInfo {
		// mediaFiles is stored with full segment data
		const mediaFiles = row.mediaFiles.map(
			(f) =>
				({
					index: f.index,
					name: f.name,
					poster: '',
					date: 0,
					subject: '',
					groups: f.groups || [],
					segments: f.segments.map((s) => ({
						messageId: s.messageId,
						bytes: s.bytes,
						number: s.number
					})),
					size: f.size,
					isRar: f.isRar,
					rarPartNumber: undefined
				}) as NzbFile
		);

		const rarInfo = row.rarInfo
			? {
					hasRar: true,
					isEncrypted: row.rarInfo.isEncrypted,
					partCount: row.rarInfo.innerFiles?.length ?? 0
				}
			: undefined;

		return {
			id: row.id,
			nzbHash: row.nzbHash,
			title: row.title,
			status: row.status as MountStatus,
			fileCount: row.fileCount,
			totalSize: row.totalSize,
			mediaFiles,
			rarInfo,
			streamability: row.streamability ?? undefined,
			extractedFilePath: row.extractedFilePath ?? undefined,
			extractionProgress: row.extractionProgress ?? undefined,
			movieId: row.movieId ?? undefined,
			seriesId: row.seriesId ?? undefined,
			errorMessage: row.errorMessage ?? undefined,
			createdAt: row.createdAt ?? '',
			expiresAt: row.expiresAt ?? undefined
		};
	}
}

// Singleton instance
let instance: NzbMountManager | null = null;

/**
 * Get the singleton NzbMountManager.
 */
export function getNzbMountManager(): NzbMountManager {
	if (!instance) {
		instance = new NzbMountManager();
	}
	return instance;
}
