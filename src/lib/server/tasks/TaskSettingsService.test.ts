import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { taskSettings } from '#lib/server/db/schema.js';

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
	createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

const { taskSettingsService: service } = await import('./TaskSettingsService.js');

describe('TaskSettingsService.setTaskInterval - registry is the authoritative minimum', () => {
	beforeEach(() => {
		testDb.db.delete(taskSettings).run();
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	it('rejects an interval below the registry minimum even when a stale persisted row allows it', async () => {
		// Simulate a row created back when 'metadata-refresh' had a lower
		// registry minimum (0.25h) than it does now (24h) - this reproduces
		// the exact stale state found in production: min_interval_hours never
		// got reconciled after the registry's minimum was raised.
		const now = new Date().toISOString();
		await testDb.db
			.insert(taskSettings)
			.values({
				id: 'metadata-refresh',
				enabled: true,
				intervalHours: 48,
				minIntervalHours: 0.25,
				createdAt: now,
				updatedAt: now
			})
			.run();

		await expect(service.setTaskInterval('metadata-refresh', 1)).rejects.toThrow(
			/at least 24 hours/
		);
	});

	it('accepts an interval at or above the registry minimum and self-heals the stale column', async () => {
		const now = new Date().toISOString();
		await testDb.db
			.insert(taskSettings)
			.values({
				id: 'metadata-refresh',
				enabled: true,
				intervalHours: 48,
				minIntervalHours: 0.25,
				createdAt: now,
				updatedAt: now
			})
			.run();

		await service.setTaskInterval('metadata-refresh', 24);

		const [row] = await testDb.db
			.select()
			.from(taskSettings)
			.where(eq(taskSettings.id, 'metadata-refresh'));
		expect(row.intervalHours).toBe(24);
		expect(row.minIntervalHours).toBe(24);
	});

	it('still enforces the fallback minimum for a task not in the registry', async () => {
		const now = new Date().toISOString();
		await testDb.db
			.insert(taskSettings)
			.values({
				id: 'not-a-real-task',
				enabled: true,
				minIntervalHours: 2,
				createdAt: now,
				updatedAt: now
			})
			.run();

		await expect(service.setTaskInterval('not-a-real-task', 1)).rejects.toThrow(/at least 2 hours/);
	});
});
