/**
 * SegmentStore - Manages segment metadata and decoded data cache.
 *
 * Key responsibilities:
 * - Track segment metadata with estimated and actual sizes
 * - Build accurate byte-to-segment mapping as segments are decoded
 * - Cache decoded segment data with LRU eviction
 * - Map byte offsets to segments for Range request support
 */

import { createChildLogger } from '#lib/logging/index.js';
import type { NzbSegment, SegmentDecodeInfo } from './types';

const logger = createChildLogger({ logDomain: 'streams' as const });

/**
 * Cached decoded segment.
 */
interface CachedSegment {
	data: Buffer;
	timestamp: number;
	accessCount: number;
}

/**
 * Segment location for a given byte offset.
 */
export interface SegmentLocation {
	segmentIndex: number;
	offsetInSegment: number;
	segment: NzbSegment;
}

/**
 * Store configuration.
 */
export interface SegmentStoreConfig {
	maxCachedSegments: number;
	cacheTtlMs: number;
}

const DEFAULT_CONFIG: SegmentStoreConfig = {
	maxCachedSegments: 30, // ~21MB at 700KB/segment
	cacheTtlMs: 2 * 60 * 1000 // 2 minutes
};

/**
 * SegmentStore manages segment metadata and cached data.
 */
export class SegmentStore {
	private config: SegmentStoreConfig;
	private segments: NzbSegment[];
	private decodeInfo: SegmentDecodeInfo[];
	private cache: Map<number, CachedSegment> = new Map();

	// Offset tracking - rebuilds as segments are decoded
	private estimatedTotalSize: number;
	private actualTotalSize: number | null = null;

	constructor(segments: NzbSegment[], config?: Partial<SegmentStoreConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.segments = segments;

		// Initialize decode info with estimates
		let estimatedOffset = 0;
		this.decodeInfo = segments.map((seg) => {
			const info: SegmentDecodeInfo = {
				estimatedSize: seg.bytes,
				actualSize: null,
				estimatedOffset,
				actualOffset: null
			};
			estimatedOffset += seg.bytes;
			return info;
		});

		this.estimatedTotalSize = estimatedOffset;

		logger.debug(
			{
				segmentCount: segments.length,
				estimatedTotalSize: this.estimatedTotalSize
			},
			'[SegmentStore] Initialized'
		);
	}

	/**
	 * Get total size (actual if all decoded, otherwise estimated).
	 */
	get totalSize(): number {
		return this.actualTotalSize ?? this.estimatedTotalSize;
	}

	/**
	 * Get segment count.
	 */
	get segmentCount(): number {
		return this.segments.length;
	}

	/**
	 * Get cache statistics.
	 */
	get cacheStats(): { cached: number; maxSize: number } {
		return {
			cached: this.cache.size,
			maxSize: this.config.maxCachedSegments
		};
	}

	/**
	 * Get segment by index.
	 */
	getSegment(index: number): NzbSegment | undefined {
		return this.segments[index];
	}

	/**
	 * Get all segments.
	 */
	getAllSegments(): NzbSegment[] {
		return this.segments;
	}

	/**
	 * Find which segment contains a given byte offset.
	 */
	findSegmentForOffset(byteOffset: number): SegmentLocation | null {
		if (byteOffset < 0 || byteOffset >= this.totalSize) {
			return null;
		}

		// Use actual offsets where available, fall back to estimates
		let currentOffset = 0;

		for (let i = 0; i < this.segments.length; i++) {
			const info = this.decodeInfo[i];
			const segmentSize = info.actualSize ?? info.estimatedSize;
			const nextOffset = currentOffset + segmentSize;

			if (byteOffset < nextOffset) {
				return {
					segmentIndex: i,
					offsetInSegment: byteOffset - currentOffset,
					segment: this.segments[i]
				};
			}

			currentOffset = nextOffset;
		}

		return null;
	}

	/**
	 * Get the byte offset for a segment index.
	 */
	getSegmentOffset(index: number): number {
		if (index < 0 || index >= this.segments.length) {
			return 0;
		}

		let offset = 0;
		for (let i = 0; i < index; i++) {
			const info = this.decodeInfo[i];
			offset += info.actualSize ?? info.estimatedSize;
		}

		return offset;
	}

	/**
	 * Get estimated or actual size for a segment.
	 */
	getSegmentSize(index: number): number {
		if (index < 0 || index >= this.segments.length) {
			return 0;
		}

		const info = this.decodeInfo[index];
		return info.actualSize ?? info.estimatedSize;
	}

