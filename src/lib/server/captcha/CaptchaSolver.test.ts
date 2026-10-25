/**
 * CaptchaSolver Tests
 *
 * Tests for the main captcha solver service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SolveResult, CaptchaSolverConfig } from './types';

// Mock settings service
const mockConfig: CaptchaSolverConfig = {
	enabled: true,
	timeoutSeconds: 60,
	cacheTtlSeconds: 3600,
	headless: true
};

vi.mock('./CaptchaSolverSettings', () => ({
	captchaSolverSettingsService: {
		getConfig: vi.fn(() => ({ ...mockConfig }))
	}
}));

// Mock solver functions
vi.mock('./browser/CamoufoxSolver', () => ({
	solveChallenge: vi.fn(),
	testForChallenge: vi.fn(),
	browserFetch: vi.fn()
}));

// Mock manager
const mockCamoufoxManager = {
	browserAvailable: vi.fn(() => true),
	waitForAvailabilityCheck: vi.fn().mockResolvedValue(undefined),
	getAvailabilityError: vi.fn(() => undefined)
};

vi.mock('./browser/CamoufoxManager', () => ({
	getCamoufoxManager: vi.fn(() => mockCamoufoxManager),
	shutdownCamoufoxManager: vi.fn().mockResolvedValue(undefined)
}));

// Mock logger
const mockLogger = {
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	child: vi.fn().mockReturnThis()
};

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

// Import after mocking
const { CaptchaSolver, getCaptchaSolver } = await import('./CaptchaSolver');
const { solveChallenge, testForChallenge, browserFetch } = await import('./browser/CamoufoxSolver');
const { captchaSolverSettingsService } = await import('./CaptchaSolverSettings');

/**
 * Helper to wait for solver to reach a specific status
 */
async function waitForStatus(
	solver: InstanceType<typeof CaptchaSolver>,
	status: 'pending' | 'starting' | 'ready' | 'error',
	timeoutMs = 1000
): Promise<void> {
	const start = Date.now();
	while (solver.status !== status) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`Timeout waiting for status '${status}', current: '${solver.status}'`);
		}
		await new Promise((resolve) => setImmediate(resolve));
	}
}

/**
 * Helper to start solver and wait for ready state
 */
async function startAndWaitReady(solver: InstanceType<typeof CaptchaSolver>): Promise<void> {
	solver.start();
	await waitForStatus(solver, 'ready');
}

