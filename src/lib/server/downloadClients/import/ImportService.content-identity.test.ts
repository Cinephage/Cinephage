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
	rootFolders,
	series,
	seasons,
	episodes,
	episodeFiles
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
const TV_ROOT_FOLDER_ID = 'rf-ci-tv';
const DOWNLOAD_CLIENT_ID = 'dc-ci';

async function seedBaseFixtures(rootPath: string, tvRootPath?: string) {
	await testDb.db.insert(rootFolders).values({
		id: ROOT_FOLDER_ID,
		name: 'Movies',
		path: rootPath,
		mediaType: 'movie'
	});
	if (tvRootPath) {
		await testDb.db.insert(rootFolders).values({
			id: TV_ROOT_FOLDER_ID,
			name: 'TV',
			path: tvRootPath,
			mediaType: 'tv'
		});
	}
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
	let tvRootDir: string;
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
		tvRootDir = await mkdtemp(join(tmpdir(), 'cinephage-ci-tv-root-'));
		downloadDir = await mkdtemp(join(tmpdir(), 'cinephage-ci-dl-'));
		await seedBaseFixtures(rootDir, tvRootDir);
		ImportService.resetInstance();
		service = ImportService.getInstance();
	});

	afterEach(async () => {
		await rm(rootDir, { recursive: true, force: true });
		await rm(tvRootDir, { recursive: true, force: true });
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

	it('does not clobber another episode in the same batch just because the release infoHash matches (issue #637)', async () => {
		const seriesId = randomUUID();
		await testDb.db.insert(series).values({
			id: seriesId,
			tmdbId: 9001,
			title: 'Solo Leveling',
			year: 2024,
			path: 'Solo Leveling (2024)',
			rootFolderId: TV_ROOT_FOLDER_ID,
			seasonFolder: true
		});
		await testDb.db.insert(seasons).values({ seriesId, seasonNumber: 1 });
		const [ep1] = await testDb.db
			.insert(episodes)
			.values({ seriesId, seasonNumber: 1, episodeNumber: 1, hasFile: false })
			.returning();
		const [ep2] = await testDb.db
			.insert(episodes)
			.values({ seriesId, seasonNumber: 1, episodeNumber: 2, hasFile: false })
			.returning();

		// A season-pack-style grab title with no episode number - every file in
		// the batch shares this queueItem (and therefore the same infoHash).
		const queueItem = makeQueueItem({
			title: 'Solo.Leveling.2024.S01.1080p.WEB-DL-GROUP',
			seriesId,
			seasonNumber: 1,
			infoHash: 'season-pack-hash',
			outputPath: downloadDir
		});
		await testDb.db.insert(downloadQueue).values(queueItem);
		const [insertedQueueItem] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, queueItem.id!));

		const worker = new ImportWorker({
			queueItemId: queueItem.id!,
			mediaType: 'episode',
			title: 'Solo Leveling'
		});

		const serviceWithPrivate = service as unknown as {
			importEpisodeFile: (
				videoFile: { path: string; size: number },
				seriesData: typeof series.$inferSelect,
				rootFolder: typeof rootFolders.$inferSelect,
				queueItem: typeof downloadQueue.$inferSelect,
				canMoveFiles: boolean,
				worker: InstanceType<typeof ImportWorker>,
				importOptions: Record<string, unknown>,
				deferRetirement: boolean
			) => Promise<{ success: boolean; sourcePath: string; error?: string }>;
		};

		const [seriesRow] = await testDb.db.select().from(series).where(eq(series.id, seriesId));
		const [tvRootFolder] = await testDb.db
			.select()
			.from(rootFolders)
			.where(eq(rootFolders.id, TV_ROOT_FOLDER_ID));

		// Each file carries its own correct SxxEyy, exactly like the real
		// per-episode .strm files in a usenet season pack - but they all share
		// one queue item/infoHash since they came from a single grab.
		for (const [name, size] of [
			['Solo.Leveling.S01E01.1080p.WEB-DL-GROUP.mkv', 60],
			['Solo.Leveling.S01E02.1080p.WEB-DL-GROUP.mkv', 70]
		] as const) {
			const path = join(downloadDir, name);
			await writeFile(path, Buffer.alloc(1, 1));
			await truncate(path, size * 1024 * 1024);
			const result = await serviceWithPrivate.importEpisodeFile(
				{ path, size: size * 1024 * 1024 },
				seriesRow,
				tvRootFolder,
				insertedQueueItem,
				false,
				worker,
				{},
				true
			);
			expect(result.success).toBe(true);
		}

		const files = await testDb.db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, seriesId));
		expect(files).toHaveLength(2);

		const byEpisode = (id: string) => files.find((f) => f.episodeIds?.includes(id));
		expect(byEpisode(ep1.id)?.relativePath).not.toBe(byEpisode(ep2.id)?.relativePath);
	});

	it('imports a full 13-episode usenet season pack of uniform tiny .strm placeholders without cross-linking episodes, including on a repeat pass (issue #637)', async () => {
		// Every .strm placeholder is the same tiny size with identical probed
		// mediaInfo (STRM placeholders get synthetic info) - this is the
		// worst case: contentAlreadyPresent's size+mediaInfo fallback branch
		// would ALSO call every pair of files "identical" if not for the
		// episodeIds-overlap guard.
		extractMediaInfo.mockResolvedValue({ format: 'strm' });

		const seriesId = randomUUID();
		await testDb.db.insert(series).values({
			id: seriesId,
			tmdbId: 9002,
			title: 'Solo Leveling',
			year: 2024,
			path: 'Solo Leveling (2024)',
			rootFolderId: TV_ROOT_FOLDER_ID,
			seasonFolder: true
		});
		await testDb.db.insert(seasons).values({ seriesId, seasonNumber: 1 });
		const episodeTitles = [
			"I'm Used to It",
			'If I Had One More Chance',
			"It's Like a Game",
			"I've Gotta Get Stronger",
			'A Pretty Good Deal',
			'The Real Hunt Begins',
			"Let's See How Far I Can Go",
			'How to Get Stronger',
			'This Is Frustrating',
			"You've Been Hiding Your Skills",
			'What Is This, a Picnic?',
			'A Knight Who Defends an Empty Throne',
			'Arise'
		];
		const insertedEpisodes = [];
		for (let i = 0; i < episodeTitles.length; i++) {
			const [ep] = await testDb.db
				.insert(episodes)
				.values({
					seriesId,
					seasonNumber: 1,
					episodeNumber: i + 1,
					title: episodeTitles[i],
					hasFile: false
				})
				.returning();
			insertedEpisodes.push(ep);
		}

		const queueItem = makeQueueItem({
			title: 'Solo.Leveling.2024.S01.1080p.CR.WEB-DL.MULTI.AAC2.0.H.264-OldT',
			seriesId,
			seasonNumber: 1,
			infoHash: 'season-pack-hash-full',
			outputPath: downloadDir
		});
		await testDb.db.insert(downloadQueue).values(queueItem);

		for (let i = 1; i <= episodeTitles.length; i++) {
			const ep = String(i).padStart(2, '0');
			const path = join(
				downloadDir,
				`Solo.Leveling.S01E${ep}.1080p.CR.WEB-DL.MULTI.AAC2.0.H.264-OldT.mkv.strm`
			);
			await writeFile(path, 'https://example.com/stream');
		}

		const serviceWithImportSeries = service as unknown as {
			importSeries: (
				queueItem: typeof downloadQueue.$inferSelect,
				worker: InstanceType<typeof ImportWorker>,
				importOptions: Record<string, unknown>,
				canMoveFiles: boolean
			) => Promise<{ success: boolean; importedFiles: unknown[]; failedFiles: unknown[] }>;
		};

		async function runImportPass() {
			const [insertedQueueItem] = await testDb.db
				.select()
				.from(downloadQueue)
				.where(eq(downloadQueue.id, queueItem.id!));
			const worker = new ImportWorker({
				queueItemId: queueItem.id!,
				mediaType: 'episode',
				title: 'Solo Leveling'
			});
			return serviceWithImportSeries.importSeries(
				insertedQueueItem,
				worker,
				{ allowStrmSmall: true },
				false
			);
		}

		const firstPass = await runImportPass();
		expect(firstPass.failedFiles).toHaveLength(0);

		// A 13-file batch must report the series folder, not an arbitrary one
		// of its files (which read as "imported to episode 1").
		expect(markImported).toHaveBeenCalledWith(
			queueItem.id,
			join(tvRootDir, 'Solo Leveling (2024)'),
			'torrent'
		);

		let files = await testDb.db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, seriesId));
		expect(files).toHaveLength(13);
		for (const ep of insertedEpisodes) {
			const owners = files.filter((f) => f.episodeIds?.includes(ep.id));
			expect(owners).toHaveLength(1);
			expect(owners[0].relativePath).toContain(`S01E${String(ep.episodeNumber).padStart(2, '0')}`);
		}

		// Re-run the exact same pass again (mirrors a repeat monitor cycle
		// reprocessing the same completed download) - nothing should move.
		const secondPass = await runImportPass();
		expect(secondPass.failedFiles).toHaveLength(0);

		files = await testDb.db.select().from(episodeFiles).where(eq(episodeFiles.seriesId, seriesId));
		expect(files).toHaveLength(13);
		for (const ep of insertedEpisodes) {
			const owners = files.filter((f) => f.episodeIds?.includes(ep.id));
			expect(owners).toHaveLength(1);
			expect(owners[0].relativePath).toContain(`S01E${String(ep.episodeNumber).padStart(2, '0')}`);
		}
	});

	it('reports the specific file as the imported path for a single-episode grab', async () => {
		const seriesId = randomUUID();
		await testDb.db.insert(series).values({
			id: seriesId,
			tmdbId: 9003,
			title: 'Solo Leveling',
			year: 2024,
			path: 'Solo Leveling (2024)',
			rootFolderId: TV_ROOT_FOLDER_ID,
			seasonFolder: true
		});
		await testDb.db.insert(seasons).values({ seriesId, seasonNumber: 1 });
		await testDb.db
			.insert(episodes)
			.values({
				seriesId,
				seasonNumber: 1,
				episodeNumber: 1,
				title: "I'm Used to It",
				hasFile: false
			});

		const queueItem = makeQueueItem({
			title: 'Solo.Leveling.S01E01.1080p.CR.WEB-DL.AAC2.0.H.264-OldT',
			seriesId,
			seasonNumber: 1,
			infoHash: 'single-episode-hash',
			outputPath: downloadDir
		});
		await testDb.db.insert(downloadQueue).values(queueItem);
		const [insertedQueueItem] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, queueItem.id!));

		const path = join(
			downloadDir,
			'Solo.Leveling.S01E01.1080p.CR.WEB-DL.AAC2.0.H.264-OldT.mkv.strm'
		);
		await writeFile(path, 'https://example.com/stream');

		const worker = new ImportWorker({
			queueItemId: queueItem.id!,
			mediaType: 'episode',
			title: 'Solo Leveling'
		});

		await (
			service as unknown as {
				importSeries: (
					queueItem: typeof downloadQueue.$inferSelect,
					worker: InstanceType<typeof ImportWorker>,
					importOptions: Record<string, unknown>,
					canMoveFiles: boolean
				) => Promise<{ success: boolean }>;
			}
		).importSeries(insertedQueueItem, worker, { allowStrmSmall: true }, false);

		const call = markImported.mock.calls.find((args) => args[0] === queueItem.id);
		expect(call?.[1]).toContain(join(tvRootDir, 'Solo Leveling (2024)', 'Season 01'));
		expect(call?.[1]).toContain('S01E01');
		expect(call?.[2]).toBe('torrent');
	});

	it('does not skip a re-grab of a .strm episode from a different release, even with identical size/mediaInfo', async () => {
		// Every .strm candidate gets this exact synthetic mediaInfo whenever
		// probing degrades (mount not ready, timeout, etc.) - a genuinely
		// different release must still import, not be mistaken for a dup.
		extractMediaInfo.mockResolvedValue({
			containerFormat: 'strm',
			videoCodec: 'HLS',
			width: 1920,
			height: 1080
		});

		const seriesId = randomUUID();
		await testDb.db.insert(series).values({
			id: seriesId,
			tmdbId: 9004,
			title: 'Solo Leveling',
			year: 2024,
			path: 'Solo Leveling (2024)',
			rootFolderId: TV_ROOT_FOLDER_ID,
			seasonFolder: true
		});
		await testDb.db.insert(seasons).values({ seriesId, seasonNumber: 1 });
		const [ep1] = await testDb.db
			.insert(episodes)
			.values({
				seriesId,
				seasonNumber: 1,
				episodeNumber: 1,
				title: "I'm Used to It",
				hasFile: true
			})
			.returning();

		// Simulate the first import already on disk, from a different
		// release (OldT group), with the uniform synthetic strm mediaInfo.
		await testDb.db.insert(episodeFiles).values({
			id: randomUUID(),
			seriesId,
			seasonNumber: 1,
			episodeIds: [ep1.id],
			relativePath:
				"Season 01/Solo Leveling (2024) - S01E01 - I'm Used to It [WEB-DL-1080p]-OldT.strm",
			size: 170,
			infoHash: 'old-release-hash',
			mediaInfo: { containerFormat: 'strm', videoCodec: 'HLS', width: 1920, height: 1080 }
		});

		// A brand new, different release (ADWeb group, different infoHash).
		const queueItem = makeQueueItem({
			title: 'Solo.Leveling.S01.2024.1080p.AMZN.WEB-DL.H.264.DDP2.0-ADWeb',
			seriesId,
			seasonNumber: 1,
			infoHash: 'new-release-hash-adweb',
			outputPath: downloadDir
		});
		await testDb.db.insert(downloadQueue).values(queueItem);
		const [insertedQueueItem] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, queueItem.id!));

		const path = join(
			downloadDir,
			'Solo.Leveling.S01E01.1080p.AMZN.WEB-DL.H.264.DDP2.0-ADWeb.mkv.strm'
		);
		// Deliberately padded to the exact same size as the existing row
		// (170 bytes) - proves this isn't skipped via the content-identity
		// guard even when size AND mediaInfo coincidentally match too.
		await writeFile(path, 'https://example.com/stream-but-different');
		await truncate(path, 170);

		const worker = new ImportWorker({
			queueItemId: queueItem.id!,
			mediaType: 'episode',
			title: 'Solo Leveling'
		});

		const result = await (
			service as unknown as {
				importSeries: (
					queueItem: typeof downloadQueue.$inferSelect,
					worker: InstanceType<typeof ImportWorker>,
					importOptions: Record<string, unknown>,
					canMoveFiles: boolean
				) => Promise<{
					success: boolean;
					importedFiles: Array<{ transferMode: string }>;
				}>;
			}
		).importSeries(insertedQueueItem, worker, { allowStrmSmall: true }, false);

		expect(result.success).toBe(true);
		expect(result.importedFiles[0]?.transferMode).not.toBe('skip-duplicate');

		const files = await testDb.db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, seriesId));
		expect(files).toHaveLength(1);
		expect(files[0].infoHash).toBe('new-release-hash-adweb');
		expect(files[0].relativePath).toContain('ADWeb');
	});
});
