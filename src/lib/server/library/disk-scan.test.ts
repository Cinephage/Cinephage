import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';

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

const { diskScanService, findExternalRenameMatches } = await import('./disk-scan.js');
const { libraryOperationLock } = await import('./library-operation-lock.js');
const {
	movies,
	movieFiles,
	rootFolders,
	series,
	episodes,
	episodeFiles,
	unmatchedFiles,
	renameHistory
} = await import('#lib/server/db/schema.js');

const emptyRoot = await mkdtemp(join(tmpdir(), 'cinephage-empty-root-'));
const missingRoot = join(tmpdir(), 'cinephage-missing-root-does-not-exist');
const healScanRoots: string[] = [];

testDb.db
	.insert(rootFolders)
	.values([
		{
			id: 'root-empty',
			name: 'Empty Root',
			path: emptyRoot,
			mediaType: 'movie',
			blockedVideoExtensions: '[]'
		},
		{
			id: 'root-missing',
			name: 'Missing Root',
			path: missingRoot,
			mediaType: 'movie',
			blockedVideoExtensions: '[]'
		}
	])
	.run();

for (const rootId of ['root-empty', 'root-missing']) {
	testDb.db
		.insert(movies)
		.values({
			id: `movie-${rootId}`,
			tmdbId: 900000 + (rootId === 'root-empty' ? 1 : 2),
			title: 'Tracked Movie',
			path: 'Movies/Tracked Movie (2020)',
			rootFolderId: rootId
		})
		.run();
	testDb.db
		.insert(movieFiles)
		.values({
			movieId: `movie-${rootId}`,
			relativePath: 'Tracked.Movie.2020.mkv',
			size: 1024 * 1024 * 1024
		})
		.run();
}

afterAll(() => {
	void rm(emptyRoot, { recursive: true, force: true });
	for (const root of healScanRoots) {
		void rm(root, { recursive: true, force: true });
	}
	destroyTestDb(testDb);
});

async function trackedFileCount(rootId: string): Promise<number> {
	const rows = await testDb.db
		.select({ id: movieFiles.id })
		.from(movieFiles)
		.where(eq(movieFiles.movieId, `movie-${rootId}`));
	return rows.length;
}

describe('DiskScanService.scanRootFolder data-safety', () => {
	it('keeps the tracked ...And Justice for All movie inside its dot-prefixed folder', async () => {
		const scanRoot = await mkdtemp(join(tmpdir(), 'cinephage-dot-title-scan-'));
		healScanRoots.push(scanRoot);
		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		const fileId = randomUUID();
		const folderName = '...And Justice for All (1979)';
		const fileName = '...And Justice for All (1979).mkv';
		const movieDir = join(scanRoot, folderName);
		await mkdir(movieDir, { recursive: true });
		await writeFile(join(movieDir, fileName), Buffer.alloc(11 * 1024 * 1024, 1));

		await testDb.db.insert(rootFolders).values({
			id: rootFolderId,
			name: 'Dot-prefixed movie root',
			path: scanRoot,
			mediaType: 'movie',
			blockedVideoExtensions: '[]'
		});
		await testDb.db.insert(movies).values({
			id: movieId,
			tmdbId: 17443,
			title: '...And Justice for All',
			path: folderName,
			rootFolderId
		});
		await testDb.db.insert(movieFiles).values({
			id: fileId,
			movieId,
			relativePath: fileName,
			size: 11 * 1024 * 1024
		});

		const result = await diskScanService.scanRootFolder(rootFolderId);

		expect(result.success).toBe(true);
		expect(result.filesRemoved).toBe(0);
		const [trackedFile] = await testDb.db
			.select({ id: movieFiles.id })
			.from(movieFiles)
			.where(eq(movieFiles.id, fileId));
		expect(trackedFile?.id).toBe(fileId);

		await testDb.db.delete(movieFiles).where(eq(movieFiles.id, fileId));
		await testDb.db.delete(movies).where(eq(movies.id, movieId));
		await testDb.db.delete(rootFolders).where(eq(rootFolders.id, rootFolderId));
	});

	it('refuses to remove tracked records when an accessible folder scans as empty', async () => {
		const result = await diskScanService.scanRootFolder('root-empty');

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/scanned as empty/i);
		expect(await trackedFileCount('root-empty')).toBe(1);
	});

	it('fails the scan when the root path is missing instead of treating it as empty', async () => {
		const result = await diskScanService.scanRootFolder('root-missing');

		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
		expect(result.error).not.toMatch(/no files/i);
		expect(await trackedFileCount('root-missing')).toBe(1);
	});
});

describe('DiskScanService lock integration', () => {
	it('refuses to scan while a rename operation holds the lock', async () => {
		await libraryOperationLock.withLock('rename', async () => {
			await expect(diskScanService.scanRootFolder('root-empty')).rejects.toThrow(
				/rename|reorganiz/i
			);
			expect(diskScanService.scanning).toBe(false);
		});
		expect(libraryOperationLock.isLocked).toBe(false);
	});
});

