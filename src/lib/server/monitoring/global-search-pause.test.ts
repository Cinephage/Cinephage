import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper';
import { monitoringSettings } from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

const { isAutoSearchGloballyPaused, setAutoSearchGloballyPaused } =
	await import('./global-search-pause');

beforeEach(() => {
	testDb.db.delete(monitoringSettings).run();
});

afterAll(() => destroyTestDb(testDb));

describe('global-search-pause', () => {
	it('defaults to not paused when the setting has never been written', async () => {
		expect(await isAutoSearchGloballyPaused()).toBe(false);
	});

	it('round-trips pausing and resuming', async () => {
		await setAutoSearchGloballyPaused(true);
		expect(await isAutoSearchGloballyPaused()).toBe(true);

		await setAutoSearchGloballyPaused(false);
		expect(await isAutoSearchGloballyPaused()).toBe(false);
	});
});
