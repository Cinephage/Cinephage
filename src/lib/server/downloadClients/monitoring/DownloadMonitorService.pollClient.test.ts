/**
 * Integration tests for the REAL DownloadMonitorService.pollClient matching.
 *
 * The poll works from a list of client downloads; these drive the actual private
 * method against a real in-memory DB and a fake client so that "row matched",
 * "row not in the list", and "one client item, two rows" are asserted as DB
 * transitions rather than as an inline copy of the logic.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, clearTestDb } from '../../../../test/db-helper';
import { downloadClients, downloadQueue } from '#lib/server/db/schema.js';
import type { DownloadClient } from '#lib/types/downloadClient.js';
import type { DownloadInfo, IDownloadClient } from '../core/interfaces';

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

const requestImport = vi.fn().mockResolvedValue({ status: 'pending' });
vi.mock('../import', () => ({
	importService: { requestImport }
}));

const { getDownloadMonitor } = await import('./DownloadMonitorService');

const CLIENT_ID = randomUUID();
let baseDir: string;

function makeClient(overrides: Partial<DownloadClient> = {}): DownloadClient {
	return {
		id: CLIENT_ID,
		name: 'sab',
		implementation: 'sabnzbd',
		enabled: true,
		host: 'localhost',
		port: 8080,
		useSsl: false,
		hasPassword: false,
		hasApiToken: false,
		removeAfterImport: false,
		allowMovies: true,
		allowTv: true,
		movieCategory: 'movies',
		tvCategory: 'tv',
		recentPriority: 'normal',
		olderPriority: 'normal',
		initialState: 'start',
		downloadPathLocal: baseDir,
		priority: 1,
		...overrides
	};
}

async function insertQueueRow(
	overrides: Partial<typeof downloadQueue.$inferInsert> = {}
): Promise<typeof downloadQueue.$inferSelect> {
	const id = randomUUID();
	await testDb.db.insert(downloadQueue).values({
		id,
		downloadClientId: CLIENT_ID,
		downloadId: `nzo-${id}`,
		title: `Same.Release.${id}`,
		protocol: 'usenet',
		status: 'downloading',
		// Past every missing-download grace period, so a missing row resolves now.
		addedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
		...overrides
	});
	const [row] = await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, id));
	return row;
}

async function getRow(id: string) {
	const [row] = await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, id));
	return row;
}

function makeDownload(overrides: Partial<DownloadInfo> = {}): DownloadInfo {
	return {
		id: randomUUID(),
		name: 'Active.Download',
		hash: randomUUID().replace(/-/g, ''),
		progress: 0.4,
		status: 'downloading',
		size: 1_000,
		downloadSpeed: 1,
		uploadSpeed: 0,
		savePath: baseDir,
		contentPath: join(baseDir, 'active'),
		canMoveFiles: false,
		canBeRemoved: false,
		...overrides
	};
}

function makeInstance(downloads: DownloadInfo[], byId: Record<string, DownloadInfo | null> = {}) {
	const instance = {
		getDownloads: vi.fn().mockResolvedValue(downloads),
		getDownload: vi.fn().mockImplementation(async (id: string) => byId[id] ?? null)
	};
	return { instance, raw: instance as unknown as IDownloadClient };
}

async function poll(
	client: DownloadClient,
	raw: IDownloadClient,
	rows: (typeof downloadQueue.$inferSelect)[]
) {
	const service = getDownloadMonitor();
	// @ts-expect-error - exercising the private poll directly
	return service.pollClient(client, raw, rows);
}

beforeAll(async () => {
	baseDir = join(tmpdir(), `cinephage-poll-${randomUUID().slice(0, 8)}`);
	await mkdir(baseDir, { recursive: true });
});

afterAll(async () => {
	destroyTestDb(testDb);
	await rm(baseDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
	clearTestDb(testDb);
	requestImport.mockClear();
	await testDb.db.insert(downloadClients).values({
		id: CLIENT_ID,
		name: 'sab',
		implementation: 'sabnzbd',
		host: 'localhost',
		port: 8080
	});
});

describe('pollClient - a row is only missing when the client says so', () => {
	it('keeps the row alive when the list omits it but the id lookup finds it', async () => {
		// The list is a page (history 100, queue 1000, category filters, two
		// history sides), so absence from it proves nothing on its own.
		const row = await insertQueueRow();
		const found = makeDownload({ hash: row.downloadId, status: 'downloading' });
		const { raw } = makeInstance([], { [row.downloadId]: found });

		await poll(makeClient(), raw, [row]);

		const after = await getRow(row.id);
		expect(after.status).toBe('downloading');
		expect(after.errorMessage).toBeNull();
	});

	it('lets the row enter recovery when the id lookup also comes back empty', async () => {
		const row = await insertQueueRow();
		const { raw } = makeInstance([], { [row.downloadId]: null });

		await poll(makeClient(), raw, [row]);

		const after = await getRow(row.id);
		expect(after.status).toBe('awaiting');
	});

	it('treats an id lookup that throws as "not found", not as a poll failure', async () => {
		const row = await insertQueueRow();
		const { instance, raw } = makeInstance([], {});
		instance.getDownload.mockRejectedValue(new Error('client offline'));

		await expect(poll(makeClient(), raw, [row])).resolves.toBeTypeOf('number');
		const after = await getRow(row.id);
		expect(after.status).toBe('awaiting');
	});
});

describe('pollClient - one client item, two rows', () => {
	it('binds the item to one row and never writes a client id into infoHash', async () => {
		const first = await insertQueueRow({ title: 'Twin.Release', downloadId: 'nzo-dead-1' });
		const second = await insertQueueRow({ title: 'Twin.Release', downloadId: 'nzo-dead-2' });
		const item = makeDownload({ name: 'Twin.Release', hash: 'live-hash-1' });
		const { raw } = makeInstance([item], { 'nzo-dead-1': null, 'nzo-dead-2': null });

		await poll(makeClient(), raw, [first, second]);

		const rows = [
			...(await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, first.id))),
			...(await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, second.id)))
		];

		const adopted = rows.filter((r) => r.downloadId === 'live-hash-1');
		const untouched = rows.filter((r) => r.downloadId !== 'live-hash-1');

		expect(adopted).toHaveLength(1);
		expect(untouched).toHaveLength(1);
		// A usenet row carries no infoHash; filling it with the nzo_id is what
		// disarmed the adoption guard for unrelated downloads.
		expect(adopted[0].infoHash).toBeNull();
		expect(untouched[0].status).toBe('awaiting');
	});
});
