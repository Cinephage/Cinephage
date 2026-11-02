import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { subtitleProviders } from '#lib/server/db/schema.js';
import { RateLimiter } from '../providers/mixins';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const { SubtitleProviderManager } = await import('./SubtitleProviderManager');

afterAll(() => {
	destroyTestDb(testDb);
});

describe('RateLimiter', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('allows a burst up to the configured rate then throttles', async () => {
		vi.useFakeTimers();
		const limiter = new RateLimiter(60); // 1 token/sec, burst 60

		await limiter.acquire();
		await limiter.acquire();
		expect(limiter.canMakeRequest()).toBe(true);

		// Drain the burst.
		for (let i = 0; i < 58; i++) await limiter.acquire();
		expect(limiter.canMakeRequest()).toBe(false);
	});

	it('waits for a token when the bucket is empty', async () => {
		vi.useFakeTimers();
		const limiter = new RateLimiter(1); // one request per minute

		await limiter.acquire();
		expect(limiter.canMakeRequest()).toBe(false);

		let released = false;
		const pending = limiter.acquire().then(() => {
			released = true;
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(released).toBe(false);

		await vi.advanceTimersByTimeAsync(61_000);
		await pending;
		expect(released).toBe(true);
	});
});

describe('SubtitleProviderManager rate limiting', () => {
	const manager = SubtitleProviderManager.getInstance();

	beforeEach(() => {
		testDb.db.delete(subtitleProviders).run();
		manager.clearRateLimitersForTests();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function seedProvider(id: string, requestsPerMinute: number) {
		testDb.db
			.insert(subtitleProviders)
			.values({
				id,
				name: 'Seeded Provider',
				implementation: 'opensubtitles',
				enabled: true,
				priority: 25,
				requestsPerMinute
			})
			.run();
	}

	it('throttles the second acquire for a 1/minute provider using the stored rate', async () => {
		seedProvider('provider-rpm-1', 1);

		await manager.acquireRateLimit('provider-rpm-1');

		let released = false;
		const pending = manager.acquireRateLimit('provider-rpm-1').then(() => {
			released = true;
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(released).toBe(false);

		await vi.advanceTimersByTimeAsync(61_000);
		await pending;
		expect(released).toBe(true);
	});

	it('reuses one shared limiter per provider id', async () => {
		seedProvider('provider-rpm-2', 2);

		// First acquire creates and primes the limiter from the stored rate.
		await manager.acquireRateLimit('provider-rpm-2');
		expect(manager.canMakeRequestForTests('provider-rpm-2')).toBe(true);

		await manager.acquireRateLimit('provider-rpm-2');
		// Two tokens consumed; refill is slow, so no token remains immediately.
		expect(manager.canMakeRequestForTests('provider-rpm-2')).toBe(false);
	});
});
