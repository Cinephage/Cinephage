/**
 * Integration tests for the two-tier stalled download policy in
 * DownloadMonitorService.handleStalledDownloads.
 *
 * Policy (2026-08-27 audit follow-up): stalling is not inherently bad —
 * torrents routinely resume when a seeder returns. Two tiers:
 * - Low progress (at/below threshold): removed after a LONG window (3 days,
 *   was 1 hour) — these never got off the ground.
 * - Meaningful progress (above threshold): previously never reaped (zombie
 *   accumulation); now removed after an even longer window (14 days) so the
 *   system eventually tries a different release.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, clearTestDb } from '../../../../test/db-helper';
import { downloadClients, downloadQueue } from '#lib/server/db/schema.js';

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

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const addToBlocklist = vi.fn().mockResolvedValue(undefined);
vi.mock('#lib/server/monitoring/specifications/BlocklistSpecification.js', () => ({
	blocklistService: { addToBlocklist }
}));

const removeDownload = vi.fn().mockResolvedValue(undefined);
vi.mock('../DownloadClientManager', () => ({
	getDownloadClientManager: () => ({
		getClientInstance: vi.fn().mockResolvedValue({ removeDownload })
	})
}));

const { getDownloadMonitor } = await import('./DownloadMonitorService');

const CLIENT_ID = randomUUID();

const THREE_DAYS_MS = 3 * 24 * 60 * 60_000;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60_000;

async function insertStalledRow(
	stalledAgoMs: number,
	progress: number
): Promise<typeof downloadQueue.$inferSelect> {
	const id = randomUUID();
	await testDb.db.insert(downloadQueue).values({
		id,
		downloadClientId: CLIENT_ID,
		downloadId: `hash-${id}`,
		infoHash: `info-${id}`,
		title: `Test.Stalled.${id}`,
		protocol: 'torrent',
		status: 'stalled',
		progress: String(progress),
		stalledSince: new Date(Date.now() - stalledAgoMs).toISOString(),
		addedAt: new Date(Date.now() - stalledAgoMs - 60 * 60_000).toISOString()
	});
	const [row] = await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, id));
	return row;
}

async function getRow(id: string) {
	const [row] = await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, id));
	return row;
}

async function runStalledHandler() {
	const service = getDownloadMonitor();
	// @ts-expect-error - exercising the private handler directly
	await service.handleStalledDownloads();
}

beforeAll(async () => {});

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(async () => {
	clearTestDb(testDb);
	removeDownload.mockClear();
	addToBlocklist.mockClear();
	await testDb.db.insert(downloadClients).values({
		id: CLIENT_ID,
		name: 'qbit',
		implementation: 'qbittorrent',
		enabled: true,
		host: 'localhost',
		port: 8080,
		useSsl: false,
		movieCategory: 'movies',
		tvCategory: 'tv'
	});
});

describe('two-tier stalled download policy', () => {
	it('does NOT remove a 0%-stalled torrent after 2 days (old default was 1 hour)', async () => {
		await insertStalledRow(2 * 24 * 60 * 60_000, 0);

		await runStalledHandler();

		const row = await getRow((await testDb.db.select().from(downloadQueue).limit(1))[0].id);
		expect(removeDownload).not.toHaveBeenCalled();
		expect(row?.status).toBe('stalled');
	});

	it('removes a 0%-stalled torrent after 3+ days of zero progress', async () => {
		await insertStalledRow(THREE_DAYS_MS + 60 * 60_000, 0);

		await runStalledHandler();

		expect(removeDownload).toHaveBeenCalledTimes(1);
		expect(addToBlocklist).toHaveBeenCalledTimes(1);
	});

	it('does NOT remove a 50%-stalled torrent after 3 days (long tier owns it)', async () => {
		await insertStalledRow(THREE_DAYS_MS + 60 * 60_000, 0.5);

		await runStalledHandler();

		expect(removeDownload).not.toHaveBeenCalled();
	});

	it('does NOT remove a 50%-stalled torrent after 13 days (still inside the long window)', async () => {
		await insertStalledRow(13 * 24 * 60 * 60_000, 0.5);

		await runStalledHandler();

		expect(removeDownload).not.toHaveBeenCalled();
	});

	it('removes a 50%-stalled torrent after 14+ days of zero progress (zombie reap)', async () => {
		await insertStalledRow(FOURTEEN_DAYS_MS + 60 * 60_000, 0.5);

		await runStalledHandler();

		expect(removeDownload).toHaveBeenCalledTimes(1);
		expect(addToBlocklist).toHaveBeenCalledTimes(1);
	});

	it('resets the search cooldown so the media is re-searched after a reap', async () => {
		const row = await insertStalledRow(FOURTEEN_DAYS_MS + 60 * 60_000, 0.5);

		await runStalledHandler();

		const updated = await getRow(row.id);
		expect(updated?.status).toBe('failed');
	});
});
