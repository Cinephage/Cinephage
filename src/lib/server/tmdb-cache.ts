/**
 * TMDB Response Cache
 *
 * LRU in-memory cache for TMDB API responses to reduce API calls
 * and improve response times for frequently accessed data.
 */

import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

interface CacheEntry<T> {
	data: T;
	timestamp: number;
	ttlMs: number;
}

/**
 * TTL configuration in milliseconds
 */
const TTL = {
	/** Movie/TV details - ratings change frequently */
	DETAILS: 5 * 60 * 1000, // 5 minutes
	/** Person details - bio/credits rarely change */
	PERSON: 60 * 60 * 1000, // 1 hour
	/** Search results - more dynamic */
	SEARCH: 2 * 60 * 1000, // 2 minutes
	/** Discover results - constantly changing */
	DISCOVER: 60 * 1000, // 1 minute
	/** External IDs - never change */
	EXTERNAL_IDS: 24 * 60 * 60 * 1000, // 24 hours
	/** Season data */
	SEASON: 10 * 60 * 1000, // 10 minutes
	/** Collection data */
	COLLECTION: 10 * 60 * 1000, // 10 minutes
	UPCOMING: 60 * 60 * 1000 // 1 hour
} as const;

/**
 * How long past its TTL an entry may still be served while a refresh runs.
 * TMDB lists and details change slowly; a day-old trending row is far better
 * than a page that waits seconds on a cold cache after a short break.
 */
const STALE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Determine TTL based on endpoint pattern
 */
function getTtlForEndpoint(endpoint: string): number {
	if (endpoint.includes('/external_ids')) {
		return TTL.EXTERNAL_IDS;
	}
	if (endpoint.includes('/person/')) {
		return TTL.PERSON;
	}
	if (endpoint.includes('/search/')) {
		return TTL.SEARCH;
	}
	if (endpoint.includes('/discover/')) {
		return TTL.DISCOVER;
	}
	if (endpoint.includes('/season/')) {
		return TTL.SEASON;
	}
	if (endpoint.includes('/collection/')) {
		return TTL.COLLECTION;
	}
	if (endpoint.includes('/now_playing') || endpoint.includes('/upcoming')) {
		return TTL.UPCOMING;
	}
	// Default for movie/tv details
	return TTL.DETAILS;
}

export class TmdbCache {
	private cache = new Map<string, CacheEntry<unknown>>();
	private maxSize: number;
	private hits = 0;
	private misses = 0;

	constructor(maxSize = 500) {
		this.maxSize = maxSize;
	}

	/**
	 * Get cached value if exists and not expired
	 */
	get<T>(key: string): T | null {
		const hit = this.lookup<T>(key);
		return hit && !hit.stale ? hit.data : null;
	}

	/**
	 * Stale-while-revalidate read. A fresh entry comes back with
	 * `stale: false`; an entry past its TTL but within STALE_WINDOW_MS comes
	 * back with `stale: true`, so the caller can answer with it at once and
	 * refresh it in the background instead of making the user wait on TMDB.
	 * Anything older is dropped and reads as a miss.
	 */
	lookup<T>(key: string): { data: T; stale: boolean } | null {
		const entry = this.cache.get(key);
		if (!entry) {
			this.misses++;
			return null;
		}

		const age = Date.now() - entry.timestamp;
		if (age > entry.ttlMs + STALE_WINDOW_MS) {
			this.cache.delete(key);
			this.misses++;
			return null;
		}
		const stale = age > entry.ttlMs;

		// Move to end for LRU behavior (Map maintains insertion order)
		this.cache.delete(key);
		this.cache.set(key, entry);
		this.hits++;
		return { data: entry.data as T, stale };
	}

	/**
	 * Cache a value with endpoint-appropriate TTL
	 */
	set<T>(key: string, data: T, endpoint: string): void {
		// Evict oldest entry if at capacity (a refresh of an existing key
		// replaces it in place and needs no room)
		if (!this.cache.has(key) && this.cache.size >= this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey) {
				this.cache.delete(firstKey);
			}
		}

		const ttlMs = getTtlForEndpoint(endpoint);
		this.cache.set(key, {
			data,
			timestamp: Date.now(),
			ttlMs
		});
	}

	/**
	 * Invalidate cache entries matching a pattern
	 */
	invalidate(pattern?: string): number {
		if (!pattern) {
			const size = this.cache.size;
			this.cache.clear();
			logger.debug({ entriesRemoved: size }, '[TmdbCache] Cleared entire cache');
			return size;
		}

		let removed = 0;
		for (const key of this.cache.keys()) {
			if (key.includes(pattern)) {
				this.cache.delete(key);
				removed++;
			}
		}

		if (removed > 0) {
			logger.debug({ pattern, entriesRemoved: removed }, '[TmdbCache] Invalidated entries');
		}

		return removed;
	}

	/**
	 * Get cache statistics
	 */
	getStats(): { size: number; maxSize: number; hits: number; misses: number; hitRate: string } {
		const total = this.hits + this.misses;
		const hitRate = total > 0 ? ((this.hits / total) * 100).toFixed(1) + '%' : '0%';

		return {
			size: this.cache.size,
			maxSize: this.maxSize,
			hits: this.hits,
			misses: this.misses,
			hitRate
		};
	}

	/**
	 * Reset statistics counters
	 */
	resetStats(): void {
		this.hits = 0;
		this.misses = 0;
	}
}

/**
 * Singleton cache instance
 */
export const tmdbCache = new TmdbCache();

/**
 * Generate a cache key for a TMDB request
 */
export function getCacheKey(
	endpoint: string,
	skipFilters: boolean,
	language?: string,
	skipKeywordBlocklist = false,
	region?: string
): string {
	return `tmdb:${endpoint}:${language ?? 'default'}:${region ?? 'default'}:${skipFilters}:${skipKeywordBlocklist}`;
}