describe('CaptchaSolver', () => {
	let solver: InstanceType<typeof CaptchaSolver>;

	beforeEach(() => {
		vi.clearAllMocks();

		// Reset mock implementations (clearAllMocks only clears call history)
		mockCamoufoxManager.browserAvailable.mockReturnValue(true);
		mockCamoufoxManager.waitForAvailabilityCheck.mockResolvedValue(undefined);
		mockCamoufoxManager.getAvailabilityError.mockReturnValue(undefined);

		// Reset mock config
		(captchaSolverSettingsService.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
			...mockConfig
		});

		// Default successful solve
		(solveChallenge as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true,
			cookies: [
				{
					name: 'cf_clearance',
					value: 'test',
					domain: 'example.com',
					path: '/',
					expires: -1,
					httpOnly: true,
					secure: true,
					sameSite: 'None'
				}
			],
			userAgent: 'Mozilla/5.0 (Test)',
			solveTimeMs: 5000,
			challengeType: 'cloudflare'
		} as SolveResult);

		// Default test result
		(testForChallenge as ReturnType<typeof vi.fn>).mockResolvedValue({
			hasChallenge: true,
			type: 'cloudflare',
			confidence: 0.95
		});

		// Create fresh solver
		solver = new CaptchaSolver();
	});

	afterEach(async () => {
		// Ensure solver is stopped to clean up intervals
		if (solver.status === 'ready' || solver.status === 'starting') {
			await solver.stop();
		}
	});

	describe('Service lifecycle', () => {
		it('should start with pending status', () => {
			expect(solver.status).toBe('pending');
		});

		it('should transition to starting then ready', async () => {
			solver.start();
			expect(solver.status).toBe('starting');

			await waitForStatus(solver, 'ready');

			expect(solver.status).toBe('ready');
		});

		it('should not restart if already ready', async () => {
			await startAndWaitReady(solver);

			const beforeStatus = solver.status;
			solver.start();

			expect(solver.status).toBe(beforeStatus);
			expect(mockCamoufoxManager.waitForAvailabilityCheck).toHaveBeenCalledTimes(1);
		});

		it('should not restart if already starting', () => {
			solver.start();
			solver.start();

			expect(mockCamoufoxManager.waitForAvailabilityCheck).toHaveBeenCalledTimes(0); // Called in async init
		});

		it('should transition to error on initialization failure', async () => {
			mockCamoufoxManager.waitForAvailabilityCheck.mockRejectedValue(
				new Error('Browser init failed')
			);

			solver.start();
			await waitForStatus(solver, 'error');

			expect(solver.status).toBe('error');
		});

		it('should stop and clear cache', async () => {
			await startAndWaitReady(solver);

			await solver.stop();

			expect(solver.status).toBe('pending');
		});
	});

	describe('solve', () => {
		beforeEach(async () => {
			await startAndWaitReady(solver);
		});

		it('should return error when disabled', async () => {
			(captchaSolverSettingsService.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
				...mockConfig,
				enabled: false
			});

			const result = await solver.solve({ url: 'https://example.com' });

			expect(result.success).toBe(false);
			expect(result.error).toBe('Captcha solver is disabled');
		});

		it('should return cached result when available', async () => {
			// First solve
			await solver.solve({ url: 'https://example.com' });

			// Second solve should use cache
			const result = await solver.solve({ url: 'https://example.com' });

			expect(result.success).toBe(true);
			expect(result.solveTimeMs).toBe(0); // Cache hit
			expect(solveChallenge).toHaveBeenCalledTimes(1);
		});

		it('should prevent duplicate concurrent solves for same domain', async () => {
			// Start two solves simultaneously
			const promise1 = solver.solve({ url: 'https://example.com/page1' });
			const promise2 = solver.solve({ url: 'https://example.com/page2' });

			await Promise.all([promise1, promise2]);

			// Should only call solveChallenge once
			expect(solveChallenge).toHaveBeenCalledTimes(1);
		});

		it('should allow concurrent solves for different domains', async () => {
			const promise1 = solver.solve({ url: 'https://example.com' });
			const promise2 = solver.solve({ url: 'https://other.com' });

			await Promise.all([promise1, promise2]);

			expect(solveChallenge).toHaveBeenCalledTimes(2);
		});

		it('should update stats on successful solve', async () => {
			await solver.solve({ url: 'https://example.com' });

			const stats = solver.getStats();
			expect(stats.totalAttempts).toBe(1);
			expect(stats.successCount).toBe(1);
			expect(stats.failureCount).toBe(0);
		});

		it('should update stats on failed solve', async () => {
			(solveChallenge as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: false,
				cookies: [],
				userAgent: '',
				solveTimeMs: 5000,
				challengeType: 'cloudflare',
				error: 'Timeout'
			} as SolveResult);

			await solver.solve({ url: 'https://example.com' });

			const stats = solver.getStats();
			expect(stats.totalAttempts).toBe(1);
			expect(stats.successCount).toBe(0);
			expect(stats.failureCount).toBe(1);
			expect(stats.lastError).toBe('Timeout');
		});

		it('should cache successful results', async () => {
			await solver.solve({ url: 'https://example.com' });

			const cached = solver.getCached('example.com');
			expect(cached).not.toBeNull();
			expect(cached?.cookies[0].name).toBe('cf_clearance');
		});

		it('should NOT cache failed results', async () => {
			(solveChallenge as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: false,
				cookies: [],
				userAgent: '',
				solveTimeMs: 5000,
				challengeType: 'cloudflare',
				error: 'Timeout'
			} as SolveResult);

			await solver.solve({ url: 'https://example.com' });

			const cached = solver.getCached('example.com');
			expect(cached).toBeNull();
		});

		it('should update average solve time', async () => {
			await solver.solve({ url: 'https://example1.com' });

			let stats = solver.getStats();
			expect(stats.avgSolveTimeMs).toBe(5000);

			// Second solve with different time
			(solveChallenge as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true,
				cookies: [],
				userAgent: 'Test',
				solveTimeMs: 10000,
				challengeType: 'cloudflare'
			} as SolveResult);

			await solver.solve({ url: 'https://example2.com' });

			stats = solver.getStats();
			// Weighted average: 5000 * 0.8 + 10000 * 0.2 = 6000
			expect(stats.avgSolveTimeMs).toBe(6000);
		});
	});

	describe('test', () => {
		beforeEach(async () => {
			await startAndWaitReady(solver);
		});

		it('should delegate to testForChallenge', async () => {
			await solver.test('https://example.com');

			expect(testForChallenge).toHaveBeenCalledWith('https://example.com', { headless: true });
		});

		it('should pass headless config', async () => {
			(captchaSolverSettingsService.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
				...mockConfig,
				headless: false
			});

			await solver.test('https://example.com');

			expect(testForChallenge).toHaveBeenCalledWith('https://example.com', { headless: false });
		});
	});

	describe('fetch', () => {
		beforeEach(async () => {
			await startAndWaitReady(solver);
			(browserFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true,
				body: '<html></html>',
				url: 'https://example.com',
				status: 200,
				headers: { 'content-type': 'text/html' },
				cookies: [],
				userAgent: 'Test',
				error: undefined,
				timeMs: 1234
			});
		});

		it('should update stats on successful fetch', async () => {
			await solver.fetch({ url: 'https://example.com' });

			const stats = solver.getStats();
			expect(stats.fetchAttempts).toBe(1);
			expect(stats.fetchSuccessCount).toBe(1);
			expect(stats.fetchFailureCount).toBe(0);
			expect(stats.avgFetchTimeMs).toBeGreaterThan(0);
		});

		it('should update stats on failed fetch', async () => {
			(browserFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: false,
				body: '',
				url: 'https://example.com',
				status: 0,
				headers: {},
				cookies: [],
				userAgent: '',
				error: 'Failed',
				timeMs: 500
			});

			await solver.fetch({ url: 'https://example.com' });

			const stats = solver.getStats();
			expect(stats.fetchAttempts).toBe(1);
			expect(stats.fetchSuccessCount).toBe(0);
			expect(stats.fetchFailureCount).toBe(1);
			expect(stats.lastError).toBe('Failed');
		});
	});

	describe('Cache management', () => {
		beforeEach(async () => {
			await startAndWaitReady(solver);
		});

		it('getCached should return null for non-existent domain', () => {
			const cached = solver.getCached('nonexistent.com');
			expect(cached).toBeNull();
		});

		it('getCached should return null for expired cache', async () => {
			// Use a very short TTL for this test
			(captchaSolverSettingsService.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
				...mockConfig,
				cacheTtlSeconds: 0 // Immediate expiration
			});

			await solver.solve({ url: 'https://example.com' });

			// Wait a tiny bit for the cache to expire
			await new Promise((resolve) => setTimeout(resolve, 10));

			const cached = solver.getCached('example.com');
			expect(cached).toBeNull();
		});

		it('getCookiesForDomain should return cookies from cache', async () => {
			await solver.solve({ url: 'https://example.com' });

			const cookies = solver.getCookiesForDomain('example.com');
			expect(cookies).not.toBeNull();
			expect(cookies?.[0].name).toBe('cf_clearance');
		});

		it('getUserAgentForDomain should return user agent from cache', async () => {
			await solver.solve({ url: 'https://example.com' });

			const ua = solver.getUserAgentForDomain('example.com');
			expect(ua).toBe('Mozilla/5.0 (Test)');
		});

		it('clearCacheForDomain should remove specific domain', async () => {
			await solver.solve({ url: 'https://example.com' });
			await solver.solve({ url: 'https://other.com' });

			solver.clearCacheForDomain('example.com');

			expect(solver.getCached('example.com')).toBeNull();
			expect(solver.getCached('other.com')).not.toBeNull();
		});

		it('clearCache should remove all cached entries', async () => {
			await solver.solve({ url: 'https://example.com' });
			await solver.solve({ url: 'https://other.com' });

			solver.clearCache();

			expect(solver.getCached('example.com')).toBeNull();
			expect(solver.getCached('other.com')).toBeNull();
		});

		it('should cleanup expired cache when accessed', async () => {
			// Use a very short TTL
			(captchaSolverSettingsService.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
				...mockConfig,
				cacheTtlSeconds: 0 // Immediate expiration
			});

			await solver.solve({ url: 'https://example.com' });
			expect(solver.getStats().cacheSize).toBe(1);

			// Wait for expiration
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Accessing expired cache should remove it from the map and return null
			const cached = solver.getCached('example.com');
			expect(cached).toBeNull();

			// Verify the entry was actually removed from internal cache (second call also returns null)
			expect(solver.getCached('example.com')).toBeNull();
		});
	});

	describe('getHealth', () => {
		it('should return available=false when disabled', async () => {
			(captchaSolverSettingsService.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
				...mockConfig,
				enabled: false
			});

			const health = solver.getHealth();

			expect(health.available).toBe(false);
		});

		it('should return available=false when browser not available', async () => {
			mockCamoufoxManager.browserAvailable.mockReturnValue(false);

			const health = solver.getHealth();

			expect(health.available).toBe(false);
		});

		it('should return available=true when enabled and browser available', async () => {
			await startAndWaitReady(solver);

			const health = solver.getHealth();

			expect(health.available).toBe(true);
		});

		it('should return status=initializing when pending', () => {
			const health = solver.getHealth();

			expect(health.status).toBe('initializing');
		});

		it('should return status=ready when ready', async () => {
			await startAndWaitReady(solver);

			const health = solver.getHealth();

			expect(health.status).toBe('ready');
		});

		it('should return status=error on error', async () => {
			mockCamoufoxManager.waitForAvailabilityCheck.mockRejectedValue(new Error('Failed'));
			solver.start();
			await waitForStatus(solver, 'error');

			const health = solver.getHealth();

			expect(health.status).toBe('error');
		});

		it('should include stats in health', async () => {
			await startAndWaitReady(solver);
			await solver.solve({ url: 'https://example.com' });

			const health = solver.getHealth();

			expect(health.stats.totalAttempts).toBe(1);
		});
	});

	describe('isAvailable', () => {
		it('should return false when disabled', () => {
			(captchaSolverSettingsService.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
				...mockConfig,
				enabled: false
			});

			expect(solver.isAvailable()).toBe(false);
		});

		it('should return false when not ready', () => {
			expect(solver.isAvailable()).toBe(false);
		});

		it('should return false when browser not available', async () => {
			await startAndWaitReady(solver);
			mockCamoufoxManager.browserAvailable.mockReturnValue(false);

			expect(solver.isAvailable()).toBe(false);
		});

		it('should return true when all conditions met', async () => {
			await startAndWaitReady(solver);

			expect(solver.isAvailable()).toBe(true);
		});
	});

	describe('resetStats', () => {
		it('should reset all statistics', async () => {
			await startAndWaitReady(solver);
			await solver.solve({ url: 'https://example.com' });

			solver.resetStats();

			const stats = solver.getStats();
			expect(stats.totalAttempts).toBe(0);
			expect(stats.successCount).toBe(0);
			expect(stats.failureCount).toBe(0);
			expect(stats.cacheHits).toBe(0);
			expect(stats.avgSolveTimeMs).toBe(0);
			expect(stats.fetchAttempts).toBe(0);
			expect(stats.fetchSuccessCount).toBe(0);
			expect(stats.fetchFailureCount).toBe(0);
			expect(stats.avgFetchTimeMs).toBe(0);
		});

		it('should preserve cache size in stats', async () => {
			await startAndWaitReady(solver);
			await solver.solve({ url: 'https://example.com' });

			solver.resetStats();

			const stats = solver.getStats();
			expect(stats.cacheSize).toBe(1); // Cache still has entry
			expect(stats.fetchAttempts).toBe(0);
		});
	});

	describe('Singleton', () => {
		it('getCaptchaSolver should return same instance', () => {
			const instance1 = getCaptchaSolver();
			const instance2 = getCaptchaSolver();

			expect(instance1).toBe(instance2);
		});
	});
});
