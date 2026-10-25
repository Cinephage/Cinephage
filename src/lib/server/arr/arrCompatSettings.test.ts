import { describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDatabase } from '../../../test/db-helper.js';

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

const { isArrCompatEnabled, setArrCompatEnabled } = await import('./arrCompatSettings.js');

describe('arrCompatSettings', () => {
	it('defaults to disabled when no setting has been saved', () => {
		expect(isArrCompatEnabled()).toBe(false);
	});

	it('persists true/false across reads', () => {
		setArrCompatEnabled(true);
		expect(isArrCompatEnabled()).toBe(true);

		setArrCompatEnabled(false);
		expect(isArrCompatEnabled()).toBe(false);
	});
});
