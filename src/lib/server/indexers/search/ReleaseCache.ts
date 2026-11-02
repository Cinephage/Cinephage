import type { ReleaseResult, SearchCriteria } from '../types';
import { isMovieSearch, isTvSearch, isMusicSearch, isBookSearch } from '../types';
import * as crypto from 'node:crypto';

/**
 * Cached search result entry.
 */
interface CacheEntry {
	results: ReleaseResult[];
	cachedAt: number;
	expiresAt: number;
	/** Key for LRU tracking */
	key: string;
}

/**
 * Default TTL in milliseconds (5 minutes).
 */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Cleanup interval in milliseconds (1 minute).
 */
const CLEANUP_INTERVAL_MS = 60 * 1000;

/**
 * Maximum cache entries to prevent unbounded memory growth.
 */
const DEFAULT_MAX_SIZE = 500;

/**
 * Cache version - increment when cache format changes.
 */
const CACHE_VERSION = 2;

/**
 * In-memory cache for search results with TTL expiration.
 */
export class ReleaseCache {
	private cache: Map<string, CacheEntry> = new Map();
	private ttlMs: number;
	private maxSize: number;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	/** LRU order tracking - most recently used at end */
	private accessOrder: string[] = [];

	constructor(ttlMs: number = DEFAULT_TTL_MS, maxSize: number = DEFAULT_MAX_SIZE) {
		this.ttlMs = ttlMs;
		this.maxSize = maxSize;
		this.startCleanup();
	}

	/**
	 * Generates a cache key from search criteria.
	 * Uses SHA-256 for better collision resistance and includes cache version.
	 */
	private generateKeyInternal(criteria: SearchCriteria, extra?: Record<string, unknown>): string {
		// Build normalized object based on search type
		const normalized: Record<string, unknown> = {
			_v: CACHE_VERSION, // Cache version for invalidation on format changes
			type: criteria.searchType,
			q: (criteria.query ?? '').toLowerCase().trim(),
			src: criteria.searchSource ?? '',
			c: (criteria.categories ?? []).sort().join(','),
			i: (criteria.indexerIds ?? []).sort().join(','),
			lang: (criteria.language ?? '').toLowerCase(),
			// Ordered audio preference changes ranking, so it belongs in the key
			ap: criteria.audioPreference
				? [
						criteria.audioPreference.preferOriginal ? 1 : 0,
						criteria.audioPreference.mode,
						criteria.audioPreference.originalLanguage ?? '',
						...[...criteria.audioPreference.languages].sort()
					]
				: null
		};

		// Add type-specific fields
		if (isMovieSearch(criteria)) {
			if (criteria.imdbId) normalized.imdb = criteria.imdbId;
			if (criteria.tmdbId) normalized.tmdb = criteria.tmdbId;
			if (criteria.year) normalized.year = criteria.year;
		} else if (isTvSearch(criteria)) {
			if (criteria.imdbId) normalized.imdb = criteria.imdbId;
			if (criteria.tmdbId) normalized.tmdb = criteria.tmdbId;
			if (criteria.tvdbId) normalized.tvdb = criteria.tvdbId;
			if (criteria.season !== undefined) normalized.s = criteria.season;
			if (criteria.episode !== undefined) normalized.e = criteria.episode;
		} else if (isMusicSearch(criteria)) {
			if (criteria.artist) normalized.artist = criteria.artist;
			if (criteria.album) normalized.album = criteria.album;
		} else if (isBookSearch(criteria)) {
			if (criteria.author) normalized.author = criteria.author;
			if (criteria.title) normalized.title = criteria.title;
		}

		if (extra) {
			Object.assign(normalized, extra);
		}

		const str = JSON.stringify(normalized);
		// Use SHA-256 for better collision resistance, truncated to 32 chars
		return crypto.createHash('sha256').update(str).digest('hex').substring(0, 32);
	}

	generateKey(criteria: SearchCriteria, extra?: Record<string, unknown>): string {
		return this.generateKeyInternal(criteria, extra);
	}

	/**
	 * Gets cached results if available and not expired.
	 * Updates LRU access order.
	 *
	 * `extra` must carry anything that changes which indexers were queried
	 * (protocol filter, profile indexer allowlist); otherwise a cached result
	 * set from a broader scope could be served for a narrower one.
	 */
	get(criteria: SearchCriteria, extra?: Record<string, unknown>): ReleaseResult[] | null {
		const key = this.generateKeyInternal(criteria, extra);
		const entry = this.cache.get(key);

		if (!entry) {
			return null;
		}

		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			this.removeFromAccessOrder(key);
			return null;
		}

