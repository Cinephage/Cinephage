import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { api } from '../../../../test/api-helper';
import { createTestDb, destroyTestDb, clearTestDb } from '../../../../test/db-helper';
import { downloadQueue, downloadClients, blocklist } from '#lib/server/db/schema.js';

const testDb = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const { DELETE } = await import('./+server');

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(async () => {
	clearTestDb(testDb);
	await testDb.db.insert(downloadClients).values({
		id: 'client-1',
		name: 'Test Client',
		implementation: 'sabnzbd',
		enabled: true,
		host: 'localhost',
		port: 8080,
		useSsl: false,
		movieCategory: 'movies',
		tvCategory: 'tv'
	});
});

async function insertQueueRow(overrides: Partial<typeof downloadQueue.$inferInsert> = {}) {
	const id = overrides.id ?? 'queue-item-1';
	await testDb.db.insert(downloadQueue).values({
		id,
		downloadClientId: 'client-1',
		downloadId: `dl-${id}`,
		title: 'Some.Release.2024',
		protocol: 'usenet',
		status: 'failed',
		addedAt: new Date().toISOString(),
		...overrides
	});
	return id;
}

describe('DELETE /api/queue/[id] with ?blocklist=true', () => {
	it('adds a usenet release (no infoHash) to the blocklist', async () => {
		const id = await insertQueueRow({ protocol: 'usenet', infoHash: null });

		const { status } = await api.delete(DELETE, undefined, {
			params: { id },
			url: `http://localhost/api/queue/${id}?removeFromClient=false&blocklist=true`
		});

		expect(status).toBe(200);
		const entries = await testDb.db
			.select()
			.from(blocklist)
			.where(eq(blocklist.title, 'Some.Release.2024'));
		expect(entries).toHaveLength(1);
		expect(entries[0].reason).toBe('manual');
	});

	it('adds a torrent release (has infoHash) to the blocklist', async () => {
		const id = await insertQueueRow({ protocol: 'torrent', infoHash: 'deadbeef' });

		await api.delete(DELETE, undefined, {
			params: { id },
			url: `http://localhost/api/queue/${id}?removeFromClient=false&blocklist=true`
		});

		const entries = await testDb.db
			.select()
			.from(blocklist)
			.where(eq(blocklist.title, 'Some.Release.2024'));
		expect(entries).toHaveLength(1);
		expect(entries[0].infoHash).toBe('deadbeef');
	});

	it('does not touch the blocklist when the flag is not set', async () => {
		const id = await insertQueueRow();

		await api.delete(DELETE, undefined, {
			params: { id },
			url: `http://localhost/api/queue/${id}?removeFromClient=false`
		});

		const entries = await testDb.db
			.select()
			.from(blocklist)
			.where(eq(blocklist.title, 'Some.Release.2024'));
		expect(entries).toHaveLength(0);
	});
});
