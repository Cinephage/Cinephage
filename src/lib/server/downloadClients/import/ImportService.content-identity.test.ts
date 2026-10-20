/**
 * End-to-end coverage for the content-identity guard (#598) inside
 * ImportService.importMovie: proves the real transfer is actually skipped
 * on disk (not just that the pure decision function returns true), and that
 * a genuinely new file still transfers normally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, access, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb, clearTestDb, type TestDatabase } from '../../../../test/db-helper';
import {
	downloadClients,
	downloadQueue,
	movies,
	movieFiles,
	rootFolders
} from '#lib/server/db/schema.js';

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

const markImported = vi.fn();
const markFailed = vi.fn();
vi.mock('../monitoring/DownloadMonitorService', () => ({
	downloadMonitor: {
		markImported: (...args: unknown[]) => markImported(...args),
		markFailed: (...args: unknown[]) => markFailed(...args)
	}
}));

const extractMediaInfo = vi.fn();
vi.mock('#lib/server/library/media-info.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/library/media-info.js')>();
	return {
		...actual,
		mediaInfoService: { extractMediaInfo: (...args: unknown[]) => extractMediaInfo(...args) }
	};
});

const { ImportService } = await import('./ImportService');
const { ImportWorker } = await import('#lib/server/workers/ImportWorker.js');

const ROOT_FOLDER_ID = 'rf-ci';
const DOWNLOAD_CLIENT_ID = 'dc-ci';

async function seedBaseFixtures(rootPath: string) {
	await testDb.db.insert(rootFolders).values({
		id: ROOT_FOLDER_ID,
		name: 'Movies',
		path: rootPath,
		mediaType: 'movie'
	});
	await testDb.db.insert(downloadClients).values({
		id: DOWNLOAD_CLIENT_ID,
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
		downloadClientId: DOWNLOAD_CLIENT_ID,
		downloadId: 'dl-1',
		title: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
		protocol: 'torrent',
		status: 'downloading',
		...overrides
	} as typeof downloadQueue.$inferInsert;
}

describe('ImportService content-identity guard end-to-end (#598)', () => {
	let rootDir: string;
	let downloadDir: string;
	let service: ReturnType<typeof ImportService.getInstance>;

	beforeEach(async () => {
		clearTestDb(testDb);
		markImported.mockReset();
		markFailed.mockReset();
		extractMediaInfo
			.mockReset()
			.mockResolvedValue({ videoCodec: 'hevc', width: 1920, height: 1080 });
		rootDir = await mkdtemp(join(tmpdir(), 'cinephage-ci-root-'));
		downloadDir = await mkdtemp(join(tmpdir(), 'cinephage-ci-dl-'));
		await seedBaseFixtures(rootDir);
		ImportService.resetInstance();
		service = ImportService.getInstance();
	});

	afterEach(async () => {
		await rm(rootDir, { recursive: true, force: true });
		await rm(downloadDir, { recursive: true, force: true });
	});

	it('skips the real file transfer when an infoHash-identical file already exists', async () => {
		const movieId = randomUUID();
		await testDb.db.insert(movies).values({
			id: movieId,
			tmdbId: 42,
			title: 'Test Movie',
			year: 2026,
			path: 'Test Movie (2026)',
			rootFolderId: ROOT_FOLDER_ID,
			hasFile: true
		});
		const existingRelativePath = 'Test Movie (2026) [Bluray-1080p].mkv';
		await testDb.db.insert(movieFiles).values({
			id: randomUUID(),
			movieId,
			relativePath: existingRelativePath,
			size: 123,
			infoHash: 'shared-hash-abc'
		});

		const sourcePath = join(downloadDir, 'Test.Movie.2026.1080p.WEB-DL-GROUP.mkv');
		await writeFile(sourcePath, Buffer.alloc(1, 1));
		await truncate(sourcePath, 60 * 1024 * 1024);

		const queueItem = makeQueueItem({
			movieId,
			infoHash: 'shared-hash-abc',
			outputPath: downloadDir
		});
		await testDb.db.insert(downloadQueue).values(queueItem);
		const [insertedQueueItem] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, queueItem.id!));

		const worker = new ImportWorker({
			queueItemId: queueItem.id!,
			mediaType: 'movie',
			title: 'Test Movie'
		});

		const result = await (
			service as unknown as {
				importMovie: (
					queueItem: typeof downloadQueue.$inferSelect,
					worker: InstanceType<typeof ImportWorker>,
					importOptions: Record<string, unknown>,
					canMoveFiles: boolean
				) => Promise<{
					success: boolean;
					importedFiles: Array<{ transferMode: string }>;
				}>;
			}
		).importMovie(insertedQueueItem, worker, {}, false);

		expect(result.success).toBe(true);
		expect(result.importedFiles[0]?.transferMode).toBe('skip-duplicate');

		// The real proof: the source file was never touched/moved/deleted,
		// and no duplicate row or file was written.
		await expect(access(sourcePath)).resolves.toBeUndefined();
		const files = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, movieId));
		expect(files).toHaveLength(1);
		expect(files[0].relativePath).toBe(existingRelativePath);
	});

	it('transfers normally when the content is genuinely new (no false positive)', async () => {
		const movieId = randomUUID();
		await testDb.db.insert(movies).values({
			id: movieId,
			tmdbId: 43,
			title: 'Other Movie',
			year: 2025,
			path: 'Other Movie (2025)',
			rootFolderId: ROOT_FOLDER_ID,
			hasFile: false
		});

		const sourcePath = join(downloadDir, 'Other.Movie.2025.1080p.WEB-DL-GROUP.mkv');
		await writeFile(sourcePath, Buffer.alloc(1, 2));
		await truncate(sourcePath, 70 * 1024 * 1024);

		const queueItem = makeQueueItem({
			title: 'Other.Movie.2025.1080p.WEB-DL-GROUP',
			movieId,
			infoHash: 'unique-hash-xyz',
			outputPath: downloadDir
		});
		await testDb.db.insert(downloadQueue).values(queueItem);
		const [insertedQueueItem] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, queueItem.id!));

		const worker = new ImportWorker({
			queueItemId: queueItem.id!,
			mediaType: 'movie',
			title: 'Other Movie'
		});

		const result = await (
			service as unknown as {
				importMovie: (
					queueItem: typeof downloadQueue.$inferSelect,
					worker: InstanceType<typeof ImportWorker>,
					importOptions: Record<string, unknown>,
					canMoveFiles: boolean
				) => Promise<{
					success: boolean;
					importedFiles: Array<{ transferMode: string; destPath: string }>;
				}>;
			}
		).importMovie(insertedQueueItem, worker, {}, false);

		expect(result.success).toBe(true);
		expect(result.importedFiles[0]?.transferMode).not.toBe('skip-duplicate');
		await expect(access(result.importedFiles[0]!.destPath)).resolves.toBeUndefined();
		const files = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, movieId));
		expect(files).toHaveLength(1);
	});
});
