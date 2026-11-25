/**
 * Regression coverage for #680: the library scanner can register the newly
 * transferred movie file while the import is still running. The import used to
 * decide insert-or-update from a snapshot taken *before* the transfer, so it
 * then inserted a second row for the same (movie, relative path), SQLite
 * refused it, and the download was marked failed although the file was already
 * in the library.
 *
 * The race is made deterministic here: the transfer wrapper indexes the
 * destination exactly as the scanner would, after the file exists and before
 * importMovie decides what to write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb, clearTestDb, type TestDatabase } from '../../../../test/db-helper';
import {
	downloadClients,
	downloadQueue,
	movieFiles,
	movies,
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

/** Set by each test: the row the "scanner" writes once the transfer lands. */
let scannerWrite: ((dest: string) => Promise<void>) | null = null;

vi.mock('./FileTransfer', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./FileTransfer')>();
	return {
		...actual,
		transferFileWithMode: async (source: string, dest: string, options: never) => {
			const result = await actual.transferFileWithMode(source, dest, options);
			await scannerWrite?.(dest);
			return result;
		}
	};
});

const { ImportService } = await import('./ImportService');
const { ImportWorker } = await import('#lib/server/workers/ImportWorker.js');

const ROOT_FOLDER_ID = 'rf-race';
const DOWNLOAD_CLIENT_ID = 'dc-race';

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

describe('ImportService scanner race on the destination path (#680)', () => {
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
		rootDir = await mkdtemp(join(tmpdir(), 'cinephage-race-root-'));
		downloadDir = await mkdtemp(join(tmpdir(), 'cinephage-race-dl-'));
		await seedBaseFixtures(rootDir);
		ImportService.resetInstance();
		service = ImportService.getInstance();
		scannerWrite = null;
	});

	afterEach(async () => {
		await rm(rootDir, { recursive: true, force: true });
		await rm(downloadDir, { recursive: true, force: true });
	});

	it('reuses the row the scanner wrote during the transfer instead of failing the import', async () => {
		const movieId = randomUUID();
		await testDb.db.insert(movies).values({
			id: movieId,
			tmdbId: 77,
			title: 'Raced Movie',
			year: 2026,
			path: 'Raced Movie (2026)',
			rootFolderId: ROOT_FOLDER_ID,
			hasFile: false
		});

		const sourcePath = join(downloadDir, 'Raced.Movie.2026.1080p.WEB-DL-GROUP.mkv');
		await writeFile(sourcePath, Buffer.alloc(1, 3));
		await truncate(sourcePath, 60 * 1024 * 1024);

		const scannerId = randomUUID();
		let indexedPath = '';
		scannerWrite = async (dest: string) => {
			indexedPath = basename(dest);
			// What LibraryScanner does when it sees the finished file: register
			// the path under the movie it matched.
			await testDb.db.insert(movieFiles).values({
				id: scannerId,
				movieId,
				relativePath: basename(dest),
				size: 60 * 1024 * 1024,
				dateAdded: new Date().toISOString()
			});
		};

		const queueItem = {
			id: randomUUID(),
			downloadClientId: DOWNLOAD_CLIENT_ID,
			downloadId: 'dl-race',
			title: 'Raced.Movie.2026.1080p.WEB-DL-GROUP',
			protocol: 'torrent',
			status: 'downloading',
			movieId,
			outputPath: downloadDir
		} as typeof downloadQueue.$inferInsert;
		await testDb.db.insert(downloadQueue).values(queueItem);
		const [insertedQueueItem] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, queueItem.id!));

		const worker = new ImportWorker({
			queueItemId: queueItem.id!,
			mediaType: 'movie',
			title: 'Raced Movie'
		});

		const result = await (
			service as unknown as {
				importMovie: (
					queueItem: typeof downloadQueue.$inferSelect,
					worker: InstanceType<typeof ImportWorker>,
					importOptions: Record<string, unknown>,
					canMoveFiles: boolean
				) => Promise<{ success: boolean }>;
			}
		).importMovie(insertedQueueItem, worker, {}, false);

		expect(result.success).toBe(true);
		expect(markImported).toHaveBeenCalledTimes(1);

		const rows = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, movieId));
		expect(rows).toHaveLength(1);
		// The scanner's row is the one that survives: the import updates it
		// rather than inserting a second row or orphaning the file it owns.
		expect(rows[0].id).toBe(scannerId);
		expect(rows[0].relativePath).toBe(indexedPath);
	});
});