	/**
	 * Update segment with actual decoded size.
	 * Triggers recalculation of subsequent offsets.
	 */
	updateDecodedSize(index: number, actualSize: number): void {
		if (index < 0 || index >= this.segments.length) {
			return;
		}

		const info = this.decodeInfo[index];
		if (info.actualSize === null) {
			info.actualSize = actualSize;

			// Check if all segments have actual sizes
			this.checkTotalSizeComplete();

			logger.debug(
				{
					index,
					estimated: info.estimatedSize,
					actual: actualSize,
					diff: actualSize - info.estimatedSize
				},
				'[SegmentStore] Updated segment size'
			);
		}
	}

	/**
	 * Cache decoded segment data.
	 */
	cacheSegment(index: number, data: Buffer): void {
		// Evict if cache is full
		if (this.cache.size >= this.config.maxCachedSegments) {
			this.evictOldest();
		}

		this.cache.set(index, {
			data,
			timestamp: Date.now(),
			accessCount: 1
		});

		// Update decode info
		this.updateDecodedSize(index, data.length);
	}

	/**
	 * Get cached segment data.
	 */
	getCachedSegment(index: number): Buffer | null {
		const cached = this.cache.get(index);
		if (!cached) {
			return null;
		}

		// Check TTL
		if (Date.now() - cached.timestamp > this.config.cacheTtlMs) {
			this.cache.delete(index);
			return null;
		}

		cached.accessCount++;
		cached.timestamp = Date.now(); // Refresh on access
		return cached.data;
	}

	/**
	 * Check if segment is cached.
	 */
	isSegmentCached(index: number): boolean {
		const cached = this.cache.get(index);
		if (!cached) return false;

		// Check TTL
		if (Date.now() - cached.timestamp > this.config.cacheTtlMs) {
			this.cache.delete(index);
			return false;
		}

		return true;
	}

	/**
	 * Invalidate cache entries outside a window around the current position.
	 * Useful when seeking to avoid holding irrelevant data.
	 */
	invalidateOutsideWindow(centerIndex: number, windowSize: number): void {
		const minIndex = Math.max(0, centerIndex - windowSize);
		const maxIndex = Math.min(this.segments.length - 1, centerIndex + windowSize);

		for (const index of this.cache.keys()) {
			if (index < minIndex || index > maxIndex) {
				this.cache.delete(index);
			}
		}
	}

	/**
	 * Clear all cached segments.
	 */
	clearCache(): void {
		this.cache.clear();
	}

	/**
	 * Clean up expired cache entries.
	 */
	cleanupExpired(): number {
		const now = Date.now();
		let cleaned = 0;

		for (const [index, cached] of this.cache) {
			if (now - cached.timestamp > this.config.cacheTtlMs) {
				this.cache.delete(index);
				cleaned++;
			}
		}

		return cleaned;
	}

	/**
	 * Evict oldest/least-accessed segments from cache.
	 */
	private evictOldest(): void {
		// Sort by access count (ascending) then timestamp (ascending)
		const entries = Array.from(this.cache.entries()).sort((a, b) => {
			if (a[1].accessCount !== b[1].accessCount) {
				return a[1].accessCount - b[1].accessCount;
			}
			return a[1].timestamp - b[1].timestamp;
		});

		// Evict oldest 50%
		const toEvict = Math.ceil(this.config.maxCachedSegments / 2);
		for (let i = 0; i < toEvict && i < entries.length; i++) {
			this.cache.delete(entries[i][0]);
		}

		logger.debug({ evicted: toEvict }, '[SegmentStore] Evicted cache entries');
	}

	/**
	 * Check if all segments have actual sizes and update total.
	 */
	private checkTotalSizeComplete(): void {
		const allDecoded = this.decodeInfo.every((info) => info.actualSize !== null);

		if (allDecoded) {
			this.actualTotalSize = this.decodeInfo.reduce(
				(sum, info) => sum + (info.actualSize ?? info.estimatedSize),
				0
			);

			logger.debug(
				{
					estimatedTotal: this.estimatedTotalSize,
					actualTotal: this.actualTotalSize,
					diff: this.actualTotalSize - this.estimatedTotalSize
				},
				'[SegmentStore] All segments decoded'
			);
		}
	}

	/**
	 * Get decode progress (percentage of segments with actual sizes).
	 */
	getDecodeProgress(): number {
		const decoded = this.decodeInfo.filter((info) => info.actualSize !== null).length;
		return decoded / this.segments.length;
	}
}
