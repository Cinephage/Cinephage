/**
 * SegmentCacheService - Persistent storage for pre-fetched critical segments.
 *
 * Stores decoded segment data in the database to enable fast FFmpeg probing.
 * Without this, Jellyfin's FFmpeg must fetch segments on-demand to read MKV
 * headers and Cues, causing 1-2 minute playback delays.
 *
 * The service prefetches:
 * - Segment 0: MKV EBML header (~700KB)
 * - Last 2-3 segments: MKV Cues/SeekHead (~2MB)
 *
 * These survive app restarts since they're stored in SQLite.
 */

import { randomUUID } from 'node:crypto';
import { db } from '#lib/server/db/index.js';
import { nzbSegmentCache } from '#lib/server/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import type { NzbFile } from './types';

const logger = createChildLogger({
	logDomain: 'streams' as const,
	component: 'SegmentCacheService'
});
import { getNntpManager } from './NntpManager';

/**
 * Number of segments to prefetch from the end of the file.
 * MKV Cues are typically in the last 1-3 segments.
 */
const TAIL_SEGMENTS_COUNT = 3;

/**
 * SegmentCacheService manages persistent storage of prefetched segments.
 */
class SegmentCacheService {
	/**
	 * Cache a segment in the database.
	 */
	async cacheSegment(
		mountId: string,
		fileIndex: number,
		segmentIndex: number,
		data: Buffer
	): Promise<void> {
		try {
			// Use upsert pattern - insert or replace on conflict
			await db
				.insert(nzbSegmentCache)
				.values({
					id: randomUUID(),
					mountId,
					fileIndex,
					segmentIndex,
					data,
					size: data.length,
					createdAt: new Date().toISOString()
				})
				.onConflictDoUpdate({
					target: [
						nzbSegmentCache.mountId,
						nzbSegmentCache.fileIndex,
						nzbSegmentCache.segmentIndex
					],
					set: {
						data,
						size: data.length,
						createdAt: new Date().toISOString()
					}
				});
		} catch (error) {
			logger.warn(
				{
					mountId,
					fileIndex,
					segmentIndex,
					err: error,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to persist prefetched segment'
			);
		}
	}

	/**
	 * Get a cached segment from the database.
	 * Returns null if not found.
	 */
	async getCachedSegment(
		mountId: string,
		fileIndex: number,
		segmentIndex: number
	): Promise<Buffer | null> {
		try {
			const result = await db
				.select({ data: nzbSegmentCache.data })
				.from(nzbSegmentCache)
				.where(
					and(
						eq(nzbSegmentCache.mountId, mountId),
						eq(nzbSegmentCache.fileIndex, fileIndex),
						eq(nzbSegmentCache.segmentIndex, segmentIndex)
					)
				)
				.limit(1);

			if (result.length > 0 && result[0].data) {
				return result[0].data;
			}
			return null;
		} catch (error) {
			logger.warn(
				{
					mountId,
					fileIndex,
					segmentIndex,
					err: error,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to load cached segment'
			);
			return null;
		}
	}

	/**
	 * Check if a segment is cached.
	 */
	async isSegmentCached(
		mountId: string,
		fileIndex: number,
		segmentIndex: number
	): Promise<boolean> {
		try {
			const result = await db
				.select({ id: nzbSegmentCache.id })
				.from(nzbSegmentCache)
				.where(
					and(
						eq(nzbSegmentCache.mountId, mountId),
						eq(nzbSegmentCache.fileIndex, fileIndex),
						eq(nzbSegmentCache.segmentIndex, segmentIndex)
					)
				)
				.limit(1);

			return result.length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Prefetch critical segments for a file (first + last N segments).
	 * This is called after mount creation to ensure fast FFmpeg probing.
	 */
	async prefetchCriticalSegments(mountId: string, fileIndex: number, file: NzbFile): Promise<void> {
		const totalSegments = file.segments.length;
		if (totalSegments === 0) {
			logger.warn({ mountId, fileIndex }, 'No segments available for prefetch');
			return;
		}

		// Determine which segments to prefetch
		const segmentsToFetch: number[] = [];

		// Always fetch segment 0 (MKV header)
		segmentsToFetch.push(0);

		// Fetch last N segments (MKV Cues/SeekHead)
		for (let i = 1; i <= TAIL_SEGMENTS_COUNT; i++) {
			const tailIndex = totalSegments - i;
			if (tailIndex > 0) {
				// Don't duplicate segment 0
				segmentsToFetch.push(tailIndex);
			}
		}

		logger.info(
			{
				mountId,
				fileIndex,
				fileName: file.name,
				totalSegments,
				prefetchSegments: segmentsToFetch
			},
			'Starting critical usenet segment prefetch'
		);

		const nntpManager = getNntpManager();
		if (!nntpManager.isReady) {
			logger.warn({ mountId, fileIndex }, 'NNTP manager is not ready, skipping segment prefetch');
			return;
		}

		let successCount = 0;
		let failCount = 0;

		// Fetch segments in parallel
		const fetchPromises = segmentsToFetch.map(async (segmentIndex) => {
			try {
				// Check if already cached
				const isCached = await this.isSegmentCached(mountId, fileIndex, segmentIndex);
				if (isCached) {
					logger.debug(
						{
							mountId,
							fileIndex,
							segmentIndex
						},
						'Segment already present in persistent cache'
					);
					successCount++;
					return;
				}

				// Fetch from NNTP
				const segment = file.segments[segmentIndex];
				if (!segment) {
					logger.warn(
						{
							mountId,
							fileIndex,
							segmentIndex
						},
						'Segment index was not found in NZB file metadata'
					);
					failCount++;
					return;
				}

				const result = await nntpManager.getDecodedArticle(segment.messageId);

				// Store in database
				await this.cacheSegment(mountId, fileIndex, segmentIndex, result.data);

				logger.debug(
					{
						mountId,
						fileIndex,
						segmentIndex,
						sizeBytes: result.data.length
					},
					'Prefetched and cached critical segment'
				);
				successCount++;
			} catch (error) {
				logger.warn(
					{
						mountId,
						fileIndex,
						segmentIndex,
						err: error,
						error: error instanceof Error ? error.message : String(error)
					},
					'Failed to prefetch critical segment'
				);
				failCount++;
			}
		});

		await Promise.allSettled(fetchPromises);

		logger.info(
			{
				mountId,
				fileIndex,
				fileName: file.name,
				successCount,
				failCount
			},
			'Completed critical usenet segment prefetch'
		);
	}

	/**
	 * Clear all cached segments for a mount.
	 * Called when mount is deleted.
	 */
	async clearMountCache(mountId: string): Promise<void> {
		try {
			await db.delete(nzbSegmentCache).where(eq(nzbSegmentCache.mountId, mountId));

			logger.debug(
				{
					mountId
					// Note: result.changes would give count but not available in all cases
				},
				'Cleared persistent segment cache for mount'
			);
		} catch (error) {
			logger.warn(
				{
					mountId,
					err: error,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to clear persistent segment cache for mount'
			);
		}
	}

	/**
	 * Get cache statistics.
	 */
	async getStats(): Promise<{
		totalSegments: number;
		totalSizeBytes: number;
		mountCount: number;
	}> {
		try {
			const result = await db
				.select({
					count: nzbSegmentCache.id,
					size: nzbSegmentCache.size,
					mountId: nzbSegmentCache.mountId
				})
				.from(nzbSegmentCache);

			const mountIds = new Set(result.map((r) => r.mountId));
			const totalSize = result.reduce((acc, r) => acc + (r.size || 0), 0);

			return {
				totalSegments: result.length,
				totalSizeBytes: totalSize,
				mountCount: mountIds.size
			};
		} catch {
			return {
				totalSegments: 0,
				totalSizeBytes: 0,
				mountCount: 0
			};
		}
	}
}

// Singleton instance
let instance: SegmentCacheService | null = null;

/**
 * Get the singleton SegmentCacheService instance.
 */
export function getSegmentCacheService(): SegmentCacheService {
	if (!instance) {
		instance = new SegmentCacheService();
	}
	return instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetSegmentCacheService(): void {
	instance = null;
}

export { SegmentCacheService };
