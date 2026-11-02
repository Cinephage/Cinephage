/**
 * NntpManager - Multi-provider NNTP orchestration layer.
 *
 * Manages multiple NNTP provider pools with:
 * - Provider failover based on health and priority
 * - Global decoded article cache
 * - Request deduplication (same article ID)
 * - Automatic provider reloading
 */

import type { BackgroundService, ServiceStatus } from '#lib/server/services/background-service.js';
import { createChildLogger } from '#lib/logging/index.js';
import { getNntpServerService } from '../nzb/NntpServerService';

const logger = createChildLogger({ logDomain: 'streams' as const, component: 'NntpManager' });
import { NntpPool } from './NntpPool';
import { decodeYenc, extractYencHeader } from './YencDecoder';
import type { NntpServerConfig, YencDecodeResult, YencHeader, ProviderHealth } from './types';

/**
 * Article not found on any provider.
 */
export class ArticleNotFoundError extends Error {
	constructor(messageId: string, details?: string) {
		super(`Article not found: ${messageId}${details ? ` (${details})` : ''}`);
		this.name = 'ArticleNotFoundError';
	}
}

/**
 * Cached decoded article.
 */
interface CachedArticle {
	result: YencDecodeResult;
	timestamp: number;
	accessCount: number;
}

/**
 * In-flight request for deduplication.
 */
interface InFlightRequest {
	promise: Promise<YencDecodeResult>;
	timestamp: number;
}

/**
 * Manager configuration.
 */
export interface NntpManagerConfig {
	articleCacheMaxSize: number;
	articleCacheTtlMs: number;
	cleanupIntervalMs: number;
}

const DEFAULT_CONFIG: NntpManagerConfig = {
	articleCacheMaxSize: 200, // ~140MB at 700KB/segment
	articleCacheTtlMs: 5 * 60 * 1000, // 5 minutes
	cleanupIntervalMs: 60000 // 1 minute
};

/**
 * NntpManager coordinates NNTP operations across multiple providers.
 */
export class NntpManager implements BackgroundService {
	readonly name = 'NntpManager';
	private _status: ServiceStatus = 'pending';
	private config: NntpManagerConfig;

	private pools: Map<string, NntpPool> = new Map();
	private providerOrder: string[] = [];
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;

	// Global decoded article cache - survives stream destruction
	private articleCache: Map<string, CachedArticle> = new Map();

	// In-flight request deduplication
	private inFlightRequests: Map<string, InFlightRequest> = new Map();

	constructor(config?: Partial<NntpManagerConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	get status(): ServiceStatus {
		return this._status;
	}

	/**
	 * Check if service is ready.
	 */
	get isReady(): boolean {
		return this._status === 'ready';
	}

	/**
	 * Get number of configured providers.
	 */
	get providerCount(): number {
		return this.providerOrder.length;
	}

	/**
	 * Start the service (non-blocking).
	 */
	start(): void {
		this._status = 'starting';

		setImmediate(async () => {
			try {
				await this.initialize();
				this._status = 'ready';
				logger.info({ providers: this.providerOrder.length }, 'NNTP manager is ready');
			} catch (error) {
				this._status = 'error';
				logger.error(
					{
						err: error,
						error: error instanceof Error ? error.message : 'Unknown error'
					},
					'Failed to start NNTP manager'
				);
			}
		});
	}

	/**
	 * Stop the service.
	 */
	async stop(): Promise<void> {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}

		const closes = Array.from(this.pools.values()).map((pool) => pool.close());
		await Promise.allSettled(closes);

		this.pools.clear();
		this.providerOrder = [];
		this.articleCache.clear();
		this.inFlightRequests.clear();
		this._status = 'pending';

		logger.info('NNTP manager stopped');
	}