describe('external rename correlation (findExternalRenameMatches)', () => {
	function missing(
		path: string,
		size: number | null
	): {
		id: string;
		path: string;
		size: number | null;
		allowStrmProbe: boolean;
		source: 'tracked' | 'unmatched';
	} {
		return { id: randomUUID(), path, size, allowStrmProbe: true, source: 'tracked' };
	}

	it('matches a missing file to the unique new disk file with the same basename and size', () => {
		const matches = findExternalRenameMatches(
			[missing('/root/Old Show (2020)/Season 01/e.mkv', 11 * 1024 * 1024)],
			[
				{ path: '/root/Unrelated (2019)/movie.mkv', size: 11 * 1024 * 1024 },
				{ path: '/root/New Show (2020)/Season 01/e.mkv', size: 11 * 1024 * 1024 }
			]
		);

		expect(matches.size).toBe(1);
		expect(matches.get('/root/Old Show (2020)/Season 01/e.mkv')).toBe(
			'/root/New Show (2020)/Season 01/e.mkv'
		);
	});

	it('returns no match when two same-basename same-size candidates exist', () => {
		const matches = findExternalRenameMatches(
			[missing('/root/Old Show (2020)/Season 01/e.mkv', 100)],
			[
				{ path: '/root/A (2020)/Season 01/e.mkv', size: 100 },
				{ path: '/root/B (2020)/Season 01/e.mkv', size: 100 }
			]
		);

		expect(matches.size).toBe(0);
	});

	it('claims each new path at most once (one-to-one)', () => {
		const matches = findExternalRenameMatches(
			[
				missing('/root/A (2020)/Season 01/e.mkv', null),
				missing('/root/B (2020)/Season 01/e.mkv', null)
			],
			[{ path: '/root/C (2020)/Season 01/e.mkv', size: 50 }]
		);

		expect(matches.size).toBe(1);
		expect(matches.get('/root/A (2020)/Season 01/e.mkv')).toBe('/root/C (2020)/Season 01/e.mkv');
		expect(matches.has('/root/B (2020)/Season 01/e.mkv')).toBe(false);
	});

	it('returns no match when sizes differ', () => {
		const matches = findExternalRenameMatches(
			[missing('/root/Old Show (2020)/Season 01/e.mkv', 100)],
			[{ path: '/root/New Show (2020)/Season 01/e.mkv', size: 200 }]
		);

		expect(matches.size).toBe(0);
	});

	it('matches on basename uniqueness alone when the missing row has no size', () => {
		const matches = findExternalRenameMatches(
			[missing('/root/Old Show (2020)/Season 01/e.mkv', null)],
			[{ path: '/root/New Show (2020)/Season 01/e.mkv', size: 12345 }]
		);

		expect(matches.size).toBe(1);
		expect(matches.get('/root/Old Show (2020)/Season 01/e.mkv')).toBe(
			'/root/New Show (2020)/Season 01/e.mkv'
		);
	});
});

