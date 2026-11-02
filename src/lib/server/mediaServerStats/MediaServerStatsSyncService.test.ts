import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';

// Mock the media browser manager so no real HTTP calls happen.
vi.mock('#lib/server/notifications/mediabrowser/MediaBrowserManager.js', () => ({
	getMediaBrowserManager: () => ({
		getEnabledServers: vi.fn().mockResolvedValue([]),
		testServer: vi.fn().mockResolvedValue({ success: true })
	})
}));

// Mock the db module with an in-memory sqlite instance.
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';
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

import { MediaServerStatsSyncService } from './MediaServerStatsSyncService.js';

describe('MediaServerStatsSyncService sync state tracking', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('emits syncStart and syncStop even when there are no servers', async () => {
		const service = new MediaServerStatsSyncService();

		const startEvents: { timestamp: string }[] = [];
		const stopEvents: { timestamp: string }[] = [];

		service.on('syncStart', (e) => startEvents.push(e));
		service.on('syncStop', (e) => stopEvents.push(e));

		expect(service.currentlySyncing).toBe(false);

		await service.syncServer();

		expect(service.currentlySyncing).toBe(false);
		expect(startEvents).toHaveLength(1);
		expect(stopEvents).toHaveLength(1);
		expect(startEvents[0].timestamp).toEqual(expect.any(String));
		expect(stopEvents[0].timestamp).toEqual(expect.any(String));
	});

	it('clears handlers via off() correctly', async () => {
		const service = new MediaServerStatsSyncService();

		const startEvents: { timestamp: string }[] = [];
		const handler = (e: { timestamp: string }) => startEvents.push(e);
		service.on('syncStart', handler);
		service.off('syncStart', handler);

		await service.syncServer();

		expect(startEvents).toHaveLength(0);
	});

	it('tracks concurrently during overlapping syncServer calls', async () => {
		const service = new MediaServerStatsSyncService();

		const startEvents: unknown[] = [];
		const stopEvents: unknown[] = [];
		service.on('syncStart', () => startEvents.push({}));
		service.on('syncStop', () => stopEvents.push({}));

		// Run two in parallel; both start before either finishes (no servers =>
		// both resolve quickly, but Promise.all kicks them off together).
		await Promise.all([service.syncServer(), service.syncServer()]);

		// 0->1 transition emits syncStart once; subsequent entries do not.
		// 1->0 transition emits syncStop once; intermediate exits do not.
		// Total: at least one start, at least one stop, with starts >= stops
		// while in flight.
		expect(startEvents.length).toBeGreaterThanOrEqual(1);
		expect(stopEvents.length).toBeGreaterThanOrEqual(1);
		expect(service.currentlySyncing).toBe(false);
	});
});
