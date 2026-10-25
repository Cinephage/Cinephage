/**
 * Stream URL Cache
 *
 * Manages cached stream URL resolutions with expiration tracking for Live TV streaming.
 * Only caches URL metadata (URL, type, headers) — does NOT open HTTP connections.
 * The actual stream fetch happens at the point of use in the route handler.
 *
 * Based on Stalkerhek pattern:
 * - HLS streams: 30 second URL cache (playlist URLs are reusable)
 * - Direct streams: 5 second URL cache (tokens expire quickly)
 * - Thread-safe with per-lineup locking to prevent concurrent resolutions
 */

import { getLiveTvStreamService } from './LiveTvStreamService.js';
import type { StreamUrlResolution } from './LiveTvStreamService.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { LiveTvProviderType } from '#lib/types/livetv.js';

const logger = createChildLogger({ logDomain: 'livetv' as const });

// Expiration timeouts (in milliseconds) - matching Stalkerhek behavior
// Stalker portals enforce ~30s session limits per play_token, so we use 20s
// to ensure we refresh the URL before the token expires
const HLS_STREAM_TIMEOUT_MS = 20_000; // 20 seconds for HLS streams
const DIRECT_STREAM_TIMEOUT_MS = 5_000; // 5 seconds for direct streams

/**
 * Cached stream entry with metadata
 */
interface CachedStream {
	url: string;
	type: 'hls' | 'direct' | 'unknown';
	providerHeaders: Record<string, string>;
	accountId: string;
	channelId: string;
	providerType: string;
	createdAt: number;
	lineupItemId: string;
	format?: 'ts' | 'hls';
}

/**
 * Stream URL Cache
 *
 * Singleton service that manages stream URL lifecycle:
 * 1. Caches resolved stream URLs with timestamps (no HTTP connections opened)
 * 2. Validates URLs before use (checks expiration)
 * 3. Refreshes expired URLs automatically
 * 4. Thread-safe per-lineup locking
 */
class StreamUrlCache {
	private cache: Map<string, CachedStream> = new Map();
	private locks: Map<string, Promise<void>> = new Map();

	/**
	 * Get or create a cached stream resolution for a lineup item.
	 * Returns URL metadata only — caller is responsible for HTTP fetch.
	 *
	 * @param lineupItemId - The lineup item ID
	 * @param format - Preferred format: 'ts' for direct MPEG-TS, 'hls' for HLS playlist (default)
	 */
	async getStream(
		lineupItemId: string,
		format: 'ts' | 'hls' = 'hls'
	): Promise<StreamUrlResolution> {
		// Include format in cache key to prevent collisions between TS and HLS requests
		const cacheKey = `${lineupItemId}:${format}`;

		// Try to use cached stream first
		const cached = this.cache.get(cacheKey);
		if (cached && this.isValid(cached)) {
			logger.debug(
				{
					lineupItemId,
					format,
					url: cached.url.substring(0, 50),
					age: Date.now() - cached.createdAt
				},
				'[StreamUrlCache] Using cached URL'
			);
			return this.toResolution(cached);
		}

		// Need to resolve fresh URL - use lock to prevent concurrent resolutions
		return this.resolveWithLock(lineupItemId, format);
	}

	/**
	 * Force refresh a stream URL (useful when current URL is known to be stale)
	 */
	async refreshStream(
		lineupItemId: string,
		format: 'ts' | 'hls' = 'hls'
	): Promise<StreamUrlResolution> {
		const cacheKey = `${lineupItemId}:${format}`;
		this.cache.delete(cacheKey);
		return this.resolveWithLock(lineupItemId, format);
	}

	/**
	 * Check if a cached stream is still valid based on age
	 */
	isValid(cached: CachedStream): boolean {
		const age = Date.now() - cached.createdAt;
		const maxAge = cached.type === 'hls' ? HLS_STREAM_TIMEOUT_MS : DIRECT_STREAM_TIMEOUT_MS;
		return age < maxAge;
	}

