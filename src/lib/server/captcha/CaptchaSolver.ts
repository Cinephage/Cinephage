/**
 * Captcha Solver Service
 *
 * Main BackgroundService that manages captcha/anti-bot solving using Camoufox.
 * Camoufox is a Firefox-based anti-detect browser that handles fingerprinting
 * at the C++ level, making it highly effective against Cloudflare and similar protections.
 */

import type { Cookie } from 'playwright-core';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });
import type { BackgroundService } from '#lib/server/services/background-service.js';
import { captchaSolverSettingsService } from './CaptchaSolverSettings';
import type {
	BrowserFetchRequest,
	BrowserFetchResult,
	CachedSolveResult,
	ChallengeType,
	SolveRequest,
	SolveResult,
	SolverHealth,
	SolverStats
} from './types';
import { browserFetch, solveChallenge, testForChallenge } from './browser/CamoufoxSolver';
import { getCamoufoxManager, shutdownCamoufoxManager } from './browser/CamoufoxManager';
import { installBrowserCrashGuard } from './browser/browser-crash-guard';

/**
 * Captcha Solver Background Service
 */
export class CaptchaSolver implements BackgroundService {
	readonly name = 'CaptchaSolver';
	private _status: 'pending' | 'starting' | 'ready' | 'error' = 'pending';
	private _error: string | undefined;

	// Cache of solved challenges by domain
	private cache = new Map<string, CachedSolveResult>();

	// Statistics tracking
	private stats: SolverStats = {
		totalAttempts: 0,
		successCount: 0,
		failureCount: 0,
		cacheHits: 0,
		avgSolveTimeMs: 0,
		cacheSize: 0,
		fetchAttempts: 0,
		fetchSuccessCount: 0,
		fetchFailureCount: 0,
		avgFetchTimeMs: 0
	};

	// Running solves (to prevent duplicate concurrent solves for same domain)
	private pendingSolves = new Map<string, Promise<SolveResult>>();

	// Cache cleanup interval
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;

	get status() {
		return this._status;
	}

	/**
	 * Start the service
	 */
	start(): void {
		if (this._status === 'ready' || this._status === 'starting') {
			return;
		}

		this._status = 'starting';

		setImmediate(() => {
			this.initialize();
		});
	}

	/**
	 * Initialize the service
	 */
	private async initialize(): Promise<void> {
		try {
			logger.info('[CaptchaSolver] Initializing with Camoufox');

			// Guard the process against uncaught errors thrown from inside the
			// headless browser stack (Camoufox/Playwright/Firefox) during solving,
			// which would otherwise terminate the whole server.
			installBrowserCrashGuard();

			// Wait for Camoufox availability check to complete
			const camoufoxManager = getCamoufoxManager();
			await camoufoxManager.waitForAvailabilityCheck();

			// Start cache cleanup interval
			this.startCacheCleanup();

			this._status = 'ready';
			logger.info(
				{
					browserAvailable: camoufoxManager.browserAvailable()
				},
				'[CaptchaSolver] Ready'
			);
		} catch (error) {
			this._error = error instanceof Error ? error.message : String(error);
			this._status = 'error';
			logger.error({ err: error }, '[CaptchaSolver] Initialization failed');
		}
	}

	/**
	 * Stop the service
	 */
	async stop(): Promise<void> {
		logger.info('[CaptchaSolver] Stopping');

		// Stop cleanup interval
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}

		// Clear cache
		this.cache.clear();

		// Shutdown browser manager
		await shutdownCamoufoxManager();

