import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper.js';
import {
	indexers as indexersTable,
	indexerStatus as indexerStatusTable
} from '#lib/server/db/schema.js';
import { isQuotaExceededMessage, nextUtcMidnight } from './types.js';

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

vi.mock('#lib/logging/index.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		child: vi.fn().mockReturnThis()
	},
	createChildLogger: vi.fn(() => ({
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		child: vi.fn().mockReturnThis()
	}))
}));

const { PersistentStatusTracker } = await import('./PersistentStatusTracker.js');

function seedIndexer(): string {
	const id = randomUUID();
	const now = new Date().toISOString();
	testDb.db
		.insert(indexersTable)
		.values({
			id,
			name: 'Test Indexer',
			definitionId: 'test-definition',
			enabled: true,
			isBuiltIn: false,
			baseUrl: 'https://example.test',
			priority: 25,
			enableAutomaticSearch: true,
			enableInteractiveSearch: true,
			createdAt: now,
			updatedAt: now
		})
		.run();
	return id;
}

describe('isQuotaExceededMessage', () => {
	it('matches real-world indexer quota messages', () => {
		expect(
			isQuotaExceededMessage('Indexer API error 500: Daily API request limit of 10000 reached')
		).toBe(true);
		expect(isQuotaExceededMessage('429 Too Many Requests')).toBe(true);
		expect(isQuotaExceededMessage('Rate limit exceeded, try again later')).toBe(true);
	});

	it('does not match ordinary connectivity errors', () => {
		expect(isQuotaExceededMessage('Connection refused')).toBe(false);
		expect(isQuotaExceededMessage('HTTP 403 Forbidden')).toBe(false);
		expect(isQuotaExceededMessage('Cloudflare protection on example.com')).toBe(false);
	});
});

describe('nextUtcMidnight', () => {
	it('returns the next UTC day boundary strictly after the given time', () => {
		const from = new Date('2026-03-05T14:30:00.000Z');
		const next = nextUtcMidnight(from);
		expect(next.toISOString()).toBe('2026-03-06T00:00:00.000Z');
	});
});

describe('PersistentStatusTracker.recordQuotaExceeded', () => {
	let tracker: InstanceType<typeof PersistentStatusTracker>;

	beforeAll(() => {
		tracker = new PersistentStatusTracker();
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		testDb.db.delete(indexerStatusTable).run();
		testDb.db.delete(indexersTable).run();
	});

	it('disables the indexer immediately with reason quota_exceeded until next UTC midnight', async () => {
		const id = seedIndexer();
		await tracker.initialize(id, true, 25);

		await tracker.recordQuotaExceeded(id, 'Daily API request limit of 10000 reached');

		const status = await tracker.getStatus(id);
		expect(status.isDisabled).toBe(true);
		expect(status.disabledReason).toBe('quota_exceeded');
		expect(status.health).toBe('disabled');
		expect(status.disabledUntil).toBeInstanceOf(Date);
		expect(status.recentFailures[0]?.message).toContain('Daily API request limit');

		expect(tracker.canUse(id)).toBe(false);
	});

	it('does not require consecutive failures before disabling, unlike recordFailure', async () => {
		const id = seedIndexer();
		await tracker.initialize(id, true, 25);

		// A single quota-exceeded report is enough - no need for repeated failures.
		await tracker.recordQuotaExceeded(id, 'Rate limit exceeded');

		const status = await tracker.getStatus(id);
		expect(status.consecutiveFailures).toBe(0);
		expect(status.isDisabled).toBe(true);
	});

	it('re-enables with a full reset (not the halved-failure warning state) once the window passes', async () => {
		const id = seedIndexer();
		await tracker.initialize(id, true, 25);
		await tracker.recordQuotaExceeded(id, 'Daily limit reached');

		const status = await tracker.getStatus(id);
		// Simulate the reset window having already passed.
		status.disabledUntil = new Date(Date.now() - 1000);

		expect(tracker.canUse(id)).toBe(true);
		const afterReset = await tracker.getStatus(id);
		expect(afterReset.isDisabled).toBe(false);
		expect(afterReset.disabledReason).toBeUndefined();
		expect(afterReset.consecutiveFailures).toBe(0);
		expect(afterReset.health).toBe('healthy');
	});
});
