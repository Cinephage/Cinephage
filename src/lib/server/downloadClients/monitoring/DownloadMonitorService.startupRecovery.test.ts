/**
 * Crash recovery (issue: queue items stuck in 'importing' forever):
 * a process restart mid-import loses the in-memory worker that would have
 * completed it, and markImporting()'s atomic guard treats 'importing' as
 * "another process already has this" - so without a startup reset, a row
 * stuck here is never picked up again and the UI shows it as permanently
 * "active" even though nothing is actually processing it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, clearTestDb, type TestDatabase } from '../../../../test/db-helper';
import { downloadClients, downloadQueue } from '#lib/server/db/schema.js';

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

// No enabled clients - performStartupSync returns right after the recovery
// step this test targets, so nothing else needs mocking.
vi.mock('../DownloadClientManager', () => ({
	getDownloadClientManager: () => ({
		getEnabledClients: () => Promise.resolve([])
	})
}));

const { getDownloadMonitor } = await import('./DownloadMonitorService');

const CLIENT_ID = randomUUID();

beforeEach(() => {
	clearTestDb(testDb);
});

async function seedClient() {
	await testDb.db.insert(downloadClients).values({
		id: CLIENT_ID,
		name: 'qbit',
		implementation: 'qbittorrent',
		enabled: true,
		host: 'localhost',
		port: 8080,
		useSsl: false
	});
}

function makeQueueItem(overrides: Partial<typeof downloadQueue.$inferInsert>) {
	return {
		id: randomUUID(),
		downloadClientId: CLIENT_ID,
		downloadId: 'dl-1',
		title: 'Test.Release',
		protocol: 'torrent',
		...overrides
	} as typeof downloadQueue.$inferInsert;
}

describe('performStartupSync recovers queue items stuck in importing', () => {
	it('resets a stuck "importing" row to "completed" so it gets picked up again', async () => {
		await seedClient();
		const stuck = makeQueueItem({ status: 'importing' });
		await testDb.db.insert(downloadQueue).values(stuck);

		const service = getDownloadMonitor() as unknown as {
			performStartupSync: () => Promise<void>;
		};
		await service.performStartupSync();

		const [row] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, stuck.id!));
		expect(row.status).toBe('completed');
	});

	it('leaves rows that are not stuck importing untouched', async () => {
		await seedClient();
		const downloading = makeQueueItem({ status: 'downloading' });
		const imported = makeQueueItem({ status: 'imported' });
		await testDb.db.insert(downloadQueue).values(downloading);
		await testDb.db.insert(downloadQueue).values(imported);

		const service = getDownloadMonitor() as unknown as {
			performStartupSync: () => Promise<void>;
		};
		await service.performStartupSync();

		const rows = await testDb.db.select().from(downloadQueue);
		const byId = new Map(rows.map((r) => [r.id, r.status]));
		expect(byId.get(downloading.id!)).toBe('downloading');
		expect(byId.get(imported.id!)).toBe('imported');
	});
});