describe('external rename healing (no rename_history)', () => {
	const FILE_SIZE = 11 * 1024 * 1024;

	async function writeEpisodeFile(
		scanRoot: string,
		seriesDir: string,
		fileName: string
	): Promise<string> {
		const dir = join(scanRoot, seriesDir, 'Season 01');
		await mkdir(dir, { recursive: true });
		const filePath = join(dir, fileName);
		await writeFile(filePath, Buffer.alloc(FILE_SIZE, 1));
		return filePath;
	}

	it('scanRootFolder heals a series folder renamed outside Cinephage', async () => {
		const db = testDb.db;
		const scanRoot = await mkdtemp(join(tmpdir(), 'cinephage-ext-heal-scan-'));
		healScanRoots.push(scanRoot);

		await writeEpisodeFile(scanRoot, 'New (2020)', 'e.mkv');

		const rootFolderId = randomUUID();
		const seriesId = randomUUID();
		const fileId = randomUUID();

		await db.insert(rootFolders).values({
			id: rootFolderId,
			path: scanRoot,
			mediaType: 'tv',
			name: 'ext-heal-scan-root',
			blockedVideoExtensions: '[]'
		});
		await db.insert(series).values({
			id: seriesId,
			rootFolderId,
			path: 'Old (2020)',
			title: 'Old',
			tmdbId: 34560
		});
		await db.insert(episodeFiles).values({
			id: fileId,
			seriesId,
			seasonNumber: 1,
			relativePath: 'Season 01/e.mkv',
			size: FILE_SIZE
		});

		const result = await diskScanService.scanRootFolder(rootFolderId);

		expect(result.success).toBe(true);
		expect(result.filesRemoved).toBe(0);
		expect(result.filesUpdated).toBe(1);
		expect(result.unmatchedFiles).toBe(0);

		const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
		expect(seriesRow.path).toBe('New (2020)');
		const [fileRow] = await db.select().from(episodeFiles).where(eq(episodeFiles.id, fileId));
		expect(fileRow).toBeDefined();
		expect(fileRow.relativePath).toBe('Season 01/e.mkv');

		const unmatchedRows = await db
			.select()
			.from(unmatchedFiles)
			.where(eq(unmatchedFiles.rootFolderId, rootFolderId));
		expect(unmatchedRows).toHaveLength(0);

		await db.delete(episodeFiles).where(eq(episodeFiles.id, fileId));
		await db.delete(series).where(eq(series.id, seriesId));
		await db.delete(rootFolders).where(eq(rootFolders.id, rootFolderId));
	});

	it('scanRootFolder heals every episode of an externally-renamed series folder', async () => {
		const db = testDb.db;
		const scanRoot = await mkdtemp(join(tmpdir(), 'cinephage-ext-heal-multi-'));
		healScanRoots.push(scanRoot);

		await writeEpisodeFile(scanRoot, 'Renamed (2020)', 'e1.mkv');
		await writeEpisodeFile(scanRoot, 'Renamed (2020)', 'e2.mkv');

		const rootFolderId = randomUUID();
		const seriesId = randomUUID();
		const file1Id = randomUUID();
		const file2Id = randomUUID();

		await db.insert(rootFolders).values({
			id: rootFolderId,
			path: scanRoot,
			mediaType: 'tv',
			name: 'ext-heal-multi-root',
			blockedVideoExtensions: '[]'
		});
		await db.insert(series).values({
			id: seriesId,
			rootFolderId,
			path: 'Original (2020)',
			title: 'Original',
			tmdbId: 34561
		});
		await db.insert(episodeFiles).values([
			{
				id: file1Id,
				seriesId,
				seasonNumber: 1,
				relativePath: 'Season 01/e1.mkv',
				size: FILE_SIZE
			},
			{
				id: file2Id,
				seriesId,
				seasonNumber: 1,
				relativePath: 'Season 01/e2.mkv',
				size: FILE_SIZE
			}
		]);

		const result = await diskScanService.scanRootFolder(rootFolderId);

		expect(result.success).toBe(true);
		expect(result.filesRemoved).toBe(0);
		expect(result.filesUpdated).toBe(2);
		expect(result.unmatchedFiles).toBe(0);

		const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
		expect(seriesRow.path).toBe('Renamed (2020)');
		const fileRows = await db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, seriesId));
		expect(fileRows).toHaveLength(2);
		expect(new Set(fileRows.map((row) => row.relativePath))).toEqual(
			new Set(['Season 01/e1.mkv', 'Season 01/e2.mkv'])
		);

		const unmatchedRows = await db
			.select()
			.from(unmatchedFiles)
			.where(eq(unmatchedFiles.rootFolderId, rootFolderId));
		expect(unmatchedRows).toHaveLength(0);

		await db.delete(episodeFiles).where(eq(episodeFiles.seriesId, seriesId));
		await db.delete(series).where(eq(series.id, seriesId));
		await db.delete(rootFolders).where(eq(rootFolders.id, rootFolderId));
	});

	it('scanRootFolder removes rows when correlation is ambiguous (old safe behavior)', async () => {
		const db = testDb.db;
		const scanRoot = await mkdtemp(join(tmpdir(), 'cinephage-ext-heal-ambig-'));
		healScanRoots.push(scanRoot);

		await writeEpisodeFile(scanRoot, 'New A (2020)', 'ep.mkv');
		await writeEpisodeFile(scanRoot, 'New B (2020)', 'ep.mkv');

		const rootFolderId = randomUUID();
		const seriesAId = randomUUID();
		const seriesBId = randomUUID();
		const fileAId = randomUUID();
		const fileBId = randomUUID();

		await db.insert(rootFolders).values({
			id: rootFolderId,
			path: scanRoot,
			mediaType: 'tv',
			name: 'ext-heal-ambig-root',
			blockedVideoExtensions: '[]'
		});
		await db.insert(series).values([
			{
				id: seriesAId,
				rootFolderId,
				path: 'Old A (2020)',
				title: 'Old A',
				tmdbId: 34562
			},
			{
				id: seriesBId,
				rootFolderId,
				path: 'Old B (2020)',
				title: 'Old B',
				tmdbId: 34563
			}
		]);
		await db.insert(episodeFiles).values([
			{
				id: fileAId,
				seriesId: seriesAId,
				seasonNumber: 1,
				relativePath: 'Season 01/ep.mkv',
				size: FILE_SIZE
			},
			{
				id: fileBId,
				seriesId: seriesBId,
				seasonNumber: 1,
				relativePath: 'Season 01/ep.mkv',
				size: FILE_SIZE
			}
		]);

		const result = await diskScanService.scanRootFolder(rootFolderId);

		expect(result.success).toBe(true);
		expect(result.filesRemoved).toBe(2);

		const [fileARow] = await db.select().from(episodeFiles).where(eq(episodeFiles.id, fileAId));
		const [fileBRow] = await db.select().from(episodeFiles).where(eq(episodeFiles.id, fileBId));
		expect(fileARow).toBeUndefined();
		expect(fileBRow).toBeUndefined();

		const [seriesARow] = await db.select().from(series).where(eq(series.id, seriesAId));
		const [seriesBRow] = await db.select().from(series).where(eq(series.id, seriesBId));
		expect(seriesARow.path).toBe('Old A (2020)');
		expect(seriesBRow.path).toBe('Old B (2020)');

		const unmatchedRows = await db
			.select({ path: unmatchedFiles.path })
			.from(unmatchedFiles)
			.where(eq(unmatchedFiles.rootFolderId, rootFolderId));
		expect(unmatchedRows).toHaveLength(2);

		await db.delete(unmatchedFiles).where(eq(unmatchedFiles.rootFolderId, rootFolderId));
		await db.delete(series).where(eq(series.rootFolderId, rootFolderId));
		await db.delete(rootFolders).where(eq(rootFolders.id, rootFolderId));
	});
});

