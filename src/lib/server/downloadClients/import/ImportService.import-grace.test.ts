/**
 * #668: a download client can report a download as finished long before the
 * files are visible to Cinephage (seedbox sync, slow mount). That must not be
 * a terminal failure inside the configured grace window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb, clearTestDb, type TestDatabase } from '../../../../test/db-helper';
import { downloadClients, downloadQueue, movies, rootFolders } from '#lib/server/db/schema.js';

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

const markFailed = vi.fn();
vi.mock('../monitoring/DownloadMonitorService', () => ({
	downloadMonitor: {
		markImporting: vi.fn(async () => 'success'),
		markImported: vi.fn(),
		markFailed: (...args: unknown[]) => markFailed(...args)
	}
}));

vi.mock('../DownloadClientManager', () => ({
	getDownloadClientManager: () => ({
		getEnabledClients: async () => [],
		getClientInstance: async () => undefined
	})
}));

const { ImportService } = await import('./ImportService');
const { setFileManagementSettings, invalidateFileManagementCache } =
	await import('#lib/server/settings/file-management.js');

const DOWNLOAD_CLIENT_ID = 'dc-import-grace';
const ROOT = '/tmp/cinephage-import-grace-root';

async function seedMovie(movieId: string) {
	await testDb.db
		.insert(rootFolders)
		.values({ id: 'rf-grace', name: 'Movies', path: ROOT, mediaType: 'movie' })
		.onConflictDoNothing();
	await testDb.db.insert(movies).values({
		id: movieId,
		tmdbId: 4242,
		title: 'Grace Test',
		year: 2026,
		path: 'Grace Test (2026)',
		rootFolderId: 'rf-grace',
		hasFile: false
	});
}

async function runImport(id: string) {
	const service = ImportService.getInstance();
	return (
		service as unknown as {
			_processImport: (
				id: string,
				correlationId: string
			) => Promise<{ success: boolean; error?: string }>;
		}
	)._processImport(id, 'test-correlation');
}

describe('import grace period (#668)', () => {
	let downloadPath: string;

	beforeEach(async () => {
		clearTestDb(testDb);
		markFailed.mockReset();
		invalidateFileManagementCache();
		downloadPath = await mkdtemp(join(tmpdir(), 'cp-grace-'));
		await testDb.db.insert(downloadClients).values({
			id: DOWNLOAD_CLIENT_ID,
			name: 'qbit',
			implementation: 'qbittorrent',
			enabled: true,
			host: 'localhost',
			port: 8080,
			useSsl: false
		});
		ImportService.resetInstance();
	});

	afterEach(async () => {
		await rm(downloadPath, { recursive: true, force: true });
	});

	async function makeQueueItem(completedAt: string) {
		const movieId = randomUUID();
		await seedMovie(movieId);
		const id = randomUUID();
		await testDb.db.insert(downloadQueue).values({
			id,
			downloadClientId: DOWNLOAD_CLIENT_ID,
			downloadId: 'dl-1',
			title: 'Grace.Test.2026.1080p.WEB-DL-GROUP',
			protocol: 'torrent',
			status: 'completed',
			outputPath: downloadPath,
			movieId,
			isAutomatic: true,
			importAttempts: 5,
			completedAt
		});
		return id;
	}

	const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

	it('keeps the download retryable while the files have not arrived', async () => {
		// Nothing stored: the schema defaults apply, and the default grace is 60 minutes.
		const id = await makeQueueItem(minutesAgo(1));

		const result = await runImport(id);

		expect(result.success).toBe(false);
		expect(result.error).toContain('Waiting for files');
		expect(markFailed).not.toHaveBeenCalled();
		const row = testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).get();
		expect(row?.importAttempts).toBe(0);
		// markImporting() parked the row at 'importing'; the deferral has to put it
		// back, or nothing offers it to the importer again until a restart.
		expect(row?.status).toBe('completed');
	});

	it('fails once the grace window has passed', async () => {
		const id = await makeQueueItem(minutesAgo(120));

		const result = await runImport(id);

		expect(result.error).toContain('No video files found in download');
		expect(markFailed).toHaveBeenCalledWith(id, 'No video files found in download');
	});

	it('fails on the first attempt when waiting is disabled', async () => {
		const settings = await (
			await import('#lib/server/settings/file-management.js')
		).getFileManagementSettings();
		await setFileManagementSettings({ ...settings, importGraceMinutes: 0 });
		const id = await makeQueueItem(minutesAgo(1));

		const result = await runImport(id);

		expect(result.error).toContain('No video files found in download');
		expect(markFailed).toHaveBeenCalled();
	});
});
