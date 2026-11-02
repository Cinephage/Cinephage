import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper.js';
import { storageInsights } from '#lib/server/db/schema.js';

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

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

import { upsertInsights } from './upsert.js';
import type { InsightFinding } from './types.js';

describe('upsertInsights', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(async () => {
		await clearTestDb(testDb);
	});

	it('inserts new findings as storage_insights rows', async () => {
		const findings: InsightFinding[] = [
			{
				type: 'missing-from-media-server',
				severity: 'info',
				scope: 'global',
				title: '5 items missing from media server',
				summary: '5 items in your library are not tracked by any media server.',
				itemCount: 5
			}
		];

		upsertInsights(findings, new Date().toISOString());

		const rows = await testDb.db.select().from(storageInsights);
		expect(rows).toHaveLength(1);
		expect(rows[0].insightType).toBe('missing-from-media-server');
		expect(rows[0].itemCount).toBe(5);
		expect(rows[0].dismissedAt).toBeNull();
	});

	it('updates existing finding and clears dismissed state on re-detection', async () => {
		// Seed an existing dismissed finding
		await testDb.db.insert(storageInsights).values({
			id: 'insight-1',
			insightType: 'missing-from-media-server',
			severity: 'info',
			scope: 'global',
			scopeId: null,
			title: 'Old title',
			summary: 'Old summary',
			itemCount: 3,
			firstDetectedAt: '2026-06-01T00:00:00.000Z',
			lastDetectedAt: '2026-06-01T00:00:00.000Z',
			dismissedAt: '2026-06-02T00:00:00.000Z',
			dismissedBy: 'user-1'
		});

		const findings: InsightFinding[] = [
			{
				type: 'missing-from-media-server',
				severity: 'warning',
				scope: 'global',
				title: 'Updated title',
				summary: 'Updated summary',
				itemCount: 7
			}
		];

		upsertInsights(findings, '2026-07-01T00:00:00.000Z');

		const rows = await testDb.db.select().from(storageInsights);
		expect(rows).toHaveLength(1);
		expect(rows[0].title).toBe('Updated title');
		expect(rows[0].itemCount).toBe(7);
		expect(rows[0].severity).toBe('warning');
		// Dismissed state cleared on re-detection
		expect(rows[0].dismissedAt).toBeNull();
		expect(rows[0].dismissedBy).toBeNull();
		// firstDetectedAt preserved, lastDetectedAt updated
		expect(rows[0].firstDetectedAt).toBe('2026-06-01T00:00:00.000Z');
		expect(rows[0].lastDetectedAt).toBe('2026-07-01T00:00:00.000Z');
	});

	it('deletes non-dismissed findings not re-detected this run', async () => {
		// Seed: one dismissed, one active
		await testDb.db.insert(storageInsights).values([
			{
				id: 'dismissed-1',
				insightType: 'orphaned-files',
				severity: 'warning',
				scope: 'global',
				title: 'Dismissed orphaned',
				summary: '...',
				itemCount: 2,
				firstDetectedAt: '2026-06-01T00:00:00.000Z',
				lastDetectedAt: '2026-06-01T00:00:00.000Z',
				dismissedAt: '2026-06-02T00:00:00.000Z',
				dismissedBy: 'user-1'
			},
			{
				id: 'active-1',
				insightType: 'broken-paths',
				severity: 'critical',
				scope: 'global',
				title: 'Active broken path',
				summary: '...',
				itemCount: 1,
				firstDetectedAt: '2026-06-01T00:00:00.000Z',
				lastDetectedAt: '2026-06-01T00:00:00.000Z'
			}
		]);

		// Run with NO findings (both issues resolved)
		upsertInsights([], '2026-07-01T00:00:00.000Z');

		const rows = await testDb.db.select().from(storageInsights);
		// Active one deleted (resolved), dismissed one kept (audit)
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe('dismissed-1');
	});

	it('handles item-scoped findings (scopeId distinguishes rows)', async () => {
		const findings: InsightFinding[] = [
			{
				type: 'unplayed',
				severity: 'warning',
				scope: 'item',
				scopeId: 'storage-item-1',
				title: 'Movie A never played',
				summary: '...',
				itemCount: 1
			},
			{
				type: 'unplayed',
				severity: 'warning',
				scope: 'item',
				scopeId: 'storage-item-2',
				title: 'Movie B never played',
				summary: '...',
				itemCount: 1
			}
		];

		upsertInsights(findings, new Date().toISOString());

		const rows = await testDb.db.select().from(storageInsights);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.scopeId).sort()).toEqual(['storage-item-1', 'storage-item-2']);
	});
});
