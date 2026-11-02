import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import {
	movieFiles,
	movies,
	rootFolders,
	subtitleHistory,
	subtitleProviders,
	subtitles
} from '#lib/server/db/schema.js';
import type { SubtitleSearchResult } from '../types';
import AdmZip from 'adm-zip';

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		writeFile: vi.fn(actual.writeFile),
		rename: vi.fn(actual.rename)
	};
});

const providerDownloadMock = vi.hoisted(() => vi.fn());
const getProviderInstanceMock = vi.hoisted(() => vi.fn());
const acquireRateLimitMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const recordErrorMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const syncSubtitleMock = vi.hoisted(() => vi.fn());
const notifierQueueUpdateMock = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

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

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

vi.mock('#lib/server/notifications/mediabrowser/index.js', () => ({
	getMediaBrowserNotifier: () => ({ queueUpdate: notifierQueueUpdateMock })
}));

vi.mock('./SubtitleProviderManager', () => ({
	getSubtitleProviderManager: () => ({
		getProviderInstance: getProviderInstanceMock,
		acquireRateLimit: acquireRateLimitMock,
		recordError: recordErrorMock
	})
}));

vi.mock('./SubtitleSyncService', () => ({
	getSubtitleSyncService: () => ({
		syncSubtitle: syncSubtitleMock
	})
}));

const { SubtitleDownloadService } = await import('./SubtitleDownloadService');
const mockedWriteFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
const mockedRename = fsPromises.rename as unknown as ReturnType<typeof vi.fn>;

const SRT_CONTENT = '1\n00:00:00,000 --> 00:00:01,000\nHello\n';

function buildZip(entries: Record<string, string>): Buffer {
	const zip = new AdmZip();
	for (const [name, content] of Object.entries(entries)) {
		zip.addFile(name, Buffer.from(content, 'utf-8'));
	}
	return zip.toBuffer();
}

const ROOT_PATH = '/tmp/cinephage-subtitle-download-service';

function buildSearchResult(overrides: Partial<SubtitleSearchResult> = {}): SubtitleSearchResult {
	return {
		providerId: 'provider-1',
		providerName: 'Test Provider',
		providerSubtitleId: 'sub-1',
		language: 'en',
		title: 'Test Subtitle',
		isForced: false,
		isHearingImpaired: false,
		format: 'srt',
		isHashMatch: false,
		matchScore: 87,
		...overrides
	};
}

async function seedMovie(): Promise<string> {
	const rootFolderId = 'root-movie';
	const movieId = 'movie-1';
	const providerId = 'provider-1';

	await testDb.db.insert(subtitleProviders).values({
		id: providerId,
		name: 'Test Provider',
		implementation: 'opensubtitles',
		enabled: true,
		priority: 1,
		requestsPerMinute: 60
	});

	await testDb.db.insert(rootFolders).values({
		id: rootFolderId,
		name: 'Movies',
		path: ROOT_PATH,
		mediaType: 'movie'
	});

	await testDb.db.insert(movies).values({
		id: movieId,
		tmdbId: 101,
		title: 'Test Movie',
		path: 'Test Movie (2024)',
		rootFolderId
	});

	await testDb.db.insert(movieFiles).values({
		id: 'movie-file-1',
		movieId,
		relativePath: 'Test.Movie.2024.mkv'
	});

	return movieId;
}

async function seedMultiFileMovie(): Promise<{
	movieId: string;
	file2160pId: string;
	file1080pId: string;
}> {
	const rootFolderId = 'root-movie';
	const movieId = 'movie-1';
	const providerId = 'provider-1';

	await testDb.db.insert(subtitleProviders).values({
		id: providerId,
		name: 'Test Provider',
		implementation: 'opensubtitles',
		enabled: true,
		priority: 1,
		requestsPerMinute: 60
	});

	await testDb.db.insert(rootFolders).values({
		id: rootFolderId,
		name: 'Movies',
		path: ROOT_PATH,
		mediaType: 'movie'
	});

	await testDb.db.insert(movies).values({
		id: movieId,
		tmdbId: 101,
		title: 'Test Movie',
		path: 'Test Movie (2024)',
		rootFolderId
	});

	await testDb.db.insert(movieFiles).values({
		id: 'movie-file-2160p',
		movieId,
		relativePath: 'Test.Movie.2024.2160p.mkv'
	});

	await testDb.db.insert(movieFiles).values({
		id: 'movie-file-1080p',
		movieId,
		relativePath: 'Test.Movie.2024.1080p.mkv'
	});

	return { movieId, file2160pId: 'movie-file-2160p', file1080pId: 'movie-file-1080p' };
}