		// Update LRU access order
		this.touchAccessOrder(key);

		return entry.results;
	}

	/**
	 * Sets cached results with LRU eviction if cache is full.
	 */
	set(criteria: SearchCriteria, results: ReleaseResult[], extra?: Record<string, unknown>): void {
		const key = this.generateKeyInternal(criteria, extra);
		const now = Date.now();

		// Evict LRU entries if at capacity
		while (this.cache.size >= this.maxSize && this.accessOrder.length > 0) {
			const lruKey = this.accessOrder.shift();
			if (lruKey) {
				this.cache.delete(lruKey);
			}
		}

		this.cache.set(key, {
			results,
			cachedAt: now,
			expiresAt: now + this.ttlMs,
			key
		});

		// Add to access order (most recent at end)
		this.touchAccessOrder(key);
	}

	/**
	 * Checks if a cache entry exists and is valid.
	 */
	has(criteria: SearchCriteria, extra?: Record<string, unknown>): boolean {
		return this.get(criteria, extra) !== null;
	}

	/**
	 * Invalidates a specific cache entry.
	 */
	invalidate(criteria: SearchCriteria, extra?: Record<string, unknown>): boolean {
		const key = this.generateKeyInternal(criteria, extra);
		this.removeFromAccessOrder(key);
		return this.cache.delete(key);
	}

	/**
	 * Clears all cached entries.
	 */
	clear(): void {
		this.cache.clear();
		this.accessOrder = [];
	}

	/**
	 * Move key to end of access order (most recently used).
	 */
	private touchAccessOrder(key: string): void {
		const idx = this.accessOrder.indexOf(key);
		if (idx !== -1) {
			this.accessOrder.splice(idx, 1);
		}
		this.accessOrder.push(key);
	}

	/**
	 * Remove key from access order.
	 */
	private removeFromAccessOrder(key: string): void {
		const idx = this.accessOrder.indexOf(key);
		if (idx !== -1) {
			this.accessOrder.splice(idx, 1);
		}
	}

	/**
	 * Gets cache statistics.
	 */
	getStats(): {
		size: number;
		oldestEntry: number | null;
		newestEntry: number | null;
	} {
		let oldest: number | null = null;
		let newest: number | null = null;

		for (const entry of this.cache.values()) {
			if (oldest === null || entry.cachedAt < oldest) {
				oldest = entry.cachedAt;
			}
			if (newest === null || entry.cachedAt > newest) {
				newest = entry.cachedAt;
			}
		}

		return {
			size: this.cache.size,
			oldestEntry: oldest,
			newestEntry: newest
		};
	}

	/**
	 * Removes expired entries from the cache.
	 */
	cleanup(): number {
		const now = Date.now();
		let removed = 0;

		for (const [key, entry] of this.cache.entries()) {
			if (now > entry.expiresAt) {
				this.cache.delete(key);
				this.removeFromAccessOrder(key);
				removed++;
			}
		}

		return removed;
	}

	/**
	 * Starts the automatic cleanup timer.
	 */
	private startCleanup(): void {
		if (this.cleanupTimer) return;

		this.cleanupTimer = setInterval(() => {
			this.cleanup();
		}, CLEANUP_INTERVAL_MS);

		// Prevent timer from keeping the process alive
		if (this.cleanupTimer.unref) {
			this.cleanupTimer.unref();
		}
	}

	/**
	 * Stops the automatic cleanup timer.
	 */
	stopCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	/**
	 * Updates the TTL for new entries.
	 */
	setTTL(ttlMs: number): void {
		this.ttlMs = ttlMs;
	}

	/**
	 * Gets the current TTL in milliseconds.
	 */
	getTTL(): number {
		return this.ttlMs;
	}
}

/**
 * Singleton cache instance.
 */
let cacheInstance: ReleaseCache | null = null;

/**
 * Gets the singleton cache instance.
 */
export function getReleaseCache(): ReleaseCache {
	if (!cacheInstance) {
		cacheInstance = new ReleaseCache();
	}
	return cacheInstance;
}

/**
 * Resets the singleton cache (useful for testing).
 */
export function resetReleaseCache(): void {
	if (cacheInstance) {
		cacheInstance.stopCleanup();
		cacheInstance.clear();
	}
	cacheInstance = null;
}