	/**
	 * Get cache entry without validation (for checking existence/type)
	 */
	getCached(lineupItemId: string, format: 'ts' | 'hls' = 'hls'): CachedStream | undefined {
		const cacheKey = `${lineupItemId}:${format}`;
		return this.cache.get(cacheKey);
	}

	/**
	 * Invalidate a cached stream (e.g., on error)
	 */
	invalidate(lineupItemId: string, format?: 'ts' | 'hls'): void {
		if (format) {
			const cacheKey = `${lineupItemId}:${format}`;
			this.cache.delete(cacheKey);
			logger.debug({ lineupItemId, format }, '[StreamUrlCache] Invalidated cache entry');
		} else {
			// Invalidate all formats for this lineup item
			for (const key of this.cache.keys()) {
				if (key.startsWith(`${lineupItemId}:`)) {
					this.cache.delete(key);
				}
			}
			logger.debug({ lineupItemId }, '[StreamUrlCache] Invalidated all cache entries for lineup');
		}
	}

	/**
	 * Clear all cached entries
	 */
	clear(): void {
		this.cache.clear();
		this.locks.clear();
		logger.info('[StreamUrlCache] Cache cleared');
	}

	/**
	 * Resolve stream with locking to prevent concurrent requests for same lineup
	 */
	private async resolveWithLock(
		lineupItemId: string,
		format: 'ts' | 'hls' = 'hls'
	): Promise<StreamUrlResolution> {
		// Use lineupId only for lock key (format doesn't need separate locks)
		const lockKey = lineupItemId;
		const cacheKey = `${lineupItemId}:${format}`;

		// Wait for any existing lock
		const existingLock = this.locks.get(lockKey);
		if (existingLock) {
			logger.debug({ lineupItemId, format }, '[StreamUrlCache] Waiting for existing resolution');
			await existingLock;
			// After waiting, check cache again (another request may have resolved it)
			const cached = this.cache.get(cacheKey);
			if (cached && this.isValid(cached)) {
				return this.toResolution(cached);
			}
		}

		// Create new lock
		let releaseLock: () => void;
		const lockPromise = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		this.locks.set(lockKey, lockPromise);

		try {
			// Double-check cache after acquiring lock
			const cached = this.cache.get(cacheKey);
			if (cached && this.isValid(cached)) {
				return this.toResolution(cached);
			}

			// Resolve URL only (no HTTP connection opened)
			logger.info({ lineupItemId, format }, '[StreamUrlCache] Resolving fresh stream URL');
			const streamService = getLiveTvStreamService();
			const result = await streamService.resolveStream(lineupItemId, format);

			// Cache the result
			this.cache.set(cacheKey, {
				url: result.url,
				type: result.type,
				providerHeaders: result.providerHeaders || {},
				accountId: result.accountId,
				channelId: result.channelId,
				providerType: result.providerType,
				createdAt: Date.now(),
				lineupItemId,
				format
			});

			logger.info(
				{
					lineupItemId,
					format,
					url: result.url.substring(0, 50),
					type: result.type
				},
				'[StreamUrlCache] URL resolved and cached'
			);

			return result;
		} finally {
			// Release lock
			this.locks.delete(lockKey);
			releaseLock!();
		}
	}

	/**
	 * Convert cache entry to StreamUrlResolution
	 */
	private toResolution(cached: CachedStream): StreamUrlResolution {
		return {
			url: cached.url,
			type: cached.type,
			accountId: cached.accountId,
			channelId: cached.channelId,
			lineupItemId: cached.lineupItemId,
			providerType: cached.providerType as LiveTvProviderType,
			providerHeaders: cached.providerHeaders
		};
	}
}

// Singleton instance
let cacheInstance: StreamUrlCache | null = null;

export function getStreamUrlCache(): StreamUrlCache {
	if (!cacheInstance) {
		cacheInstance = new StreamUrlCache();
	}
	return cacheInstance;
}

// Export for testing
export { StreamUrlCache, HLS_STREAM_TIMEOUT_MS, DIRECT_STREAM_TIMEOUT_MS };