describe('SubtitleDownloadService', () => {
	beforeEach(async () => {
		testDb.db.delete(subtitleHistory).run();
		testDb.db.delete(subtitles).run();
		testDb.db.delete(movieFiles).run();
		testDb.db.delete(movies).run();
		testDb.db.delete(rootFolders).run();
		testDb.db.delete(subtitleProviders).run();

		await fsPromises.rm(ROOT_PATH, { recursive: true, force: true });
		providerDownloadMock.mockReset();
		getProviderInstanceMock.mockReset();
		acquireRateLimitMock.mockReset().mockResolvedValue(undefined);
		recordErrorMock.mockReset().mockResolvedValue(undefined);
		syncSubtitleMock.mockReset();
		notifierQueueUpdateMock.mockReset();
		mockedWriteFile.mockClear();
		mockedRename.mockClear();
		mockLogger.info.mockClear();
		mockLogger.error.mockClear();
		mockLogger.warn.mockClear();
		mockLogger.debug.mockClear();

		providerDownloadMock.mockResolvedValue(Buffer.from(SRT_CONTENT, 'utf-8'));
		getProviderInstanceMock.mockResolvedValue({
			download: providerDownloadMock
		});
		syncSubtitleMock.mockResolvedValue({
			success: true,
			offsetMs: 1250
		});
	});

	afterAll(async () => {
		await fsPromises.rm(ROOT_PATH, { recursive: true, force: true });
		destroyTestDb(testDb);
	});

	it('automatically syncs downloaded subtitles', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();

		const result = await service.downloadForMovie(movieId, buildSearchResult());

		expect(syncSubtitleMock).toHaveBeenCalledTimes(1);
		expect(syncSubtitleMock).toHaveBeenCalledWith(result.subtitleId);
		expect(result.wasSynced).toBe(true);
		expect(result.syncOffset).toBe(1250);

		const savedSubtitles = await testDb.db.select().from(subtitles);
		expect(savedSubtitles).toHaveLength(1);
		expect(savedSubtitles[0].id).toBe(result.subtitleId);

		const historyRows = await testDb.db.select().from(subtitleHistory);
		expect(historyRows).toHaveLength(1);
		expect(historyRows[0].action).toBe('downloaded');
	});

	it('skips automatic sync for forced subtitles', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();

		await service.downloadForMovie(movieId, buildSearchResult({ isForced: true }));

		expect(syncSubtitleMock).not.toHaveBeenCalled();
	});

	it('does not fail the download when automatic sync fails', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();
		syncSubtitleMock.mockResolvedValueOnce({
			success: false,
			offsetMs: 0,
			error: 'alass sync failed'
		});

		const result = await service.downloadForMovie(movieId, buildSearchResult());

		expect(result.subtitleId).toBeTruthy();
		expect(result.path).toContain('Test.Movie.2024.en.srt');
		expect(result.wasSynced).toBe(false);
		expect(result.syncOffset).toBeNull();
		expect(syncSubtitleMock).toHaveBeenCalledTimes(1);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			{ subtitleId: result.subtitleId, error: 'alass sync failed' },
			'Automatic subtitle sync failed after download'
		);
	});

	it('links a downloaded subtitle to the specified movie file and names the sidecar after it', async () => {
		const { movieId, file1080pId } = await seedMultiFileMovie();
		const service = SubtitleDownloadService.getInstance();

		const result = await service.downloadForMovie(movieId, buildSearchResult(), {
			movieFileId: file1080pId
		});

		expect(result.path).toContain('Test.Movie.2024.1080p.en.srt');

		const savedSubtitles = await testDb.db.select().from(subtitles);
		expect(savedSubtitles).toHaveLength(1);
		expect(savedSubtitles[0].movieFileId).toBe(file1080pId);
	});

	it('does not clobber an existing subtitle linked to a different movie file', async () => {
		const { movieId, file2160pId, file1080pId } = await seedMultiFileMovie();

		await testDb.db.insert(subtitles).values({
			id: 'existing-2160p-sub',
			movieId,
			movieFileId: file2160pId,
			relativePath: 'Test.Movie.2024.2160p.en.srt',
			language: 'en',
			format: 'srt'
		});

		const service = SubtitleDownloadService.getInstance();
		const result = await service.downloadForMovie(movieId, buildSearchResult(), {
			movieFileId: file1080pId
		});

		expect(result.wasUpgrade).toBe(false);
		expect(result.replacedSubtitleId).toBeUndefined();

		const savedSubtitles = await testDb.db.select().from(subtitles);
		expect(savedSubtitles).toHaveLength(2);
		expect(savedSubtitles.find((s) => s.id === 'existing-2160p-sub')).toBeTruthy();
		expect(savedSubtitles.find((s) => s.movieFileId === file1080pId)).toBeTruthy();
	});

	it('uses result.movieFileId when no explicit movieFileId option is provided', async () => {
		const { movieId, file1080pId } = await seedMultiFileMovie();
		const service = SubtitleDownloadService.getInstance();

		const result = await service.downloadForMovie(
			movieId,
			buildSearchResult({ movieFileId: file1080pId })
		);

		expect(result.path).toContain('Test.Movie.2024.1080p.en.srt');

		const savedSubtitles = await testDb.db.select().from(subtitles);
		expect(savedSubtitles).toHaveLength(1);
		expect(savedSubtitles[0].movieFileId).toBe(file1080pId);
	});

	it('gives the explicit movieFileId option precedence over result.movieFileId when both differ', async () => {
		const { movieId, file2160pId, file1080pId } = await seedMultiFileMovie();
		const service = SubtitleDownloadService.getInstance();

		// result.movieFileId points to 2160p, but the explicit option forces 1080p.
		const result = await service.downloadForMovie(
			movieId,
			buildSearchResult({ movieFileId: file2160pId }),
			{ movieFileId: file1080pId }
		);

		// Sidecar and stored movie_file_id follow the winning (explicit) option.
		expect(result.path).toContain('Test.Movie.2024.1080p.en.srt');

		const savedSubtitles = await testDb.db.select().from(subtitles);
		expect(savedSubtitles).toHaveLength(1);
		expect(savedSubtitles[0].movieFileId).toBe(file1080pId);
	});

	it('rejects a movieFileId that does not exist', async () => {
		await seedMultiFileMovie();
		const service = SubtitleDownloadService.getInstance();

		await expect(
			service.downloadForMovie('movie-1', buildSearchResult(), {
				movieFileId: 'nonexistent-file-id'
			})
		).rejects.toThrow('No file found for movie movie-1 with movieFileId nonexistent-file-id');

		expect(providerDownloadMock).not.toHaveBeenCalled();
	});

	it('rejects a movieFileId belonging to a different movie', async () => {
		const { file1080pId } = await seedMultiFileMovie();

		const rootFolderId = 'root-movie-2';
		const movie2Id = 'movie-2';
		await testDb.db.insert(rootFolders).values({
			id: rootFolderId,
			name: 'Movies 2',
			path: `${ROOT_PATH}-2`,
			mediaType: 'movie'
		});
		await testDb.db.insert(movies).values({
			id: movie2Id,
			tmdbId: 102,
			title: 'Other Movie',
			path: 'Other Movie (2024)',
			rootFolderId
		});

		const service = SubtitleDownloadService.getInstance();
		await expect(
			service.downloadForMovie(movie2Id, buildSearchResult(), {
				movieFileId: file1080pId
			})
		).rejects.toThrow(`No file found for movie ${movie2Id} with movieFileId ${file1080pId}`);

		expect(providerDownloadMock).not.toHaveBeenCalled();
	});

	it('detects the real format from content and ignores the provider-claimed format', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();
		providerDownloadMock.mockResolvedValue(
			Buffer.from('[Script Info]\nScriptType: v4.00+\n[Events]\n', 'utf-8')
		);

		const result = await service.downloadForMovie(movieId, buildSearchResult({ format: 'srt' }));

		expect(result.path.endsWith('.ass')).toBe(true);
		expect(result.format).toBe('ass');
		const rows = await testDb.db.select().from(subtitles);
		expect(rows[0].format).toBe('ass');
	});

	it('detects VTT content', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();
		providerDownloadMock.mockResolvedValue(
			Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n', 'utf-8')
		);

		const result = await service.downloadForMovie(movieId, buildSearchResult({ format: 'srt' }));

		expect(result.path.endsWith('.vtt')).toBe(true);
	});

	it('acquires the provider rate limit before downloading', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();

		await service.downloadForMovie(movieId, buildSearchResult());

		expect(acquireRateLimitMock).toHaveBeenCalledWith('provider-1');
	});

	it('rejects content that is not a recognizable subtitle format', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();
		providerDownloadMock.mockResolvedValue(Buffer.from('just some random text', 'utf-8'));

		await expect(service.downloadForMovie(movieId, buildSearchResult())).rejects.toThrow(
			'not a recognized subtitle format'
		);
		expect((await testDb.db.select().from(subtitles)).length).toBe(0);
		expect((await testDb.db.select().from(subtitleHistory)).length).toBe(0);
	});

	it('selects the language-matching entry from a provider zip archive', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();
		providerDownloadMock.mockResolvedValue(
			buildZip({
				'Movie.fr.srt': '1\n00:00:00,000 --> 00:00:01,000\nFRENCH\n',
				'Movie.en.srt': '1\n00:00:00,000 --> 00:00:01,000\nENGLISH\n'
			})
		);

		const result = await service.downloadForMovie(movieId, buildSearchResult({ language: 'en' }));

		const saved = await fsPromises.readFile(result.path, 'utf-8');
		expect(saved).toContain('ENGLISH');
	});

	it('uses the sole entry from a single-entry zip archive', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();
		providerDownloadMock.mockResolvedValue(buildZip({ 'Whatever.en.srt': SRT_CONTENT }));

		const result = await service.downloadForMovie(movieId, buildSearchResult());
		expect(result.path.endsWith('.srt')).toBe(true);
	});

	it('cleans up the temp file and leaves no partial sidecar when the atomic rename fails', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();
		mockedRename.mockRejectedValueOnce(new Error('EXDEV: cross-device link'));

		await expect(service.downloadForMovie(movieId, buildSearchResult())).rejects.toThrow(
			'Failed to write subtitle file'
		);

		const mediaDir = `${ROOT_PATH}/Test Movie (2024)`;
		const entries = await fsPromises.readdir(mediaDir);
		expect(entries.filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
		expect(entries.filter((name) => name.endsWith('.srt'))).toHaveLength(0);
		expect((await testDb.db.select().from(subtitles)).length).toBe(0);
		expect((await testDb.db.select().from(subtitleHistory)).length).toBe(0);
	});

	it('writes exactly one history row for an upgrade and records replacedSubtitleId', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();

		const existingRelativePath = 'Test.Movie.2024.en.srt';
		const mediaDir = `${ROOT_PATH}/Test Movie (2024)`;
		await fsPromises.mkdir(mediaDir, { recursive: true });
		await fsPromises.writeFile(`${mediaDir}/${existingRelativePath}`, 'old content');

		await testDb.db.insert(subtitles).values({
			id: 'old-sub',
			movieId,
			relativePath: existingRelativePath,
			language: 'en',
			format: 'srt',
			matchScore: 40
		});

		const result = await service.downloadForMovie(movieId, buildSearchResult({ matchScore: 90 }));

		expect(result.wasUpgrade).toBe(true);
		expect(result.replacedSubtitleId).toBe('old-sub');

		const rows = await testDb.db.select().from(subtitles);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(result.subtitleId);

		const historyRows = await testDb.db.select().from(subtitleHistory);
		expect(historyRows).toHaveLength(1);
		expect(historyRows[0].action).toBe('upgraded');
		expect(historyRows[0].replacedSubtitleId).toBe('old-sub');

		// Same path overwritten -> only a Modified notify follows the upgrade.
		expect(notifierQueueUpdateMock).toHaveBeenCalledWith(result.path, 'Modified', 'upgrade');
	});

	it('restores the previous file and row when the DB transaction fails', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();

		const existingRelativePath = 'Test.Movie.2024.en.srt';
		const mediaDir = `${ROOT_PATH}/Test Movie (2024)`;
		await fsPromises.mkdir(mediaDir, { recursive: true });
		await fsPromises.writeFile(`${mediaDir}/${existingRelativePath}`, 'old content');

		await testDb.db.insert(subtitles).values({
			id: 'old-sub',
			movieId,
			relativePath: existingRelativePath,
			language: 'en',
			format: 'srt'
		});

		const txSpy = vi.spyOn(testDb.db, 'transaction').mockImplementation(() => {
			throw new Error('transaction failed');
		});
		try {
			await expect(service.downloadForMovie(movieId, buildSearchResult())).rejects.toThrow(
				'transaction failed'
			);
		} finally {
			txSpy.mockRestore();
		}

		expect(await fsPromises.readFile(`${mediaDir}/${existingRelativePath}`, 'utf-8')).toBe(
			'old content'
		);
		const rows = await testDb.db.select().from(subtitles);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe('old-sub');
		expect((await testDb.db.select().from(subtitleHistory)).length).toBe(0);
	});

	it('preserves an untracked sidecar at the deterministic path when the DB transaction fails', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();

		const mediaDir = `${ROOT_PATH}/Test Movie (2024)`;
		const finalName = 'Test.Movie.2024.en.srt';
		await fsPromises.mkdir(mediaDir, { recursive: true });
		await fsPromises.writeFile(`${mediaDir}/${finalName}`, 'untracked original');

		const txSpy = vi.spyOn(testDb.db, 'transaction').mockImplementation(() => {
			throw new Error('transaction failed');
		});
		try {
			await expect(service.downloadForMovie(movieId, buildSearchResult())).rejects.toThrow(
				'transaction failed'
			);
		} finally {
			txSpy.mockRestore();
		}

		// The untracked file is the only copy we know of: never destroy it.
		expect(await fsPromises.readFile(`${mediaDir}/${finalName}`, 'utf-8')).toBe(
			'untracked original'
		);
	});

	it('notifies media servers when a subtitle is created', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();

		const result = await service.downloadForMovie(movieId, buildSearchResult());

		expect(notifierQueueUpdateMock).toHaveBeenCalledWith(result.path, 'Created', 'import');
	});

	it('notifies media servers when a subtitle is deleted', async () => {
		const movieId = await seedMovie();
		const service = SubtitleDownloadService.getInstance();

		const mediaDir = `${ROOT_PATH}/Test Movie (2024)`;
		await fsPromises.mkdir(mediaDir, { recursive: true });
		await fsPromises.writeFile(`${mediaDir}/gone.en.srt`, SRT_CONTENT);
		await testDb.db.insert(subtitles).values({
			id: 'sub-to-delete',
			movieId,
			relativePath: 'gone.en.srt',
			language: 'en',
			format: 'srt'
		});

		await service.delete('sub-to-delete');

		expect(notifierQueueUpdateMock).toHaveBeenCalledWith(
			`${mediaDir}/gone.en.srt`,
			'Deleted',
			'delete'
		);
		expect((await testDb.db.select().from(subtitles)).length).toBe(0);
		const historyRows = await testDb.db.select().from(subtitleHistory);
		expect(historyRows).toHaveLength(1);
		expect(historyRows[0].action).toBe('deleted');
	});

	it('rejects download replacement when the destination is a symlink', async () => {
		const movieId = await seedMovie();
		const mediaDir = `${ROOT_PATH}/Test Movie (2024)`;
		const outsideDir = `${ROOT_PATH}-outside`;
		const outsidePath = `${outsideDir}/existing.srt`;
		const destination = `${mediaDir}/Test.Movie.2024.en.srt`;
		await fsPromises.mkdir(mediaDir, { recursive: true });
		await fsPromises.mkdir(outsideDir, { recursive: true });
		await fsPromises.writeFile(outsidePath, 'outside');
		await fsPromises.symlink(outsidePath, destination);

		await expect(
			SubtitleDownloadService.getInstance().downloadForMovie(movieId, buildSearchResult())
		).rejects.toThrow('symlink');
		expect(await fsPromises.readFile(outsidePath, 'utf8')).toBe('outside');
		expect((await fsPromises.lstat(destination)).isSymbolicLink()).toBe(true);
	});

	it('does not unlink a symlinked subtitle during delete', async () => {
		const movieId = await seedMovie();
		const mediaDir = `${ROOT_PATH}/Test Movie (2024)`;
		const target = `${mediaDir}/safe-target.srt`;
		const link = `${mediaDir}/gone.en.srt`;
		await fsPromises.mkdir(mediaDir, { recursive: true });
		await fsPromises.writeFile(target, SRT_CONTENT);
		await fsPromises.symlink(target, link);
		await testDb.db.insert(subtitles).values({
			id: 'symlink-delete',
			movieId,
			relativePath: 'gone.en.srt',
			language: 'en',
			format: 'srt'
		});

		await SubtitleDownloadService.getInstance().delete('symlink-delete');

		expect(await fsPromises.readFile(target, 'utf8')).toBe(SRT_CONTENT);
		expect((await fsPromises.lstat(link)).isSymbolicLink()).toBe(true);
	});

	it('does not clobber a row for another file when a multi-file movie has no movieFileId', async () => {
		const { movieId } = await seedMultiFileMovie();

		await testDb.db.insert(subtitles).values({
			id: 'legacy-sub',
			movieId,
			movieFileId: null,
			relativePath: 'Legacy.en.srt',
			language: 'en',
			format: 'srt'
		});

		const service = SubtitleDownloadService.getInstance();
		const result = await service.downloadForMovie(movieId, buildSearchResult());

		expect(result.wasUpgrade).toBe(false);
		expect(result.replacedSubtitleId).toBeUndefined();

		const rows = await testDb.db.select().from(subtitles);
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.id === 'legacy-sub')).toBeTruthy();
	});
});
