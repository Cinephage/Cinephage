import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { api } from '../../../../../test/api-helper';
import { createTestDb, destroyTestDb, clearTestDb } from '../../../../../test/db-helper';
import { downloadQueue, downloadClients } from '#lib/server/db/schema.js';

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

const failBlocklistAndSearch = vi.fn();
vi.mock('#lib/server/downloadClients/monitoring/index.js', () => ({
	getDownloadMonitor: () => ({ failBlocklistAndSearch })
}));

const { POST } = await import('./+server');

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(async () => {
	clearTestDb(testDb);
	failBlocklistAndSearch.mockReset().mockResolvedValue(true);
	await testDb.db.insert(downloadClients).values({
		id: 'client-1',
		name: 'qbit',
		implementation: 'qbittorrent',
		enabled: true,
		host: 'localhost',
		port: 8080,
		useSsl: false
	});
});

async function insertRow(status: string, protocol = 'torrent') {
	const id = `q-${status}-${protocol}`;
	await testDb.db.insert(downloadQueue).values({
		id,
		downloadClientId: 'client-1',
		downloadId: `hash-${id}`,
		title: 'Some.Release',
		protocol,
		status
	});
	return id;
}

describe('POST /api/queue/[id]/fail-and-search', () => {
	it('fails, blocklists and searches an active download', async () => {
		const id = await insertRow('stalled');
		const { status } = await api.post(POST, undefined, { params: { id } });
		expect(status).toBe(200);
		expect(failBlocklistAndSearch).toHaveBeenCalledWith(id);
	});

	it('refuses a download that is not active', async () => {
		const id = await insertRow('completed');
		const { status } = await api.post(POST, undefined, { params: { id } });
		expect(status).toBe(400);
		expect(failBlocklistAndSearch).not.toHaveBeenCalled();
	});

	it('reports when the client could not be reached', async () => {
		failBlocklistAndSearch.mockResolvedValue(false);
		const id = await insertRow('downloading');
		const { status } = await api.post(POST, undefined, { params: { id } });
		expect(status).toBe(502);
	});

	it('404s for an unknown item', async () => {
		const { status } = await api.post(POST, undefined, { params: { id: 'nope' } });
		expect(status).toBe(404);
	});

	it('is admin only', async () => {
		const id = await insertRow('stalled');
		const { status } = await api.post(POST, undefined, { params: { id }, auth: 'user' });
		expect(status).toBe(403);
	});
});
