import { describe, expect, it, vi, afterEach, afterAll } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper';
import type { LiveTvAccountInput } from '#lib/types/livetv.js';

/**
 * In-memory database backing createAccount's insert. The mock defers access
 * via getters so module import order stays simple.
 */
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

import { LiveTvAccountManager } from './LiveTvAccountManager';

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	destroyTestDb(testDb);
});

function createStalkerInput(language?: string): LiveTvAccountInput {
	return {
		name: 'My Portal',
		providerType: 'stalker',
		stalkerConfig: {
			portalUrl: 'http://portal.example.com/c',
			macAddress: '00:1a:79:00:00:01',
			...(language !== undefined ? { language } : {})
		}
	};
}

describe('LiveTvAccountManager stalker language threading', () => {
	it('defaults the language to English when not provided', async () => {
		// probeStalkerEndpoint probes the portal; offline portals fall back to
		// the heuristic endpoint, which is all this test needs.
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

		const manager = new LiveTvAccountManager();
		const account = await manager.createAccount(createStalkerInput(), false);

		expect(account.stalkerConfig?.language).toBe('en');
		expect(account.stalkerConfig?.macAddress).toBe('00:1A:79:00:00:01');
	});

	it('persists the configured language', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

		const manager = new LiveTvAccountManager();
		const account = await manager.createAccount(createStalkerInput('ru'), false);

		expect(account.stalkerConfig?.language).toBe('ru');
	});

	it('reduces regional variants to the base 2-letter code', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

		const manager = new LiveTvAccountManager();
		const account = await manager.createAccount(createStalkerInput('pt-BR'), false);

		expect(account.stalkerConfig?.language).toBe('pt');
	});
});
