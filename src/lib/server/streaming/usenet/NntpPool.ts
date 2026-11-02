/**
 * NntpPool - Per-provider connection pool with health tracking.
 *
 * Manages a pool of connections to a single NNTP provider with:
 * - Connection pooling and reuse
 * - Health tracking with exponential backoff
 * - Request queueing when pool is exhausted
 * - Idle connection cleanup
 */

import { createChildLogger } from '#lib/logging/index.js';
import { NntpConnection, type NntpConnectionConfig } from './NntpConnection';

const logger = createChildLogger({ logDomain: 'streams' as const });
import type { ProviderHealth, NntpServerConfig } from './types';

/**
 * Pooled connection with metadata.
 */
interface PooledConnection {
	connection: NntpConnection;
	inUse: boolean;
	createdAt: number;
	lastUsedAt: number;
}

/**
 * Pending request waiting for a connection.
 */
interface PendingRequest {
	resolve: (conn: NntpConnection) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

/**
 * Pool configuration.
 */
export interface NntpPoolConfig {
	maxConnections: number;
	connectionTimeout: number;
	requestTimeout: number;
	idleTimeout: number;
	maxBackoffMs: number;
}

const DEFAULT_POOL_CONFIG: NntpPoolConfig = {
	maxConnections: 10,
	connectionTimeout: 15000,
	requestTimeout: 60000, // Time to wait for a connection from pool
	idleTimeout: 5 * 60 * 1000, // 5 minutes idle before cleanup
	maxBackoffMs: 60000 // Max 60s backoff
};

/**
 * NntpPool manages connections to a single NNTP provider.
 */
export class NntpPool {
	private serverConfig: NntpServerConfig;
	private poolConfig: NntpPoolConfig;
	private connections: PooledConnection[] = [];
	private pendingRequests: PendingRequest[] = [];
	private health: ProviderHealth;
	private closed = false;

	constructor(serverConfig: NntpServerConfig, poolConfig?: Partial<NntpPoolConfig>) {
		this.serverConfig = serverConfig;
		this.poolConfig = {
			...DEFAULT_POOL_CONFIG,
			maxConnections: serverConfig.maxConnections,
			...poolConfig
		};

		this.health = {
			consecutiveFailures: 0,
			lastSuccess: null,
			lastFailure: null,
			averageLatencyMs: 0,
			totalRequests: 0,
			backoffUntil: null
		};
	}

	/**
	 * Get server host for identification.
	 */
	get host(): string {
		return this.serverConfig.host;
	}

	/**
	 * Get server ID.
	 */
	get id(): string {
		return this.serverConfig.id;
	}

	/**
	 * Get provider health status.
	 */
	get healthStatus(): ProviderHealth {
		return { ...this.health };
	}

	/**
	 * Check if provider is in backoff.
	 */
	get isInBackoff(): boolean {
		if (!this.health.backoffUntil) return false;
		return Date.now() < this.health.backoffUntil.getTime();
	}

	/**
	 * Get pool statistics.
	 */
	get stats(): { total: number; inUse: number; available: number; pending: number } {
		const inUse = this.connections.filter((c) => c.inUse).length;
		return {
			total: this.connections.length,
			inUse,
			available: this.connections.length - inUse,
			pending: this.pendingRequests.length
		};
	}

	/**
	 * Get an article by message ID.
	 * Handles connection acquisition, execution, and release.
	 */
	async getArticle(messageId: string): Promise<Buffer> {
		if (this.closed) {
			throw new Error('Pool is closed');
		}

		// Check backoff
		if (this.isInBackoff) {
			const remaining = this.health.backoffUntil!.getTime() - Date.now();
			throw new Error(`Provider in backoff for ${Math.ceil(remaining / 1000)}s`);
		}

		const startTime = Date.now();
		const connection = await this.acquireConnection();

		try {
			const body = await connection.getBody(messageId);
			this.recordSuccess(Date.now() - startTime);
			return body;
		} catch (error) {
			const classified = connection.classifyError(
				error instanceof Error ? error : new Error(String(error))
			);
			this.recordFailure(classified.type);
			throw error;
		} finally {
			this.releaseConnection(connection);
		}
	}

	/**
	 * Check if article exists on this provider.
	 */
	async checkArticle(messageId: string): Promise<boolean> {
		if (this.closed || this.isInBackoff) {
			return false;
		}

		const connection = await this.acquireConnection();

		try {
			return await connection.checkArticle(messageId);
		} finally {
			this.releaseConnection(connection);
		}
	}

	/**
	 * Acquire a connection from the pool.
	 */
	private async acquireConnection(): Promise<NntpConnection> {
		// Try to find an available connection
		const available = this.connections.find((c) => !c.inUse && c.connection.isReady);
		if (available) {
			available.inUse = true;
			available.lastUsedAt = Date.now();
			return available.connection;
		}

		// Create new connection if under limit
		if (this.connections.length < this.poolConfig.maxConnections) {
			const connection = await this.createConnection();
			const pooled: PooledConnection = {
				connection,
				inUse: true,
				createdAt: Date.now(),
				lastUsedAt: Date.now()
			};
			this.connections.push(pooled);
			return connection;
		}

		// Wait for a connection to become available
		return this.waitForConnection();
	}

