import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper.js';
import { libraries, storageInsights } from '#lib/server/db/schema.js';

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

vi.mock('#lib/server/storage/reconciliation/ReconciliationService.js', () => ({
	getReconciliationService: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() })
}));

import { getInsightsService, __resetInsightsServiceForTests } from './InsightsService.js';

describe('InsightsService', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(async () => {
		__resetInsightsServiceForTests();
		// clearTestDb does not wipe libraries/rootFolders; migrations seed system
		// libraries (with no root folder) which HealthIssuesRule would flag. Clear
		// them so the DB is genuinely empty for a zero-findings baseline.
		testDb.db.delete(libraries).run();
		await clearTestDb(testDb);
	});

	it('has correct BackgroundService metadata', () => {
		const service = getInsightsService();
		expect(service.name).toBe('InsightsService');
		expect(typeof service.start).toBe('function');
		expect(typeof service.stop).toBe('function');
		expect(['pending', 'starting', 'ready', 'error']).toContain(service.status);
	});

	it('runAllRules returns skipped=true when lock is held', async () => {
		const service = getInsightsService();
		// Manually hold the lock by triggering two concurrent runs
		const first = service.runAllRules();
		const second = await service.runAllRules();
		await first;
		expect(second.skipped).toBe(true);
	});

	it('produces zero findings on an empty library', async () => {
		const service = getInsightsService();
		const result = await service.runAllRules();
		expect(result.skipped).toBe(false);
		expect(result.findingsCount).toBe(0);
		expect(await testDb.db.select().from(storageInsights)).toHaveLength(0);
	});
});
