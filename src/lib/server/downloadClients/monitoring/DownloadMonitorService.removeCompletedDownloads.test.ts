/**
 * Tests for DownloadMonitorService.removeCompletedDownloads.
 *
 * Drives the real private method against a real in-memory DB, asserting the
 * #559 contract: imported-but-still-seeding torrents stay in the queue until
 * the client itself reports canBeRemoved, at which point the torrent is
 * removed (with data for torrents) and the queue row is cleaned up.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, clearTestDb } from '../../../../test/db-helper';
import { downloadClients, downloadQueue } from '#lib/server/db/schema.js';
import type { DownloadClient } from '#lib/types/downloadClient.js';
import type { IDownloadClient } from '../core/interfaces';
import type { DownloadInfo } from '#lib/server/downloadClients/core/interfaces.js';

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

const { getDownloadMonitor } = await import('./DownloadMonitorService');

const CLIENT_ID = randomUUID();
let baseDir: string;

function makeClient(overrides: Partial<DownloadClient> = {}): DownloadClient {
	return {
		id: CLIENT_ID,
		name: 'test',
		implementation: 'transmission',
		enabled: true,
		host: 'localhost',
		port: 9091,
		useSsl: false,
		hasPassword: false,
		hasApiToken: false,
		// Matches the migration backfill: existing clients keep auto-removal.
		removeAfterImport: true,
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

function makeInstance(download: DownloadInfo | null): IDownloadClient & {
	removeDownload: ReturnType<typeof vi.fn>;
} {
	const removeDownload = vi.fn().mockResolvedValue(undefined);
	return {
		implementation: 'transmission',
		getDownload: vi.fn().mockResolvedValue(download),
		getDownloads: vi.fn().mockResolvedValue(download ? [download] : []),
		removeDownload
	} as unknown as IDownloadClient & { removeDownload: ReturnType<typeof vi.fn> };
}

function makeDownload(overrides: Partial<DownloadInfo> = {}): DownloadInfo {
	return {
		id: 'deadbeef',
		name: 'Test.Release',
		hash: 'deadbeef',
		progress: 1,
		status: 'seeding',
		size: 1000,
		downloadSpeed: 0,
		uploadSpeed: 0,
		savePath: baseDir,
		contentPath: join(baseDir, 'Test.Release'),
		canMoveFiles: false,
		canBeRemoved: false,
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
		downloadId: 'deadbeef',
		infoHash: 'deadbeef',
		title: 'Test.Release',
		protocol: 'torrent',
		status: 'seeding-imported',
		addedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
		...overrides
	});
	const [row] = await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, id));
	return row;
}

async function callRemoveCompleted(
	client: DownloadClient,
	instance: IDownloadClient
): Promise<void> {
	const service = getDownloadMonitor();
	// @ts-expect-error - exercising the private cleanup method directly
	await service.removeCompletedDownloads([{ client, instance }]);
}

async function rowExists(id: string): Promise<boolean> {
	const [row] = await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, id));
	return !!row;
}

beforeAll(async () => {
	baseDir = join(tmpdir(), `cinephage-rcd-${randomUUID().slice(0, 8)}`);
});

afterAll(async () => {
	destroyTestDb(testDb);
	await rm(baseDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
	clearTestDb(testDb);
	await testDb.db.insert(downloadClients).values({
		id: CLIENT_ID,
		name: 'test',
		implementation: 'transmission',
		host: 'localhost',
		port: 9091
	});
});

describe('removeCompletedDownloads', () => {
	it('keeps a seeding-imported row whose torrent is still seeding', async () => {
		const row = await insertQueueRow();
		const instance = makeInstance(makeDownload({ status: 'seeding', canBeRemoved: false }));

		await callRemoveCompleted(makeClient(), instance);

		expect(await rowExists(row.id)).toBe(true);
		expect(instance.removeDownload).not.toHaveBeenCalled();
	});

	it('removes the torrent with data and deletes the row once canBeRemoved', async () => {
		const row = await insertQueueRow();
		const instance = makeInstance(makeDownload({ status: 'completed', canBeRemoved: true }));

		await callRemoveCompleted(makeClient(), instance);

		expect(instance.removeDownload).toHaveBeenCalledWith('deadbeef', true);
		expect(await rowExists(row.id)).toBe(false);
	});

	it('deletes the row without touching the client when the torrent is already gone', async () => {
		const row = await insertQueueRow();
		const instance = makeInstance(null);

		await callRemoveCompleted(makeClient(), instance);

		expect(instance.removeDownload).not.toHaveBeenCalled();
		expect(await rowExists(row.id)).toBe(false);
	});

	it('removes usenet imports without the delete-files flag', async () => {
		const row = await insertQueueRow({
			protocol: 'usenet',
			status: 'imported',
			infoHash: null
		});
		const instance = makeInstance(makeDownload({ status: 'completed', canBeRemoved: true }));

		await callRemoveCompleted(makeClient(), instance);

		expect(instance.removeDownload).toHaveBeenCalledWith('deadbeef', false);
		expect(await rowExists(row.id)).toBe(false);
	});

	it('keeps the row and torrent when the client policy disables removal', async () => {
		const row = await insertQueueRow();
		const instance = makeInstance(makeDownload({ status: 'completed', canBeRemoved: true }));

		await callRemoveCompleted(makeClient({ removeAfterImport: false }), instance);

		expect(instance.removeDownload).not.toHaveBeenCalled();
		expect(await rowExists(row.id)).toBe(true);
	});

	it('leaves rows for clients that are not enabled', async () => {
		const row = await insertQueueRow();
		const otherClient = makeClient({ id: randomUUID() });
		const instance = makeInstance(makeDownload({ status: 'completed', canBeRemoved: true }));

		await callRemoveCompleted(otherClient, instance);

		expect(await rowExists(row.id)).toBe(true);
		expect(instance.removeDownload).not.toHaveBeenCalled();
	});
});
