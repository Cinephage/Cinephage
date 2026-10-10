import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper.js';
import { storageItems } from '#lib/server/db/schema.js';

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

import { UntrackedByCinephageRule } from './UntrackedByCinephageRule.js';
import type { RuleContext } from '../types.js';
import { createStorageItem } from '../../../../../test/fixtures/storage.js';

describe('UntrackedByCinephageRule', () => {
	const rule = new UntrackedByCinephageRule();

	afterAll(() => destroyTestDb(testDb));
	beforeEach(async () => {
		await clearTestDb(testDb);
	});

	it('has type "untracked-by-cinephage"', () => {
		expect(rule.type).toBe('untracked-by-cinephage');
	});

	it('counts server-only items', async () => {
		await testDb.db
			.insert(storageItems)
			.values([
				createStorageItem({ sourceSystem: 'server', tmdbId: 100, title: 'A' }),
				createStorageItem({ sourceSystem: 'local', tmdbId: 200, title: 'B' }),
				createStorageItem({ sourceSystem: 'both', tmdbId: 300, title: 'C' }),
				createStorageItem({ sourceSystem: 'server', tmdbId: 400, title: 'D' })
			]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].itemCount).toBe(2);
		expect(findings[0].severity).toBe('info');
	});

	it('summary breaks down the raw item count by movies vs series', async () => {
		await testDb.db.insert(storageItems).values([
			createStorageItem({ sourceSystem: 'server', itemType: 'movie', tmdbId: 700 }),
			createStorageItem({
				sourceSystem: 'server',
				itemType: 'episode',
				tmdbId: 800,
				seasonNumber: 1,
				episodeNumber: 1
			}),
			createStorageItem({
				sourceSystem: 'server',
				itemType: 'episode',
				tmdbId: 800,
				seasonNumber: 1,
				episodeNumber: 2
			})
		]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].itemCount).toBe(3);
		expect(findings[0].summary).toContain('3 items');
		expect(findings[0].summary).toContain('1 Movie');
		expect(findings[0].summary).toContain('1 Series');
	});

	it('returns zero findings when all items are local or both', async () => {
		await testDb.db
			.insert(storageItems)
			.values([
				createStorageItem({ sourceSystem: 'local', tmdbId: 100 }),
				createStorageItem({ sourceSystem: 'both', tmdbId: 200 })
			]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});
		expect(findings).toHaveLength(0);
	});
});