		this._status = 'pending';
		logger.info('[CaptchaSolver] Stopped');
	}

	/**
	 * Solve a challenge for a URL
	 */
	async solve(request: SolveRequest): Promise<SolveResult> {
		const config = captchaSolverSettingsService.getConfig();

		if (!config.enabled) {
			return {
				success: false,
				cookies: [],
				userAgent: '',
				solveTimeMs: 0,
				challengeType: 'unknown',
				error: 'Captcha solver is disabled'
			};
		}

		const domain = new URL(request.url).hostname;

		// Check cache first
		const cached = this.getCached(domain);
		if (cached) {
			this.stats.cacheHits++;
			logger.debug({ domain }, '[CaptchaSolver] Cache hit');
			return {
				success: true,
				cookies: cached.cookies,
				userAgent: cached.userAgent,
				solveTimeMs: 0,
				challengeType: 'unknown'
			};
		}

		// Check if there's already a pending solve for this domain
		const pending = this.pendingSolves.get(domain);
		if (pending) {
			logger.debug({ domain }, '[CaptchaSolver] Waiting for pending solve');
			return pending;
		}

		// Start solve
		this.stats.totalAttempts++;
		const solvePromise = solveChallenge(request, config);
		this.pendingSolves.set(domain, solvePromise);

		try {
			const result = await solvePromise;

			if (result.success) {
				this.stats.successCount++;
				// Cache successful result
				this.setCached(domain, {
					domain,
					cookies: result.cookies,
					userAgent: result.userAgent,
					createdAt: new Date(),
					expiresAt: new Date(Date.now() + config.cacheTtlSeconds * 1000)
				});
			} else {
				this.stats.failureCount++;
				this.stats.lastError = result.error;
			}

			// Update average solve time
			this.updateAvgSolveTime(result.solveTimeMs);
			this.stats.lastSolveAt = new Date();

			return result;
		} finally {
			this.pendingSolves.delete(domain);
		}
	}

	/**
	 * Test if a URL has a challenge (without solving)
	 */
	async test(
		url: string
	): Promise<{ hasChallenge: boolean; type: ChallengeType; confidence: number }> {
		const config = captchaSolverSettingsService.getConfig();
		return testForChallenge(url, { headless: config.headless });
	}

	/**
	 * Fetch a URL through the browser, bypassing TLS fingerprinting.
	 * Use this when Cloudflare rejects requests even with valid cookies
	 * (due to JA3/JA4 fingerprint mismatch between Node.js and Firefox).
	 */
	async fetch(request: BrowserFetchRequest): Promise<BrowserFetchResult> {
		const config = captchaSolverSettingsService.getConfig();

		if (!config.enabled) {
			return {
				success: false,
				body: '',
				url: request.url,
				status: 0,
				headers: {},
				cookies: [],
				userAgent: '',
				error: 'Captcha solver is disabled',
				timeMs: 0
			};
		}

		if (!this.isAvailable()) {
			return {
				success: false,
				body: '',
				url: request.url,
				status: 0,
				headers: {},
				cookies: [],
				userAgent: '',
				error: 'Browser not available',
				timeMs: 0
			};
		}

		const fetchStart = Date.now();
		this.stats.fetchAttempts++;

		const result = await browserFetch(request, {
			headless: config.headless,
			timeoutSeconds: request.timeout ?? config.timeoutSeconds,
			// Media blocking is left OFF by default: aborting image/font requests during
			// a Cloudflare challenge can prevent the challenge from completing. The global
			// browser semaphore is what bounds memory, not per-page media blocking.
			blockMedia: false
		});

		if (result.success) {
			this.stats.fetchSuccessCount++;
		} else {
			this.stats.fetchFailureCount++;
			this.stats.lastError = result.error;
		}

		const fetchTime = Math.max(Date.now() - fetchStart, result.timeMs, 1);
		this.updateAvgFetchTime(fetchTime);
		this.stats.lastFetchAt = new Date();

		return result;
	}

	/**
	 * Get cached result for a domain
	 */
	getCached(domain: string): CachedSolveResult | null {
		const cached = this.cache.get(domain);
		if (!cached) return null;

		// Check if expired
		if (new Date() > cached.expiresAt) {
			this.cache.delete(domain);
			return null;
		}

		return cached;
	}

	/**
	 * Get cookies for a domain from cache
	 */
	getCookiesForDomain(domain: string): Cookie[] | null {
		const cached = this.getCached(domain);
		return cached?.cookies || null;
	}

	/**
	 * Get user agent for a domain from cache
	 */
	getUserAgentForDomain(domain: string): string | null {
		const cached = this.getCached(domain);
		return cached?.userAgent || null;
	}

	/**
	 * Set cached result
	 */
	private setCached(domain: string, result: CachedSolveResult): void {
		this.cache.set(domain, result);
		this.stats.cacheSize = this.cache.size;
	}

	/**
	 * Clear cache for a specific domain
	 */
	clearCacheForDomain(domain: string): void {
		this.cache.delete(domain);
		this.stats.cacheSize = this.cache.size;
	}

	/**
	 * Clear entire cache
	 */
	clearCache(): void {
		this.cache.clear();
		this.stats.cacheSize = 0;
	}

	/**
	 * Start periodic cache cleanup
	 */
	private startCacheCleanup(): void {
		// Run every 5 minutes
		this.cleanupInterval = setInterval(
			() => {
				this.cleanupExpiredCache();
			},
			5 * 60 * 1000
		);
	}

	/**
	 * Clean up expired cache entries
	 */
	private cleanupExpiredCache(): void {
		const now = new Date();
		let removed = 0;

		for (const [domain, cached] of this.cache) {
			if (now > cached.expiresAt) {
				this.cache.delete(domain);
				removed++;
			}
		}

		if (removed > 0) {
			this.stats.cacheSize = this.cache.size;
			logger.debug({ removed }, '[CaptchaSolver] Cleaned up expired cache');
		}
	}

	/**
	 * Update average solve time
	 */
	private updateAvgSolveTime(newTime: number): void {
		const total = this.stats.successCount + this.stats.failureCount;
		if (total === 1) {
			this.stats.avgSolveTimeMs = newTime;
		} else {
			// Weighted average favoring recent times
			this.stats.avgSolveTimeMs = Math.round(this.stats.avgSolveTimeMs * 0.8 + newTime * 0.2);
		}
	}

	/**
	 * Update average fetch time
	 */
	private updateAvgFetchTime(newTime: number): void {
		const total = this.stats.fetchSuccessCount + this.stats.fetchFailureCount;
		if (total === 1) {
			this.stats.avgFetchTimeMs = newTime;
		} else {
			this.stats.avgFetchTimeMs = Math.round(this.stats.avgFetchTimeMs * 0.8 + newTime * 0.2);
		}
	}

	/**
	 * Get service health status
	 */
	getHealth(): SolverHealth {
		const config = captchaSolverSettingsService.getConfig();
		const camoufoxManager = getCamoufoxManager();

		// Determine status based on internal state
		let status: SolverHealth['status'];
		if (this._status === 'pending' || this._status === 'starting') {
			status = 'initializing';
		} else if (this._status === 'ready') {
			status = this.pendingSolves.size > 0 ? 'busy' : 'ready';
		} else if (this._status === 'error') {
			status = 'error';
		} else {
			status = 'disabled';
		}

		return {
			available: config.enabled && camoufoxManager.browserAvailable(),
			status,
			browserAvailable: camoufoxManager.browserAvailable(),
			error: this._error || camoufoxManager.getAvailabilityError(),
			stats: { ...this.stats }
		};
	}

	/**
	 * Get statistics
	 */
	getStats(): SolverStats {
		return { ...this.stats };
	}

	/**
	 * Check if solver is enabled and available
	 */
	isAvailable(): boolean {
		const config = captchaSolverSettingsService.getConfig();
		return config.enabled && this._status === 'ready' && getCamoufoxManager().browserAvailable();
	}

	/**
	 * Reset statistics
	 */
	resetStats(): void {
		this.stats = {
			totalAttempts: 0,
			successCount: 0,
			failureCount: 0,
			cacheHits: 0,
			avgSolveTimeMs: 0,
			cacheSize: this.cache.size,
			fetchAttempts: 0,
			fetchSuccessCount: 0,
			fetchFailureCount: 0,
			avgFetchTimeMs: 0
		};
	}
}

// Singleton instance
let captchaSolverInstance: CaptchaSolver | null = null;

/**
 * Get the captcha solver instance
 */
export function getCaptchaSolver(): CaptchaSolver {
	if (!captchaSolverInstance) {
		captchaSolverInstance = new CaptchaSolver();
	}
	return captchaSolverInstance;
}
