/**
 * Integration tests for the REAL DownloadMonitorService.handleMissingDownload
 * recovery + awaiting-backoff logic.
 *
 * Unlike DownloadMonitorService.recovery.test.ts (which exercises an inline copy
 * of buildTorrentRecoveryPath), these drive the actual private method against a
 * real in-memory DB and a real temp filesystem, asserting the DB transitions and
 * that import is requested for recovered items.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, clearTestDb } from '../../../../test/db-helper';
import { downloadClients, downloadQueue } from '#lib/server/db/schema.js';
import type { DownloadClient } from '#lib/types/downloadClient.js';
import type { DownloadInfo } from '../core/interfaces';

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
		name: 'qbit',
		implementation: 'qbittorrent',
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
		downloadId: `hash-${id}`,
		title: `Test.Release.${id}`,
		protocol: 'torrent',
		status: 'downloading',
		// Well past the torrent missing grace period so recovery actually runs.
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
		progress: 0.5,
		status: 'downloading',
		size: 1_000,
		downloadSpeed: 1,
		uploadSpeed: 0,
		savePath: baseDir,
		contentPath: join(baseDir, 'active-download'),
		canMoveFiles: false,
		canBeRemoved: false,
		...overrides
	};
}

async function callHandleMissing(
	row: typeof downloadQueue.$inferSelect,
	client: DownloadClient,
	allDownloads: DownloadInfo[] = []
) {
	const service = getDownloadMonitor();
	// @ts-expect-error - exercising the private recovery method directly
	await service.handleMissingDownload(row, client, allDownloads);
}

beforeAll(async () => {
	baseDir = join(tmpdir(), `cinephage-hmd-${randomUUID().slice(0, 8)}`);
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
		name: 'qbit',
		implementation: 'qbittorrent',
		host: 'localhost',
		port: 8080
	});
});

describe('handleMissingDownload — initial recovery (vanished download)', () => {
	it('Tier 1: recovers when the stored outputPath still exists', async () => {
		const dir = join(baseDir, 'tier1', randomUUID());
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'file.mkv'), 'x');

		const row = await insertQueueRow({ outputPath: dir, progress: '1' });
		await callHandleMissing(row, makeClient());

		const after = await getRow(row.id);
		expect(after.status).toBe('completed');
		expect(after.errorMessage).toBeNull();
		expect(requestImport).toHaveBeenCalledWith(row.id);
	});

	it('Tier 2: recovers via reconstructed completed path and updates outputPath', async () => {
		const folder = `Show.S01E01.${randomUUID().slice(0, 6)}`;
		const completed = join(baseDir, 'movies', folder);
		await mkdir(completed, { recursive: true });
		await writeFile(join(completed, 'file.mkv'), 'x');

		const stale = join(baseDir, '.incomplete', folder); // does NOT exist
		const row = await insertQueueRow({ outputPath: stale, progress: '1' });
		await callHandleMissing(row, makeClient());

		const after = await getRow(row.id);
		expect(after.status).toBe('completed');
		expect(resolve(after.outputPath!)).toBe(resolve(completed));
		expect(requestImport).toHaveBeenCalledWith(row.id);
	});

	it('both tiers miss → transitions to awaiting (not failed)', async () => {
		const stale = join(baseDir, '.incomplete', `Missing.${randomUUID().slice(0, 6)}`);
		const row = await insertQueueRow({ outputPath: stale, progress: '1' });
		await callHandleMissing(row, makeClient());

		const after = await getRow(row.id);
		expect(after.status).toBe('awaiting');
		expect(after.importAttempts).toBe(1);
		expect(after.lastAttemptAt).not.toBeNull();
		expect(requestImport).not.toHaveBeenCalled();
	});

	// The #532 regressions: stat() success alone must never mark a vanished
	// download complete when the path belongs to the client, another active
	// download, or only holds partial data.

	it('does not recover from the client save-path root', async () => {
		await writeFile(join(baseDir, 'unrelated.mkv'), 'x');
		const row = await insertQueueRow({ outputPath: baseDir, progress: '1' });

		await callHandleMissing(row, makeClient());

		const after = await getRow(row.id);
		expect(after.status).toBe('awaiting');
		expect(requestImport).not.toHaveBeenCalled();
	});

	it('does not recover from a configured category root', async () => {
		const categoryRoot = join(baseDir, 'movies');
		await mkdir(categoryRoot, { recursive: true });
		await writeFile(join(categoryRoot, 'unrelated.mkv'), 'x');
		const row = await insertQueueRow({ outputPath: categoryRoot, progress: '1' });

		await callHandleMissing(row, makeClient());

		const after = await getRow(row.id);
		expect(after.status).toBe('awaiting');
		expect(requestImport).not.toHaveBeenCalled();
	});

	it('does not recover a path inside another active download', async () => {
		const activePath = join(baseDir, 'other-active', randomUUID());
		const candidate = join(activePath, 'nested');
		await mkdir(candidate, { recursive: true });
		await writeFile(join(candidate, 'file.mkv'), 'x');
		const row = await insertQueueRow({ outputPath: candidate, progress: '1' });

		await callHandleMissing(row, makeClient(), [makeDownload({ contentPath: activePath })]);

		const after = await getRow(row.id);
		expect(after.status).toBe('awaiting');
		expect(requestImport).not.toHaveBeenCalled();
	});

	it('does not recover an ancestor of another active download path', async () => {
		const candidate = join(baseDir, 'active-parent', randomUUID());
		const activePath = join(candidate, 'torrent-folder');
		await mkdir(activePath, { recursive: true });
		await writeFile(join(activePath, 'file.mkv'), 'x');
		const row = await insertQueueRow({ outputPath: candidate, progress: '1' });

		await callHandleMissing(row, makeClient(), [makeDownload({ contentPath: activePath })]);

		const after = await getRow(row.id);
		expect(after.status).toBe('awaiting');
		expect(requestImport).not.toHaveBeenCalled();
	});

	it('does not recover a partially downloaded torrent even when its files are fully allocated', async () => {
		const candidate = join(baseDir, 'partial', randomUUID());
		await mkdir(candidate, { recursive: true });
		await writeFile(join(candidate, 'file.mkv'), Buffer.alloc(2 * 1024 * 1024));
		const row = await insertQueueRow({
			outputPath: candidate,
			progress: '0.5',
			size: 2 * 1024 * 1024
		});

		await callHandleMissing(row, makeClient());

		const after = await getRow(row.id);
		expect(after.status).toBe('awaiting');
		expect(requestImport).not.toHaveBeenCalled();
	});

	it('applies the active-download guard to the reconstructed Tier 2 path', async () => {
		const folder = `Tier2.Active.${randomUUID().slice(0, 6)}`;
		const candidate = join(baseDir, 'movies', folder);
		const activePath = join(candidate, 'active-torrent');
		await mkdir(activePath, { recursive: true });
		await writeFile(join(activePath, 'file.mkv'), 'x');
		const stale = join(baseDir, '.incomplete', folder);
		const row = await insertQueueRow({ outputPath: stale, progress: '1' });

		await callHandleMissing(row, makeClient(), [makeDownload({ contentPath: activePath })]);

		const after = await getRow(row.id);
		expect(after.status).toBe('awaiting');
		expect(requestImport).not.toHaveBeenCalled();
	});

	it('still recovers when the download owning the path is finished', async () => {
		const candidate = join(baseDir, 'finished-owner', randomUUID());
		await mkdir(candidate, { recursive: true });
		await writeFile(join(candidate, 'file.mkv'), 'x');
		const row = await insertQueueRow({ outputPath: candidate, progress: '1' });

		await callHandleMissing(row, makeClient(), [
			makeDownload({ contentPath: candidate, progress: 1, status: 'seeding' })
		]);

		const after = await getRow(row.id);
		expect(after.status).toBe('completed');
		expect(requestImport).toHaveBeenCalledWith(row.id);
	});

	it.skipIf(process.platform === 'win32')(
		'does not recover sparse incomplete content',
		async () => {
			const candidate = join(baseDir, 'sparse', randomUUID());
			await mkdir(candidate, { recursive: true });
			const sparseFile = join(candidate, 'file.mkv');
			const { open } = await import('fs/promises');
			const handle = await open(sparseFile, 'w');
			await handle.truncate(100 * 1024 * 1024);
			await handle.close();
			const row = await insertQueueRow({
				outputPath: candidate,
				progress: '1',
				size: 100 * 1024 * 1024
			});

			await callHandleMissing(row, makeClient());

			const after = await getRow(row.id);
			expect(after.status).toBe('awaiting');
			expect(requestImport).not.toHaveBeenCalled();
		}
	);
});

describe('handleMissingDownload — awaiting backoff retry', () => {
	it('re-checks Tier 1 (stored outputPath) on retry once files appear (delayed sync)', async () => {
		// The fix: awaiting retry must re-stat the stored outputPath, not only Tier 2.
		const dir = join(baseDir, 'awaiting-tier1', randomUUID());
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'file.mkv'), 'x');

		const row = await insertQueueRow({
			status: 'awaiting',
			outputPath: dir,
			progress: '1',
			importAttempts: 1,
			// 10 min ago > 5 min backoff for attempt 1
			lastAttemptAt: new Date(Date.now() - 10 * 60_000).toISOString()
		});
		await callHandleMissing(row, makeClient({ downloadPathLocal: null }));

		const after = await getRow(row.id);
		expect(after.status).toBe('completed');
		expect(requestImport).toHaveBeenCalledWith(row.id);
	});

	it('does nothing while still inside the backoff window', async () => {
		const stale = join(baseDir, '.incomplete', `Nope.${randomUUID().slice(0, 6)}`);
		const row = await insertQueueRow({
			status: 'awaiting',
			outputPath: stale,
			importAttempts: 1,
			lastAttemptAt: new Date().toISOString() // just now → within 5 min backoff
		});
		await callHandleMissing(row, makeClient());

		const after = await getRow(row.id);
		expect(after.status).toBe('awaiting');
		expect(after.importAttempts).toBe(1);
		expect(requestImport).not.toHaveBeenCalled();
	});

	it('increments the attempt counter when recovery still fails', async () => {
		const stale = join(baseDir, '.incomplete', `Nope.${randomUUID().slice(0, 6)}`);
		const row = await insertQueueRow({
			status: 'awaiting',
			outputPath: stale,
			importAttempts: 2,
			lastAttemptAt: new Date(Date.now() - 60 * 60_000).toISOString()
		});
		await callHandleMissing(row, makeClient());

		const after = await getRow(row.id);
		expect(after.status).toBe('awaiting');
		expect(after.importAttempts).toBe(3);
		expect(requestImport).not.toHaveBeenCalled();
	});

	it('gives up after 12 attempts → failed with recovery-exhausted message', async () => {
		const stale = join(baseDir, '.incomplete', `Gone.${randomUUID().slice(0, 6)}`);
		const row = await insertQueueRow({
			status: 'awaiting',
			outputPath: stale,
			importAttempts: 12,
			lastAttemptAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString()
		});
		await callHandleMissing(row, makeClient());

		const after = await getRow(row.id);
		expect(after.status).toBe('failed');
		expect(after.errorMessage).toContain('recovery exhausted');
		expect(requestImport).not.toHaveBeenCalled();
	});
});

describe('handleMissingDownload — completed grace period (addedAt fallback)', () => {
	it('keeps a recently-added completed item without completedAt inside the grace window', async () => {
		// No completedAt recorded: the grace period must fall back to addedAt, not Date.now(),
		// otherwise a genuinely old completion would be treated as fresh forever.
		const row = await insertQueueRow({
			status: 'completed',
			completedAt: null,
			addedAt: new Date(Date.now() - 60_000).toISOString() // 1 min ago < 5 min grace
		});
		await callHandleMissing(row, makeClient());

		const after = await getRow(row.id);
		expect(after.status).toBe('completed');
	});

	it('removes a long-completed item without completedAt once the addedAt-based grace lapses', async () => {
		const row = await insertQueueRow({
			status: 'completed',
			completedAt: null,
			addedAt: new Date(Date.now() - 30 * 60_000).toISOString() // 30 min ago > 5 min grace
		});
		await callHandleMissing(row, makeClient());

		const after = await getRow(row.id);
		expect(after.status).toBe('removed');
	});
});

describe('handleMissingDownload — permanently failed import (importFailed guard)', () => {
	/**
	 * Regression test for a real report: an item whose import attempts were
	 * already exhausted (status 'failed', importFailed true) kept getting
	 * flipped back to 'completed' and re-queued for import every monitor
	 * poll, because the "usenet download missing from client but output
	 * path still exists" recovery branch never checked importFailed before
	 * this fix - creating a tight, indefinite retry loop that made the app
	 * unresponsive.
	 */
	it('does not re-queue a usenet item for import once importFailed is set, even if the output path still exists', async () => {
		const outputPath = join(baseDir, `still-here-${randomUUID()}.mkv`);
		await writeFile(outputPath, 'x');

		const row = await insertQueueRow({
			status: 'failed',
			importFailed: true,
			protocol: 'usenet',
			outputPath,
			completedAt: new Date(Date.now() - 60 * 60_000).toISOString()
		});

		requestImport.mockClear();
		await callHandleMissing(row, makeClient());

		expect(requestImport).not.toHaveBeenCalled();

		const after = await getRow(row.id);
		expect(after.status).toBe('failed');
	});
});
