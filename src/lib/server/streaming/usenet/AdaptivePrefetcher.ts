/**
 * AdaptivePrefetcher - Smart prefetch with pattern detection.
 *
 * Key features:
 * - Detects access patterns (sequential vs random/seeking)
 * - Adjusts prefetch window based on pattern
 * - Respects backpressure signals
 * - Cancels irrelevant prefetches on seek
 * - Checks persistent DB cache before NNTP fetch
 */

import { createChildLogger } from '#lib/logging/index.js';
import type { NntpManager } from './NntpManager';

const logger = createChildLogger({ logDomain: 'streams' as const });
import { SegmentStore } from './SegmentStore';
import { getSegmentCacheService } from './SegmentCacheService';
import type { AccessPattern, PrefetchStrategy } from './types';

/**
 * Prefetcher configuration.
 */
export interface AdaptivePrefetcherConfig {
	strategies: Record<AccessPattern, PrefetchStrategy>;
	patternWindowSize: number; // How many requests to consider for pattern detection
	sequentialThreshold: number; // % of requests that must be sequential
}

const DEFAULT_CONFIG: AdaptivePrefetcherConfig = {
	strategies: {
		sequential: { windowSize: 10, priority: 'high' },
		random: { windowSize: 2, priority: 'low' },
		idle: { windowSize: 5, priority: 'background' }
	},
	patternWindowSize: 5,
	sequentialThreshold: 0.8 // 80% must be sequential
};

/**
 * Access record for pattern detection.
 */
interface AccessRecord {
	segmentIndex: number;
	timestamp: number;
}

/**
 * Pending prefetch operation.
 */
interface PendingFetch {
	segmentIndex: number;
	promise: Promise<Buffer>;
	aborted: boolean;
}

/**
 * AdaptivePrefetcher manages intelligent segment prefetching.
 */
export class AdaptivePrefetcher {
	private config: AdaptivePrefetcherConfig;
	private nntpManager: NntpManager;
	private store: SegmentStore;
	private mountId: string | null;
	private fileIndex: number | null;
	private accessHistory: AccessRecord[] = [];
	private pendingFetches: Map<number, PendingFetch> = new Map();
	private paused = false;
	private currentPattern: AccessPattern = 'idle';
	private lastAccessIndex = -1;

	constructor(
		nntpManager: NntpManager,
		store: SegmentStore,
		config?: Partial<AdaptivePrefetcherConfig>,
		mountId?: string,
		fileIndex?: number
	) {
		this.nntpManager = nntpManager;
		this.store = store;
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.mountId = mountId ?? null;
		this.fileIndex = fileIndex ?? null;
	}

	/**
	 * Get current detected access pattern.
	 */
	get pattern(): AccessPattern {
		return this.currentPattern;
	}

	/**
	 * Get current prefetch strategy.
	 */
	get strategy(): PrefetchStrategy {
		return this.config.strategies[this.currentPattern];
	}

	/**
	 * Get prefetch statistics.
	 */
	get stats(): {
		pattern: AccessPattern;
		windowSize: number;
		pending: number;
		paused: boolean;
	} {
		return {
			pattern: this.currentPattern,
			windowSize: this.strategy.windowSize,
			pending: this.pendingFetches.size,
			paused: this.paused
		};
	}

	/**
	 * Pause prefetching (for backpressure).
	 */
	pause(): void {
		this.paused = true;
		logger.debug(
			{ mountId: this.mountId, fileIndex: this.fileIndex },
			'Paused adaptive prefetching'
		);
	}

	/**
	 * Resume prefetching.
	 */
	resume(): void {
		this.paused = false;
		logger.debug(
			{ mountId: this.mountId, fileIndex: this.fileIndex },
			'Resumed adaptive prefetching'
		);
	}

	/**
	 * Get a segment, fetching from NNTP if not cached.
	 * Records access for pattern detection and triggers prefetch.
	 * Checks both in-memory cache and persistent DB cache.
	 */
	async getSegment(index: number): Promise<Buffer> {
		// Record access
		this.recordAccess(index);

		// Check in-memory cache first (fastest)
		const cached = this.store.getCachedSegment(index);
		if (cached) {
			// Still trigger prefetch for next segments
			this.triggerPrefetch(index);
			return cached;
		}

		// Check persistent DB cache (survives restarts)
		if (this.mountId && this.fileIndex !== null) {
			try {
				const dbCached = await getSegmentCacheService().getCachedSegment(
					this.mountId,
					this.fileIndex,
					index
				);
				if (dbCached) {
					logger.debug(
						{
							mountId: this.mountId,
							fileIndex: this.fileIndex,
							segmentIndex: index,
							sizeBytes: dbCached.length
						},
						'Loaded segment from persistent cache'
					);
					// Also cache in memory for faster subsequent access
					this.store.cacheSegment(index, dbCached);
					this.triggerPrefetch(index);
					return dbCached;
				}
			} catch (error) {
				// DB cache miss or error - fall through to NNTP fetch
				logger.debug(
					{
						mountId: this.mountId,
						fileIndex: this.fileIndex,
						segmentIndex: index,
						err: error,
						error: error instanceof Error ? error.message : 'Unknown'
					},
					'Persistent segment cache lookup failed'
				);
			}
		}

		// Check if already being fetched
		const pending = this.pendingFetches.get(index);
		if (pending && !pending.aborted) {
			return pending.promise;
		}

		// Fetch the segment from NNTP
		const data = await this.fetchSegment(index);

		// Trigger prefetch for next segments
		this.triggerPrefetch(index);

		return data;
	}