	/**
	 * Wait for a connection to become available.
	 */
	private waitForConnection(): Promise<NntpConnection> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				const idx = this.pendingRequests.findIndex((r) => r.timeout === timeout);
				if (idx !== -1) {
					this.pendingRequests.splice(idx, 1);
				}
				reject(new Error(`Connection pool timeout after ${this.poolConfig.requestTimeout}ms`));
			}, this.poolConfig.requestTimeout);

			this.pendingRequests.push({ resolve, reject, timeout });
		});
	}

	/**
	 * Release a connection back to the pool.
	 */
	private releaseConnection(connection: NntpConnection): void {
		const pooled = this.connections.find((c) => c.connection === connection);
		if (!pooled) return;

		pooled.inUse = false;
		pooled.lastUsedAt = Date.now();

		// Check if there are pending requests
		if (this.pendingRequests.length > 0 && connection.isReady) {
			const pending = this.pendingRequests.shift()!;
			clearTimeout(pending.timeout);
			pooled.inUse = true;
			pending.resolve(connection);
		}
	}

	/**
	 * Create a new connection.
	 */
	private async createConnection(): Promise<NntpConnection> {
		const config: NntpConnectionConfig = {
			host: this.serverConfig.host,
			port: this.serverConfig.port,
			useSsl: this.serverConfig.useSsl,
			username: this.serverConfig.username,
			password: this.serverConfig.password,
			timeouts: {
				connect: this.poolConfig.connectionTimeout
			}
		};

		const connection = new NntpConnection(config);
		await connection.connect();

		logger.debug(
			{
				host: this.host,
				poolSize: this.connections.length + 1
			},
			'Created NNTP pool connection'
		);

		return connection;
	}

	/**
	 * Record successful request.
	 */
	private recordSuccess(latencyMs: number): void {
		this.health.consecutiveFailures = 0;
		this.health.lastSuccess = new Date();
		this.health.backoffUntil = null;
		this.health.totalRequests++;

		// Update average latency (exponential moving average)
		const alpha = 0.1;
		this.health.averageLatencyMs =
			this.health.averageLatencyMs === 0
				? latencyMs
				: alpha * latencyMs + (1 - alpha) * this.health.averageLatencyMs;
	}

	/**
	 * Record failed request and apply backoff if needed.
	 */
	private recordFailure(errorType: 'retryable' | 'fatal' | 'not_found'): void {
		this.health.lastFailure = new Date();
		this.health.totalRequests++;

		// Only count retryable errors for backoff
		if (errorType === 'retryable') {
			this.health.consecutiveFailures++;

			// Apply exponential backoff after 3 consecutive failures
			if (this.health.consecutiveFailures >= 3) {
				const backoffMs = Math.min(
					1000 * Math.pow(2, this.health.consecutiveFailures - 3),
					this.poolConfig.maxBackoffMs
				);
				this.health.backoffUntil = new Date(Date.now() + backoffMs);

				logger.warn(
					{
						host: this.host,
						consecutiveFailures: this.health.consecutiveFailures,
						backoffMs
					},
					'NNTP provider entered backoff'
				);
			}
		}
	}

	/**
	 * Clean up idle connections.
	 */
	cleanupIdle(): void {
		const now = Date.now();
		const toRemove: PooledConnection[] = [];

		for (const pooled of this.connections) {
			if (!pooled.inUse && now - pooled.lastUsedAt > this.poolConfig.idleTimeout) {
				toRemove.push(pooled);
			}
		}

		for (const pooled of toRemove) {
			const idx = this.connections.indexOf(pooled);
			if (idx !== -1) {
				this.connections.splice(idx, 1);
				pooled.connection.disconnect().catch(() => {});
			}
		}

		if (toRemove.length > 0) {
			logger.debug(
				{
					host: this.host,
					cleanedCount: toRemove.length,
					remaining: this.connections.length
				},
				'Cleaned idle NNTP pool connections'
			);
		}
	}

	/**
	 * Remove dead/error connections.
	 */
	cleanupDead(): void {
		const toRemove: PooledConnection[] = [];

		for (const pooled of this.connections) {
			if (!pooled.inUse && !pooled.connection.isReady) {
				toRemove.push(pooled);
			}
		}

		for (const pooled of toRemove) {
			const idx = this.connections.indexOf(pooled);
			if (idx !== -1) {
				this.connections.splice(idx, 1);
				pooled.connection.disconnect().catch(() => {});
			}
		}
	}

	/**
	 * Close all connections and reject pending requests.
	 */
	async close(): Promise<void> {
		this.closed = true;

		// Reject all pending requests
		for (const pending of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(new Error('Pool is closing'));
		}
		this.pendingRequests = [];

		// Close all connections
		const closes = this.connections.map((c) => c.connection.disconnect());
		await Promise.allSettled(closes);
		this.connections = [];

		logger.debug({ host: this.host }, 'Closed NNTP pool');
	}
}
