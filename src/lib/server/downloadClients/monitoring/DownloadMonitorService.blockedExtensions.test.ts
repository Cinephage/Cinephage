/**
 * Integration tests for handleBlockedExtensionDownloads file-level exclusion.
 *
 * Context (2026-08-27 live audit): a RARBG release bundles RARBG_DO_NOT_MIRROR.exe.
 * The old behavior removed the ENTIRE torrent + blocklisted the release — so public
 * releases with bundled junk executables (extremely common) always died seconds
 * after grab. Security goal is that the dangerous file never reaches disk; that is
 * equally achieved by excluding the FILE via client-side file priority, keeping the
 * media download alive.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, clearTestDb } from '../../../../test/db-helper';
import { downloadClients, downloadQueue } from '#lib/server/db/schema.js';
import type { DownloadFileInfo } from '../core/interfaces';

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

vi.mock('#lib/server/settings/blocked-extensions.js', () => ({
	resolveBlockedExtensionsForQueueItem: vi.fn().mockResolvedValue([])
}));

const removeDownload = vi.fn().mockResolvedValue(undefined);
const excludeFiles = vi.fn().mockResolvedValue(undefined);

// Mutable per-test client instance handed out by the mocked manager.
let clientInstance: Record<string, unknown>;

vi.mock('../DownloadClientManager', () => ({
	getDownloadClientManager: () => ({
		getClientInstance: vi.fn().mockImplementation(() => Promise.resolve(clientInstance))
	})
}));

let filesForTest: DownloadFileInfo[] = [];

const { getDownloadMonitor } = await import('./DownloadMonitorService');

const CLIENT_ID = randomUUID();

async function insertTorrentRow(
	overrides: Partial<typeof downloadQueue.$inferInsert> = {}
): Promise<typeof downloadQueue.$inferSelect> {
	const id = randomUUID();
	await testDb.db.insert(downloadQueue).values({
		id,
		downloadClientId: CLIENT_ID,
		downloadId: `hash-${id}`,
		infoHash: `info-${id}`,
		title: `Test.Release.${id}`,
		protocol: 'torrent',
		status: 'downloading',
		addedAt: new Date().toISOString(),
		...overrides
	});
	const [row] = await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, id));
	return row;
}

async function getRow(id: string) {
	const [row] = await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, id));
	return row;
}

async function runBlockedExtensionCheck() {
	const service = getDownloadMonitor();
	// @ts-expect-error - exercising the private handler directly
	await service.handleBlockedExtensionDownloads();
}

beforeAll(async () => {});

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(async () => {
	clearTestDb(testDb);
	filesForTest = [];
	removeDownload.mockClear();
	excludeFiles.mockClear();
	clientInstance = {
		getFiles: vi.fn().mockImplementation(() => Promise.resolve(filesForTest)),
		excludeFiles,
		removeDownload
	};
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

describe('blocked extension handling — file exclusion instead of torrent removal', () => {
	it('excludes the dangerous file and keeps the download when media files exist', async () => {
		filesForTest = [
			{ index: 0, name: 'Dawn.of.the.Planet.of.the.Apes.2014/RARBG_DO_NOT_MIRROR.exe', size: 100 },
			{ index: 1, name: 'Dawn.of.the.Planet.of.the.Apes.2014/Movie.mkv', size: 2_000_000_000 }
		];
		const row = await insertTorrentRow({ infoHash: 'infohash-abc' });

		await runBlockedExtensionCheck();

		expect(excludeFiles).toHaveBeenCalledWith(expect.anything(), [0]);
		expect(removeDownload).not.toHaveBeenCalled();
		const updated = await getRow(row.id);
		expect(updated?.status).not.toBe('failed');
	});

	it('still removes the torrent when EVERY file is dangerous', async () => {
		filesForTest = [
			{ index: 0, name: 'RARBG_DO_NOT_MIRROR.exe', size: 100 },
			{ index: 1, name: 'installer.bat', size: 50 }
		];
		const row = await insertTorrentRow({ infoHash: 'infohash-all-bad' });

		await runBlockedExtensionCheck();

		expect(excludeFiles).not.toHaveBeenCalled();
		expect(removeDownload).toHaveBeenCalledWith(expect.anything(), true);
		const updated = await getRow(row.id);
		expect(updated?.status).toBe('failed');
	});

	it('falls back to full removal when the client cannot exclude files', async () => {
		filesForTest = [
			{ index: 0, name: 'RARBG_DO_NOT_MIRROR.exe', size: 100 },
			{ index: 1, name: 'Movie.mkv', size: 2_000_000_000 }
		];
		const row = await insertTorrentRow({ infoHash: 'infohash-nofallback' });

		// simulate a client without excludeFiles support
		clientInstance = {
			getFiles: vi.fn().mockImplementation(() => Promise.resolve(filesForTest)),
			removeDownload
		};

		const service = getDownloadMonitor();
		// @ts-expect-error - private handler
		await service.handleBlockedExtensionDownloads();

		expect(removeDownload).toHaveBeenCalledWith(expect.anything(), true);
		const updated = await getRow(row.id);
		expect(updated?.status).toBe('failed');
	});
});