	/**
	 * Notify of a seek operation.
	 * Cancels irrelevant prefetches and adjusts pattern.
	 */
	onSeek(newIndex: number): void {
		// Record as a random access (big jump)
		if (Math.abs(newIndex - this.lastAccessIndex) > 5) {
			this.currentPattern = 'random';
		}

		// Cancel prefetches that are now irrelevant
		const strategy = this.config.strategies[this.currentPattern];
		const relevantMin = newIndex - 2;
		const relevantMax = newIndex + strategy.windowSize + 2;

		for (const [idx, fetch] of this.pendingFetches) {
			if (idx < relevantMin || idx > relevantMax) {
				fetch.aborted = true;
				this.pendingFetches.delete(idx);
			}
		}

		// Optionally clear cache outside window
		this.store.invalidateOutsideWindow(newIndex, strategy.windowSize * 2);

		logger.debug(
			{
				mountId: this.mountId,
				fileIndex: this.fileIndex,
				from: this.lastAccessIndex,
				to: newIndex,
				pattern: this.currentPattern,
				cancelledPrefetches: this.pendingFetches.size
			},
			'Detected seek and adjusted adaptive prefetch window'
		);

		this.lastAccessIndex = newIndex;
	}

	/**
	 * Clear all pending fetches.
	 */
	clear(): void {
		for (const fetch of this.pendingFetches.values()) {
			fetch.aborted = true;
		}
		this.pendingFetches.clear();
		this.accessHistory = [];
	}

	/**
	 * Record a segment access for pattern detection.
	 */
	private recordAccess(index: number): void {
		const record: AccessRecord = {
			segmentIndex: index,
			timestamp: Date.now()
		};

		this.accessHistory.push(record);

		// Keep only recent history
		if (this.accessHistory.length > this.config.patternWindowSize * 2) {
			this.accessHistory = this.accessHistory.slice(-this.config.patternWindowSize);
		}

		// Detect pattern
		this.detectPattern();
		this.lastAccessIndex = index;
	}

	/**
	 * Detect access pattern from recent history.
	 */
	private detectPattern(): void {
		if (this.accessHistory.length < 3) {
			this.currentPattern = 'idle';
			return;
		}

		// Count sequential accesses (diff of 0 or 1)
		let sequentialCount = 0;
		const recent = this.accessHistory.slice(-this.config.patternWindowSize);

		for (let i = 1; i < recent.length; i++) {
			const diff = recent[i].segmentIndex - recent[i - 1].segmentIndex;
			if (diff >= 0 && diff <= 1) {
				sequentialCount++;
			}
		}

		const sequentialRatio = sequentialCount / (recent.length - 1);

		if (sequentialRatio >= this.config.sequentialThreshold) {
			this.currentPattern = 'sequential';
		} else if (sequentialRatio < 0.3) {
			this.currentPattern = 'random';
		} else {
			this.currentPattern = 'idle';
		}
	}

	/**
	 * Trigger prefetch for segments ahead of current position.
	 */
	private triggerPrefetch(currentIndex: number): void {
		if (this.paused) return;

		const strategy = this.config.strategies[this.currentPattern];

		for (let i = 1; i <= strategy.windowSize; i++) {
			const nextIndex = currentIndex + i;

			// Don't prefetch past end
			if (nextIndex >= this.store.segmentCount) break;

			// Skip if already cached or being fetched
			if (this.store.isSegmentCached(nextIndex)) continue;
			if (this.pendingFetches.has(nextIndex)) continue;

			// Start prefetch (fire and forget, errors logged)
			this.prefetchSegment(nextIndex);
		}
	}

	/**
	 * Prefetch a segment in the background.
	 */
	private prefetchSegment(index: number): void {
		const segment = this.store.getSegment(index);
		if (!segment) return;

		const fetchPromise = this.nntpManager
			.getDecodedArticle(segment.messageId)
			.then((result) => {
				const pending = this.pendingFetches.get(index);
				if (pending && !pending.aborted) {
					this.store.cacheSegment(index, result.data);
				}
				return result.data;
			})
			.catch((error) => {
				logger.debug(
					{
						mountId: this.mountId,
						fileIndex: this.fileIndex,
						segmentIndex: index,
						err: error,
						error: error instanceof Error ? error.message : 'Unknown'
					},
					'Background segment prefetch failed'
				);
				throw error;
			})
			.finally(() => {
				this.pendingFetches.delete(index);
			});

		this.pendingFetches.set(index, {
			segmentIndex: index,
			promise: fetchPromise,
			aborted: false
		});
	}

	/**
	 * Fetch a segment directly (not as prefetch).
	 */
	private async fetchSegment(index: number): Promise<Buffer> {
		const segment = this.store.getSegment(index);
		if (!segment) {
			throw new Error(`Segment ${index} not found`);
		}

		// Create fetch promise
		const fetchPromise = this.nntpManager.getDecodedArticle(segment.messageId).then((result) => {
			this.store.cacheSegment(index, result.data);
			return result.data;
		});

		// Track as pending
		this.pendingFetches.set(index, {
			segmentIndex: index,
			promise: fetchPromise,
			aborted: false
		});

		try {
			return await fetchPromise;
		} finally {
			this.pendingFetches.delete(index);
		}
	}
}