describe('rename transition healing', () => {
	it('findRenameHealTarget returns the new path only when it exists on disk', async () => {
		const { findRenameHealTarget } = await import('./disk-scan.js');

		const transitions = new Map([
			['/media/old/Movie.mkv', '/media/new/Movie.mkv'],
			['/media/gone/Movie.mkv', '/media/never-materialized/Movie.mkv']
		]);
		const seenPaths = new Set(['/media/new/Movie.mkv']);

		expect(findRenameHealTarget('/media/old/Movie.mkv', transitions, seenPaths)).toBe(
			'/media/new/Movie.mkv'
		);
		expect(findRenameHealTarget('/media/gone/Movie.mkv', transitions, seenPaths)).toBeNull();
		expect(findRenameHealTarget('/media/other/Movie.mkv', transitions, seenPaths)).toBeNull();
	});

	it('healRenamedFile updates series path and episodeFiles.relativePath instead of deleting', async () => {
		const db = testDb.db;

		const rootFolderId = randomUUID();
		const seriesId = randomUUID();
		const fileId = randomUUID();

		await db.insert(rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/heal-root',
			mediaType: 'tv',
			name: 'heal-root'
		});
		await db.insert(series).values({
			id: seriesId,
			rootFolderId,
			path: 'Old Series (2020)',
			title: 'Old Series',
			tmdbId: 12345
		});
		await db.insert(episodeFiles).values({
			id: fileId,
			seriesId,
			seasonNumber: 1,
			relativePath: 'Season 01/old name S01E01.mkv',
			size: 100
		});

		const newPath = '/tmp/opencode/heal-root/New Series (2020)/Season 01/new name S01E01.mkv';
		const healResult = await diskScanService.healRenamedFile(
			{
				id: fileId,
				path: '/tmp/opencode/heal-root/Old Series (2020)/Season 01/old name S01E01.mkv',
				size: 100,
				allowStrmProbe: true,
				source: 'tracked' as const
			},
			newPath,
			'/tmp/opencode/heal-root',
			'tv'
		);
		expect(healResult).toBe('healed');

		const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
		const [fileRow] = await db.select().from(episodeFiles).where(eq(episodeFiles.id, fileId));
		expect(seriesRow.path).toBe('New Series (2020)');
		expect(fileRow.relativePath).toBe('Season 01/new name S01E01.mkv');

		await db.delete(episodeFiles).where(eq(episodeFiles.id, fileId));
		await db.delete(series).where(eq(series.id, seriesId));
		await db.delete(rootFolders).where(eq(rootFolders.id, rootFolderId));
	});

	it('healRenamedFile updates movies.path and movieFiles.relativePath for movie rows', async () => {
		const db = testDb.db;

		const rootFolderId = randomUUID();
		const movieId = randomUUID();
		const fileId = randomUUID();

		await db.insert(rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/heal-movie-root',
			mediaType: 'movie',
			name: 'heal-movie-root'
		});
		await db.insert(movies).values({
			id: movieId,
			rootFolderId,
			path: 'Old Movie (2020)',
			title: 'Old Movie',
			tmdbId: 12346
		});
		await db.insert(movieFiles).values({
			id: fileId,
			movieId,
			relativePath: 'old.movie.2020.mkv',
			size: 100
		});

		const healResult = await diskScanService.healRenamedFile(
			{
				id: fileId,
				path: '/tmp/opencode/heal-movie-root/Old Movie (2020)/old.movie.2020.mkv',
				size: 100,
				allowStrmProbe: true,
				source: 'tracked' as const
			},
			'/tmp/opencode/heal-movie-root/New Movie (2020)/new.movie.2020.mkv',
			'/tmp/opencode/heal-movie-root',
			'movie'
		);

		expect(healResult).toBe('healed');

		const [movieRow] = await db.select().from(movies).where(eq(movies.id, movieId));
		const [fileRow] = await db.select().from(movieFiles).where(eq(movieFiles.id, fileId));
		expect(movieRow.path).toBe('New Movie (2020)');
		expect(fileRow.relativePath).toBe('new.movie.2020.mkv');

		await db.delete(movieFiles).where(eq(movieFiles.id, fileId));
		await db.delete(movies).where(eq(movies.id, movieId));
		await db.delete(rootFolders).where(eq(rootFolders.id, rootFolderId));
	});

	it('healRenamedFile updates unmatchedFiles.path for unmatched rows', async () => {
		const db = testDb.db;

		const rootFolderId = randomUUID();
		const fileId = randomUUID();

		await db.insert(rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/heal-unmatched-root',
			mediaType: 'movie',
			name: 'heal-unmatched-root'
		});
		await db.insert(unmatchedFiles).values({
			id: fileId,
			rootFolderId,
			path: '/tmp/opencode/heal-unmatched-root/Old/name.mkv',
			mediaType: 'movie',
			size: 100
		});

		const healResult = await diskScanService.healRenamedFile(
			{
				id: fileId,
				path: '/tmp/opencode/heal-unmatched-root/Old/name.mkv',
				size: 100,
				allowStrmProbe: true,
				source: 'unmatched' as const
			},
			'/tmp/opencode/heal-unmatched-root/New/name.mkv',
			'/tmp/opencode/heal-unmatched-root',
			'movie'
		);

		expect(healResult).toBe('healed');

		const [row] = await db.select().from(unmatchedFiles).where(eq(unmatchedFiles.id, fileId));
		expect(row.path).toBe('/tmp/opencode/heal-unmatched-root/New/name.mkv');

		await db.delete(unmatchedFiles).where(eq(unmatchedFiles.id, fileId));
		await db.delete(rootFolders).where(eq(rootFolders.id, rootFolderId));
	});

	it('healRenamedFile returns skipped-stale without updating when the DB row is not stale', async () => {
		const db = testDb.db;

		const rootFolderId = randomUUID();
		const seriesId = randomUUID();
		const fileId = randomUUID();

		await db.insert(rootFolders).values({
			id: rootFolderId,
			path: '/tmp/opencode/heal-stale-root',
			mediaType: 'tv',
			name: 'heal-stale-root'
		});
		await db.insert(series).values({
			id: seriesId,
			rootFolderId,
			path: 'Stale Series (2020)',
			title: 'Stale Series',
			tmdbId: 12347
		});
		await db.insert(episodeFiles).values({
			id: fileId,
			seriesId,
			seasonNumber: 1,
			relativePath: 'Season 01/actual name S01E01.mkv',
			size: 100
		});

		const healResult = await diskScanService.healRenamedFile(
			{
				id: fileId,
				path: '/tmp/opencode/heal-stale-root/Stale Series (2020)/Season 01/other name S01E01.mkv',
				size: 100,
				allowStrmProbe: true,
				source: 'tracked' as const
			},
			'/tmp/opencode/heal-stale-root/Stale Series (2020)/Season 01/renamed S01E01.mkv',
			'/tmp/opencode/heal-stale-root',
			'tv'
		);

		expect(healResult).toBe('skipped-stale');

		const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
		const [fileRow] = await db.select().from(episodeFiles).where(eq(episodeFiles.id, fileId));
		expect(seriesRow.path).toBe('Stale Series (2020)');
		expect(fileRow.relativePath).toBe('Season 01/actual name S01E01.mkv');

		await db.delete(episodeFiles).where(eq(episodeFiles.id, fileId));
		await db.delete(series).where(eq(series.id, seriesId));
		await db.delete(rootFolders).where(eq(rootFolders.id, rootFolderId));
	});

	it('scanRootFolder heals renamed rows through rename_history instead of removing them', async () => {
		const db = testDb.db;
		const scanRoot = await mkdtemp(join(tmpdir(), 'cinephage-heal-scan-'));
		healScanRoots.push(scanRoot);

		const newDir = join(scanRoot, 'New Series (2020)', 'Season 01');
		await mkdir(newDir, { recursive: true });
		const newFilePath = join(newDir, 'new name S01E01.mkv');
		await writeFile(newFilePath, Buffer.alloc(11 * 1024 * 1024, 1));

		const rootFolderId = randomUUID();
		const seriesId = randomUUID();
		const fileId = randomUUID();

		await db.insert(rootFolders).values({
			id: rootFolderId,
			path: scanRoot,
			mediaType: 'tv',
			name: 'heal-scan-root',
			blockedVideoExtensions: '[]'
		});
		await db.insert(series).values({
			id: seriesId,
			rootFolderId,
			path: 'Old Series (2020)',
			title: 'Old Series',
			tmdbId: 23456
		});
		await db.insert(episodeFiles).values({
			id: fileId,
			seriesId,
			seasonNumber: 1,
			relativePath: 'Season 01/old name S01E01.mkv',
			size: 1
		});
		await db.insert(renameHistory).values({
			id: randomUUID(),
			fileId,
			mediaType: 'tv',
			oldPath: join(scanRoot, 'Old Series (2020)', 'Season 01', 'old name S01E01.mkv'),
			newPath: newFilePath,
			success: 1,
			operation: 'rename',
			createdAt: new Date().toISOString()
		});

		const result = await diskScanService.scanRootFolder(rootFolderId);

		expect(result.success).toBe(true);
		expect(result.filesRemoved).toBe(0);

		const [fileRow] = await db.select().from(episodeFiles).where(eq(episodeFiles.id, fileId));
		expect(fileRow).toBeDefined();
		expect(fileRow.relativePath).toBe('Season 01/new name S01E01.mkv');
		const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
		expect(seriesRow.path).toBe('New Series (2020)');

		await db.delete(renameHistory).where(eq(renameHistory.fileId, fileId));
		await db.delete(rootFolders).where(eq(rootFolders.id, rootFolderId));
		await db.delete(series).where(eq(series.id, seriesId));
	});

	it('scanRootFolder heals a reorganize crash-window: folder moved, relativePath unchanged', async () => {
		const db = testDb.db;
		const scanRoot = await mkdtemp(join(tmpdir(), 'cinephage-reorg-heal-scan-'));
		healScanRoots.push(scanRoot);

		// Simulate a crash between reorganizeFolderLocked's disk rename and its
		// DB update: the folder (with its files) is at the NEW path on disk,
		// while series.path still points at the OLD folder. The reorganize
		// wrote a rename_history row per file with operation 'reorganize'.
		const newDir = join(scanRoot, 'New Series (2020)', 'Season 01');
		await mkdir(newDir, { recursive: true });
		const newFilePath = join(newDir, 'old name S01E01.mkv');
		await writeFile(newFilePath, Buffer.alloc(11 * 1024 * 1024, 1));

		const rootFolderId = randomUUID();
		const seriesId = randomUUID();
		const fileId = randomUUID();

		await db.insert(rootFolders).values({
			id: rootFolderId,
			path: scanRoot,
			mediaType: 'tv',
			name: 'reorg-heal-scan-root',
			blockedVideoExtensions: '[]'
		});
		await db.insert(series).values({
			id: seriesId,
			rootFolderId,
			path: 'Old Series (2020)',
			title: 'Old Series',
			tmdbId: 23458
		});
		await db.insert(episodeFiles).values({
			id: fileId,
			seriesId,
			seasonNumber: 1,
			relativePath: 'Season 01/old name S01E01.mkv',
			size: 1
		});
		await db.insert(renameHistory).values({
			id: randomUUID(),
			fileId,
			mediaType: 'episode',
			oldPath: join(scanRoot, 'Old Series (2020)', 'Season 01', 'old name S01E01.mkv'),
			newPath: newFilePath,
			success: 1,
			operation: 'reorganize',
			createdAt: new Date().toISOString()
		});

		const result = await diskScanService.scanRootFolder(rootFolderId);

		expect(result.success).toBe(true);
		expect(result.filesRemoved).toBe(0);

		const [fileRow] = await db.select().from(episodeFiles).where(eq(episodeFiles.id, fileId));
		expect(fileRow).toBeDefined();
		expect(fileRow.relativePath).toBe('Season 01/old name S01E01.mkv');
		const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
		expect(seriesRow.path).toBe('New Series (2020)');

		await db.delete(renameHistory).where(eq(renameHistory.fileId, fileId));
		await db.delete(rootFolders).where(eq(rootFolders.id, rootFolderId));
		await db.delete(series).where(eq(series.id, seriesId));
	});

	it('scanRootFolder falls back to removal when healing fails', async () => {
		const db = testDb.db;
		const scanRoot = await mkdtemp(join(tmpdir(), 'cinephage-heal-fail-scan-'));
		healScanRoots.push(scanRoot);

		const newDir = join(scanRoot, 'New Series (2020)', 'Season 01');
		await mkdir(newDir, { recursive: true });
		const newFilePath = join(newDir, 'new name S01E01.mkv');
		await writeFile(newFilePath, Buffer.alloc(11 * 1024 * 1024, 1));

		const rootFolderId = randomUUID();
		const seriesId = randomUUID();
		const fileId = randomUUID();

		await db.insert(rootFolders).values({
			id: rootFolderId,
			path: scanRoot,
			mediaType: 'tv',
			name: 'heal-fail-scan-root',
			blockedVideoExtensions: '[]'
		});
		await db.insert(series).values({
			id: seriesId,
			rootFolderId,
			path: 'Old Series (2020)',
			title: 'Old Series',
			tmdbId: 23457
		});
		await db.insert(episodeFiles).values({
			id: fileId,
			seriesId,
			seasonNumber: 1,
			relativePath: 'Season 01/old name S01E01.mkv',
			size: 1
		});
		await db.insert(renameHistory).values({
			id: randomUUID(),
			fileId,
			mediaType: 'tv',
			oldPath: join(scanRoot, 'Old Series (2020)', 'Season 01', 'old name S01E01.mkv'),
			newPath: newFilePath,
			success: 1,
			operation: 'rename',
			createdAt: new Date().toISOString()
		});

		const healSpy = vi
			.spyOn(diskScanService, 'healRenamedFile')
			.mockRejectedValueOnce(new Error('heal exploded'));

		const result = await diskScanService.scanRootFolder(rootFolderId);
		const healCallCount = healSpy.mock.calls.length;
		healSpy.mockRestore();

		expect(healCallCount).toBe(1);
		expect(result.success).toBe(true);
		expect(result.filesRemoved).toBe(1);

		const [fileRow] = await db.select().from(episodeFiles).where(eq(episodeFiles.id, fileId));
		expect(fileRow).toBeUndefined();

		await db.delete(renameHistory).where(eq(renameHistory.fileId, fileId));
		await db.delete(rootFolders).where(eq(rootFolders.id, rootFolderId));
		await db.delete(series).where(eq(series.id, seriesId));
	});

	it('scanRootFolder heals via rename_history even when external correlation also matches', async () => {
		const db = testDb.db;
		const scanRoot = await mkdtemp(join(tmpdir(), 'cinephage-hist-precedence-'));
		healScanRoots.push(scanRoot);

		// History target: Cinephage renamed both folder and file, recorded in
		// rename_history. Different basename from the missing row.
		const histDir = join(scanRoot, 'Renamed by Cinephage (2020)', 'Season 01');
		await mkdir(histDir, { recursive: true });
		const histPath = join(histDir, 'cinephage name S01E01.mkv');
		await writeFile(histPath, Buffer.alloc(11 * 1024 * 1024, 1));

		// External-correlation candidate: same basename and byte size as the
		// missing tracked file under a different folder, and unique by
		// basename — so the external branch COULD also heal the row, but to a
		// different path. Only rename_history winning keeps the correct target.
		const extDir = join(scanRoot, 'Moved Externally (2020)');
		await mkdir(extDir, { recursive: true });
		const extPath = join(extDir, 'e.mkv');
		await writeFile(extPath, Buffer.alloc(11 * 1024 * 1024, 1));

		const rootFolderId = randomUUID();
		const seriesId = randomUUID();
		const fileId = randomUUID();
		const oldPath = join(scanRoot, 'Old (2020)', 'Season 01', 'e.mkv');

		await db.insert(rootFolders).values({
			id: rootFolderId,
			path: scanRoot,
			mediaType: 'tv',
			name: 'hist-precedence-root',
			blockedVideoExtensions: '[]'
		});
		await db.insert(series).values({
			id: seriesId,
			rootFolderId,
			path: 'Old (2020)',
			title: 'Old',
			tmdbId: 34564
		});
		await db.insert(episodeFiles).values({
			id: fileId,
			seriesId,
			seasonNumber: 1,
			relativePath: 'Season 01/e.mkv',
			size: 11 * 1024 * 1024
		});
		await db.insert(renameHistory).values({
			id: randomUUID(),
			fileId,
			mediaType: 'tv',
			oldPath,
			newPath: histPath,
			success: 1,
			operation: 'rename',
			createdAt: new Date().toISOString()
		});

		const healSpy = vi.spyOn(diskScanService, 'healRenamedFile');

		const result = await diskScanService.scanRootFolder(rootFolderId);
		const healTargets = healSpy.mock.calls.map((call) => call[1]);
		healSpy.mockRestore();

		expect(result.success).toBe(true);
		expect(result.filesRemoved).toBe(0);
		expect(result.filesUpdated).toBe(1);

		// Exactly one heal ran and it used the rename_history target, not the
		// external-correlation candidate.
		expect(healTargets).toHaveLength(1);
		expect(healTargets[0]).toBe(histPath);

		const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
		expect(seriesRow.path).toBe('Renamed by Cinephage (2020)');
		const [fileRow] = await db.select().from(episodeFiles).where(eq(episodeFiles.id, fileId));
		expect(fileRow.relativePath).toBe('Season 01/cinephage name S01E01.mkv');

		// The external candidate is NOT inserted as unmatched this scan: the
		// correlation reserved it as a would-be heal target. It is picked up
		// as a regular unmatched file on the next scan.

		await db.delete(unmatchedFiles).where(eq(unmatchedFiles.rootFolderId, rootFolderId));
		await db.delete(renameHistory).where(eq(renameHistory.fileId, fileId));
		await db.delete(episodeFiles).where(eq(episodeFiles.id, fileId));
		await db.delete(series).where(eq(series.id, seriesId));
		await db.delete(rootFolders).where(eq(rootFolders.id, rootFolderId));
	});
});