	/**
	 * Initialize pools from database.
	 */
	private async initialize(): Promise<void> {
		const service = getNntpServerService();
		const servers = await service.getEnabledServers();

		// Sort by priority (lower = higher priority)
		servers.sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1));

		for (const server of servers) {
			const config: NntpServerConfig = {
				id: server.id,
				host: server.host,
				port: server.port,
				useSsl: server.useSsl ?? true,
				username: server.username ?? undefined,
				password: server.password ?? undefined,
				maxConnections: server.maxConnections ?? 10,
				priority: server.priority ?? 1
			};

			const pool = new NntpPool(config);
			this.pools.set(server.id, pool);
			this.providerOrder.push(server.id);

			logger.debug(
				{
					providerId: server.id,
					host: server.host,
					priority: server.priority
				},
				'Added NNTP provider pool'
			);
		}

		// Set up periodic cleanup
		this.cleanupInterval = setInterval(() => {
			this.runCleanup();
		}, this.config.cleanupIntervalMs);
	}

	/**
	 * Reload providers from database.
	 */
	async reload(): Promise<void> {
		logger.info('Reloading NNTP providers');

		for (const pool of this.pools.values()) {
			await pool.close();
		}
		this.pools.clear();
		this.providerOrder = [];

		await this.initialize();
	}

	/**
	 * Get decoded article content.
	 * Uses cache and deduplication to avoid redundant fetches.
	 */
	async getDecodedArticle(messageId: string): Promise<YencDecodeResult> {
		if (this._status !== 'ready') {
			throw new Error('Service not ready');
		}

		// Check cache first
		const cached = this.articleCache.get(messageId);
		if (cached && Date.now() - cached.timestamp < this.config.articleCacheTtlMs) {
			cached.accessCount++;
			logger.debug(
				{
					messageIdPrefix: messageId.slice(0, 20),
					sizeBytes: cached.result.data.length,
					accessCount: cached.accessCount
				},
				'NNTP article cache hit'
			);
			return cached.result;
		}

		// Check for in-flight request (deduplication)
		const inFlight = this.inFlightRequests.get(messageId);
		if (inFlight) {
			logger.debug(
				{ messageIdPrefix: messageId.slice(0, 20) },
				'Deduplicating in-flight NNTP article request'
			);
			return inFlight.promise;
		}

		// Create new request with deduplication
		const promise = this.fetchAndDecodeArticle(messageId);
		this.inFlightRequests.set(messageId, { promise, timestamp: Date.now() });

		try {
			const result = await promise;
			return result;
		} finally {
			this.inFlightRequests.delete(messageId);
		}
	}

	/**
	 * Get raw article body (no caching).
	 */
	async getRawArticle(messageId: string): Promise<Buffer> {
		if (this._status !== 'ready') {
			throw new Error('Service not ready');
		}

		return this.fetchArticleFromProviders(messageId);
	}

	/**
	 * Get only the yEnc header for an article.
	 */
	async getArticleHeader(messageId: string): Promise<YencHeader | null> {
		const body = await this.getRawArticle(messageId);
		return extractYencHeader(body);
	}

	/**
	 * Check if article exists on any provider.
	 */
	async articleExists(messageId: string): Promise<boolean> {
		if (this._status !== 'ready' || this.providerOrder.length === 0) {
			return false;
		}

		for (const providerId of this.providerOrder) {
			const pool = this.pools.get(providerId);
			if (!pool || pool.isInBackoff) continue;

			try {
				const exists = await pool.checkArticle(messageId);
				if (exists) return true;
			} catch {
				continue;
			}
		}

		return false;
	}

	/**
	 * Get statistics for all pools and cache.
	 */
	getStats(): {
		pools: Record<
			string,
			{
				host: string;
				stats: { total: number; inUse: number; available: number; pending: number };
				health: ProviderHealth;
			}
		>;
		articleCache: { size: number; maxSize: number };
		inFlightRequests: number;
	} {
		const pools: Record<
			string,
			{
				host: string;
				stats: { total: number; inUse: number; available: number; pending: number };
				health: ProviderHealth;
			}
		> = {};

		for (const [id, pool] of this.pools) {
			pools[id] = {
				host: pool.host,
				stats: pool.stats,
				health: pool.healthStatus
			};
		}

		return {
			pools,
			articleCache: {
				size: this.articleCache.size,
				maxSize: this.config.articleCacheMaxSize
			},
			inFlightRequests: this.inFlightRequests.size
		};
	}

	/**
	 * Fetch and decode article from providers.
	 */
	private async fetchAndDecodeArticle(messageId: string): Promise<YencDecodeResult> {
		const body = await this.fetchArticleFromProviders(messageId);
		const result = decodeYenc(body);

		// Cache the result
		this.cacheArticle(messageId, result);

		return result;
	}

	/**
	 * Fetch article from providers with failover.
	 */
	private async fetchArticleFromProviders(messageId: string): Promise<Buffer> {
		if (this.providerOrder.length === 0) {
			throw new Error('No NNTP providers configured');
		}

		const errors: string[] = [];
		const skipped: string[] = [];

		for (const providerId of this.providerOrder) {
			const pool = this.pools.get(providerId);
			if (!pool) continue;

			// Skip providers in backoff
			if (pool.isInBackoff) {
				skipped.push(pool.host);
				continue;
			}

			try {
				const body = await pool.getArticle(messageId);
				return body;
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Unknown error';
				errors.push(`${pool.host}: ${message}`);
				logger.debug(
					{
						providerHost: pool.host,
						messageIdPrefix: messageId.slice(0, 20),
						err: error,
						error: message
					},
					'NNTP provider failed to fetch article'
				);
				continue;
			}
		}

		const details =
			errors.length > 0
				? `tried ${errors.length} providers: ${errors.join(', ')}`
				: `all ${skipped.length} providers in backoff`;

		throw new ArticleNotFoundError(messageId, details);
	}

	/**
	 * Cache a decoded article.
	 */
	private cacheArticle(messageId: string, result: YencDecodeResult): void {
		// Evict if cache is full
		if (this.articleCache.size >= this.config.articleCacheMaxSize) {
			this.evictOldestArticles();
		}

		this.articleCache.set(messageId, {
			result,
			timestamp: Date.now(),
			accessCount: 1
		});
	}

	/**
	 * Evict oldest/least-accessed articles from cache.
	 */
	private evictOldestArticles(): void {
		// Sort by access count (ascending) then timestamp (ascending)
		const entries = Array.from(this.articleCache.entries()).sort((a, b) => {
			if (a[1].accessCount !== b[1].accessCount) {
				return a[1].accessCount - b[1].accessCount;
			}
			return a[1].timestamp - b[1].timestamp;
		});

		// Evict oldest 50%
		const toEvict = Math.ceil(this.config.articleCacheMaxSize / 2);
		for (let i = 0; i < toEvict && i < entries.length; i++) {
			this.articleCache.delete(entries[i][0]);
		}

		logger.debug({ evictedCount: toEvict }, 'Evicted NNTP article cache entries');
	}

	/**
	 * Run periodic cleanup tasks.
	 */
	private runCleanup(): void {
		// Clean up expired cache entries
		const now = Date.now();
		let cleaned = 0;

		for (const [messageId, cached] of this.articleCache) {
			if (now - cached.timestamp > this.config.articleCacheTtlMs) {
				this.articleCache.delete(messageId);
				cleaned++;
			}
		}

		if (cleaned > 0) {
			logger.debug({ cleanedCount: cleaned }, 'Cleaned expired NNTP article cache entries');
		}

		// Clean up stale in-flight requests (shouldn't happen normally)
		for (const [messageId, request] of this.inFlightRequests) {
			if (now - request.timestamp > 5 * 60 * 1000) {
				this.inFlightRequests.delete(messageId);
				logger.warn(
					{
						messageIdPrefix: messageId.slice(0, 20)
					},
					'Cleaned stale in-flight NNTP article request'
				);
			}
		}

		// Clean up pool connections
		for (const pool of this.pools.values()) {
			pool.cleanupIdle();
			pool.cleanupDead();
		}
	}
}

// Singleton instance
let instance: NntpManager | null = null;

/**
 * Get the singleton NntpManager instance.
 */
export function getNntpManager(): NntpManager {
	if (!instance) {
		instance = new NntpManager();
	}
	return instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetNntpManager(): void {
	if (instance) {
		instance.stop().catch(() => {});
		instance = null;
	}
}
