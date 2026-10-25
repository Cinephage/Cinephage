import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper.js';
import { unmatchedFiles } from '#lib/server/db/schema.js';

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

import { OrphanedFilesRule } from './OrphanedFilesRule.js';
import type { RuleContext } from '../types.js';

describe('OrphanedFilesRule', () => {
	const rule = new OrphanedFilesRule();

	afterAll(() => destroyTestDb(testDb));
	beforeEach(async () => {
		// unmatchedFiles is not in clearTestDb's table list, so clear it explicitly
		testDb.db.delete(unmatchedFiles).run();
		await clearTestDb(testDb);
	});

	it('has type "orphaned-files"', () => {
		expect(rule.type).toBe('orphaned-files');
	});

	it('counts unmatched files', async () => {
		await testDb.db.insert(unmatchedFiles).values([
			{
				id: 'u-1',
				path: '/media/movies/unknown1.mkv',
				mediaType: 'movie',
				size: 1000
			},
			{
				id: 'u-2',
				path: '/media/movies/unknown2.mkv',
				mediaType: 'movie',
				size: 2000
			}
		]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].itemCount).toBe(2);
		expect(findings[0].severity).toBe('warning');
		expect(findings[0].details?.link).toBe('/library/unmatched');
	});

	it('returns zero findings when no unmatched files', async () => {
		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});
		expect(findings).toHaveLength(0);
	});
});
