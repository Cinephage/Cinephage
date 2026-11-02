import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '#lib/server/db/schema.js';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';

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

import { getEpgScheduler } from './EpgScheduler';

describe('EpgScheduler settings', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		await testDb.db.delete(settings);
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	it('persists interval and retention changes and reflects them in status', () => {
		const scheduler = getEpgScheduler();

		scheduler.setSyncIntervalHours(2);
		scheduler.setRetentionHours(72);

		const status = scheduler.getStatus();
		expect(status.syncIntervalHours).toBe(2);
		expect(status.retentionHours).toBe(72);
	});

	it('rejects out-of-range values', () => {
		const scheduler = getEpgScheduler();

		expect(() => scheduler.setSyncIntervalHours(0)).toThrow();
		expect(() => scheduler.setSyncIntervalHours(169)).toThrow();
		expect(() => scheduler.setRetentionHours(1)).toThrow();
		expect(() => scheduler.setRetentionHours(721)).toThrow();
	});

	it('markSyncedAt advances the schedule so manual syncs count', () => {
		const scheduler = getEpgScheduler();

		scheduler.setSyncIntervalHours(6);
		scheduler.markSyncedAt(new Date('2026-10-29T12:00:00Z'));

		const status = scheduler.getStatus();
		expect(status.lastSyncAt).toBe('2026-10-29T12:00:00.000Z');
		expect(status.nextSyncAt).toBe('2026-10-29T18:00:00.000Z');
	});
});