describe('title-only special auto-link (season 0, AroTheHawk report)', () => {
	const FILE_SIZE = 11 * 1024 * 1024;

	// Episode titles below are LIVE TMDB season-0 data, verified 2026-09-20
	// (BSG tmdb 1972, Cosmos tmdb 1430). Do not "fix" them to match
	// expectations — change the matcher instead.

	it('links "Razor (2007).mp4" to the matching season 0 special', async () => {
		const db = testDb.db;
		const scanRoot = await mkdtemp(join(tmpdir(), 'cinephage-special-razor-'));
		healScanRoots.push(scanRoot);

		const seriesDir = 'Battlestar Galactica (2003) {tvdb-73545}';
		const fileDir = join(scanRoot, seriesDir, 'Razor (2007)');
		await mkdir(fileDir, { recursive: true });
		await writeFile(join(fileDir, 'Razor (2007).mp4'), Buffer.alloc(FILE_SIZE, 1));

		const rootFolderId = randomUUID();
		const seriesId = randomUUID();
		const ep1Id = randomUUID();
		const ep2Id = randomUUID();

		await db.insert(rootFolders).values({
			id: rootFolderId,
			path: scanRoot,
			mediaType: 'tv',
			name: 'special-razor-root',
			blockedVideoExtensions: '[]'
		});
		await db.insert(series).values({
			id: seriesId,
			rootFolderId,
			path: seriesDir,
			title: 'Battlestar Galactica',
			tmdbId: 1972
		});
		await db.insert(episodes).values([
			{
				id: ep1Id,
				seriesId,
				seasonNumber: 0,
				episodeNumber: 19,
				title: 'Razor (1)',
				airDate: '2007-11-24'
			},
			{
				id: ep2Id,
				seriesId,
				seasonNumber: 0,
				episodeNumber: 20,
				title: 'Razor (2)',
				airDate: '2007-11-24'
			}
		]);

		const result = await diskScanService.scanRootFolder(rootFolderId);

		expect(result.success).toBe(true);

		const linked = await db.select().from(episodeFiles).where(eq(episodeFiles.seriesId, seriesId));
		expect(linked).toHaveLength(1);
		expect(linked[0].seasonNumber).toBe(0);
		// "razor2" is contained in normalized "razor2007"; "razor1" is not.
		expect(linked[0].episodeIds).toEqual([ep2Id]);

		const unmatchedRows = await db
			.select()
			.from(unmatchedFiles)
			.where(eq(unmatchedFiles.rootFolderId, rootFolderId));
		expect(unmatchedRows).toHaveLength(0);
	});

	it('maps "Episode 13 - <title>" onto season 1 for a single-regular-season series (Cosmos)', async () => {
		const db = testDb.db;
		const scanRoot = await mkdtemp(join(tmpdir(), 'cinephage-special-cosmos-'));
		healScanRoots.push(scanRoot);

		const seriesDir = 'Cosmos (1980) {tvdb-74995}';
		await mkdir(join(scanRoot, seriesDir), { recursive: true });
		await writeFile(
			join(scanRoot, seriesDir, 'Episode 13 - Quem Responde Pela Terra (Who Speaks for Earth).mkv'),
			Buffer.alloc(FILE_SIZE, 1)
		);

		const rootFolderId = randomUUID();
		const seriesId = randomUUID();
		const ep13Id = randomUUID();

		await db.insert(rootFolders).values({
			id: rootFolderId,
			path: scanRoot,
			mediaType: 'tv',
			name: 'special-cosmos-root',
			blockedVideoExtensions: '[]'
		});
		await db.insert(series).values({
			id: seriesId,
			rootFolderId,
			path: seriesDir,
			title: 'Cosmos: A Personal Voyage',
			tmdbId: 1430
		});
		await db.insert(episodes).values([
			// Live shape: 14 season 0 specials (incl. E99), 13 season 1 episodes.
			{
				id: randomUUID(),
				seriesId,
				seasonNumber: 0,
				episodeNumber: 1,
				title: 'A Dialogue Between Carl Sagan And Ted Turner',
				airDate: '1989-04-18'
			},
			{
				id: randomUUID(),
				seriesId,
				seasonNumber: 0,
				episodeNumber: 99,
				title: 'Introduction with Ann Druyan',
				airDate: null
			},
			...Array.from({ length: 12 }, (_, i) => ({
				id: randomUUID(),
				seriesId,
				seasonNumber: 1,
				episodeNumber: i + 1,
				title: `Cosmos Episode ${i + 1}`,
				airDate: null
			})),
			{
				id: ep13Id,
				seriesId,
				seasonNumber: 1,
				episodeNumber: 13,
				title: 'Who Speaks for Earth?',
				airDate: '1980-12-21'
			}
		]);

		const result = await diskScanService.scanRootFolder(rootFolderId);

		expect(result.success).toBe(true);

		const linked = await db.select().from(episodeFiles).where(eq(episodeFiles.seriesId, seriesId));
		expect(linked).toHaveLength(1);
		expect(linked[0].seasonNumber).toBe(1);
		expect(linked[0].episodeIds).toEqual([ep13Id]);

		const unmatchedRows = await db
			.select()
			.from(unmatchedFiles)
			.where(eq(unmatchedFiles.rootFolderId, rootFolderId));
		expect(unmatchedRows).toHaveLength(0);
	});

	it('leaves a title-only file unmatched when season 0 has no matching special', async () => {
		const db = testDb.db;
		const scanRoot = await mkdtemp(join(tmpdir(), 'cinephage-special-plan-'));
		healScanRoots.push(scanRoot);

		const seriesDir = 'Battlestar Galactica (2003) {tvdb-73545}';
		const fileDir = join(scanRoot, seriesDir, 'The Plan (2009)');
		await mkdir(fileDir, { recursive: true });
		await writeFile(join(fileDir, 'The Plan (2009).mp4'), Buffer.alloc(FILE_SIZE, 1));

		const rootFolderId = randomUUID();
		const seriesId = randomUUID();

		await db.insert(rootFolders).values({
			id: rootFolderId,
			path: scanRoot,
			mediaType: 'tv',
			name: 'special-plan-root',
			blockedVideoExtensions: '[]'
		});
		await db.insert(series).values({
			id: seriesId,
			rootFolderId,
			path: seriesDir,
			title: 'Battlestar Galactica',
			tmdbId: 197201
		});
		await db.insert(episodes).values({
			id: randomUUID(),
			seriesId,
			seasonNumber: 0,
			episodeNumber: 19,
			title: 'Razor (1)',
			airDate: '2007-11-24'
		});

		const result = await diskScanService.scanRootFolder(rootFolderId);

		expect(result.success).toBe(true);

		const linked = await db.select().from(episodeFiles).where(eq(episodeFiles.seriesId, seriesId));
		expect(linked).toHaveLength(0);

		const unmatchedRows = await db
			.select()
			.from(unmatchedFiles)
			.where(eq(unmatchedFiles.rootFolderId, rootFolderId));
		expect(unmatchedRows).toHaveLength(1);
		expect(unmatchedRows[0].path).toBe(join(fileDir, 'The Plan (2009).mp4'));
	});
});
