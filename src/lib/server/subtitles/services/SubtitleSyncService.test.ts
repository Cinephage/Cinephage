import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import {
	movieFiles,
	movies,
	rootFolders,
	subtitleProviders,
	subtitles
} from '#lib/server/db/schema.js';

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

vi.mock('../sync/index.js', () => ({
	syncSubtitles: vi.fn()
}));

vi.mock('#lib/server/library/LibraryMediaEvents.js', () => ({
	libraryMediaEvents: {
		emitMovieUpdated: vi.fn(),
		emitSeriesUpdated: vi.fn()
	}
}));

const notifierQueueUpdateMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/notifications/mediabrowser/index.js', () => ({
	getMediaBrowserNotifier: () => ({ queueUpdate: notifierQueueUpdateMock })
}));

const { SubtitleSyncService } = await import('./SubtitleSyncService');
const { syncSubtitles } = await import('../sync/index.js');

const ROOT_PATH = '/tmp/cinephage-subtitle-sync-service';
const FILE_2160P_ID = 'movie-file-2160p';
const FILE_1080P_ID = 'movie-file-1080p';
const MOVIE_ID = 'movie-1';

async function seedMultiFileMovie(): Promise<void> {
	const rootFolderId = 'root-movie';
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
		id: MOVIE_ID,
		tmdbId: 101,
		title: 'Test Movie',
		path: 'Test Movie (2024)',
		rootFolderId
	});

	await testDb.db.insert(movieFiles).values({
		id: FILE_2160P_ID,
		movieId: MOVIE_ID,
		relativePath: 'Test.Movie.2024.2160p.mkv'
	});

	await testDb.db.insert(movieFiles).values({
		id: FILE_1080P_ID,
		movieId: MOVIE_ID,
		relativePath: 'Test.Movie.2024.1080p.mkv'
	});
}

type SyncServiceInstance = ReturnType<typeof SubtitleSyncService.getInstance>;

async function getSubtitle(service: SyncServiceInstance, subtitleId: string) {
	const row = await testDb.db.select().from(subtitles).where(eq(subtitles.id, subtitleId));
	// @ts-expect-error - getSubtitlePaths is private; exercised directly to verify file selection
	return service.getSubtitlePaths(row[0]) as Promise<{
		subtitlePath: string | null;
		videoPath: string | null;
	}>;
}

describe('SubtitleSyncService.getSubtitlePaths', () => {
	beforeAll(async () => {
		await rm(ROOT_PATH, { recursive: true, force: true });
		await seedMultiFileMovie();
	});

	beforeEach(async () => {
		testDb.db.delete(subtitles).run();
	});

	afterAll(async () => {
		await rm(ROOT_PATH, { recursive: true, force: true });
		destroyTestDb(testDb);
	});

	it('selects the video file matching the subtitle movieFileId (multi-quality)', async () => {
		// Target the file that is NOT the default (files[0]) so this genuinely
		// fails before the fix (which always used files[0]) and passes after.
		const files = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, MOVIE_ID));
		const targetFile = files.find((f) => f.id !== files[0].id)!;

		const subtitleId = 'sub-target';
		await testDb.db.insert(subtitles).values({
			id: subtitleId,
			movieId: MOVIE_ID,
			movieFileId: targetFile.id,
			relativePath: 'Test.Movie.2024.target.en.srt',
			language: 'en',
			format: 'srt'
		});

		const service = SubtitleSyncService.getInstance();
		const { videoPath } = await getSubtitle(service, subtitleId);

		expect(videoPath).toBeTruthy();
		expect(videoPath).toContain(targetFile.relativePath);
		expect(videoPath).not.toContain(files[0].relativePath);
	});

	it('falls back to the first movie file when the subtitle has no movieFileId (legacy)', async () => {
		const files = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, MOVIE_ID));

		const subtitleId = 'sub-legacy';
		await testDb.db.insert(subtitles).values({
			id: subtitleId,
			movieId: MOVIE_ID,
			movieFileId: null,
			relativePath: 'Test.Movie.2024.en.srt',
			language: 'en',
			format: 'srt'
		});

		const service = SubtitleSyncService.getInstance();
		const { videoPath } = await getSubtitle(service, subtitleId);

		expect(videoPath).toBeTruthy();
		expect(videoPath).toContain(files[0].relativePath);
	});

	it('notifies media servers after a successful sync', async () => {
		notifierQueueUpdateMock.mockReset();
		vi.mocked(syncSubtitles).mockReset();
		vi.mocked(syncSubtitles).mockImplementation(async (options) => {
			await writeFile(options.outputPath!, 'synced');
			return {
				success: true,
				offsetMs: 500,
				splitCount: 0,
				score: 1,
				alignmentTimeMs: 1
			};
		});

		const files = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, MOVIE_ID));
		const movieFile = files[0];
		const mediaDir = `${ROOT_PATH}/Test Movie (2024)`;
		const subRelativePath = 'Test.Movie.2024.en.srt';
		await mkdir(mediaDir, { recursive: true });
		await writeFile(`${mediaDir}/${movieFile.relativePath}`, 'video');
		await writeFile(`${mediaDir}/${subRelativePath}`, '1\n00:00:00,000 --> 00:00:01,000\nHi\n');

		await testDb.db.insert(subtitles).values({
			id: 'sub-sync-notify',
			movieId: MOVIE_ID,
			movieFileId: movieFile.id,
			relativePath: subRelativePath,
			language: 'en',
			format: 'srt'
		});

		const service = SubtitleSyncService.getInstance();
		const result = await service.syncSubtitle('sub-sync-notify');

		expect(result.success).toBe(true);
		expect(notifierQueueUpdateMock).toHaveBeenCalledWith(
			`${mediaDir}/${subRelativePath}`,
			'Modified',
			'upgrade'
		);
	});

	it('rejects a subtitle symlink replaced with an out-of-root target', async () => {
		vi.mocked(syncSubtitles).mockReset();
		const files = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, MOVIE_ID));
		const movieFile = files[0];
		const mediaDir = `${ROOT_PATH}/Test Movie (2024)`;
		const subtitlePath = `${mediaDir}/Test.Movie.2024.escape.en.srt`;
		const inRootTarget = `${mediaDir}/safe-target.srt`;
		const outsideDir = `${ROOT_PATH}-outside`;
		const outsideTarget = `${outsideDir}/escape.srt`;
		await mkdir(mediaDir, { recursive: true });
		await mkdir(outsideDir, { recursive: true });
		await writeFile(`${mediaDir}/${movieFile.relativePath}`, 'video');
		await writeFile(inRootTarget, 'safe');
		await writeFile(outsideTarget, 'outside');
		await symlink(inRootTarget, subtitlePath);
		await rm(subtitlePath);
		await symlink(outsideTarget, subtitlePath);

		await testDb.db.insert(subtitles).values({
			id: 'sub-sync-escape',
			movieId: MOVIE_ID,
			movieFileId: movieFile.id,
			relativePath: 'Test.Movie.2024.escape.en.srt',
			language: 'en',
			format: 'srt'
		});

		const result = await SubtitleSyncService.getInstance().syncSubtitle('sub-sync-escape');

		expect(result.success).toBe(false);
		expect(result.error).toBe('Subtitle file not found');
		expect(syncSubtitles).not.toHaveBeenCalled();
		expect(
			await import('node:fs/promises').then(({ readFile }) => readFile(outsideTarget, 'utf8'))
		).toBe('outside');
		await rm(outsideDir, { recursive: true, force: true });
	});

	it('rejects an in-root symlink when applying a manual offset', async () => {
		const files = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, MOVIE_ID));
		const movieFile = files[0];
		const mediaDir = `${ROOT_PATH}/Test Movie (2024)`;
		const subtitlePath = `${mediaDir}/Test.Movie.2024.manual-link.en.srt`;
		const targetPath = `${mediaDir}/manual-target.srt`;
		const content = '1\n00:00:00,000 --> 00:00:01,000\nTarget\n';
		await mkdir(mediaDir, { recursive: true });
		await writeFile(`${mediaDir}/${movieFile.relativePath}`, 'video');
		await writeFile(targetPath, content);
		await symlink(targetPath, subtitlePath);

		await testDb.db.insert(subtitles).values({
			id: 'sub-sync-manual-link',
			movieId: MOVIE_ID,
			movieFileId: movieFile.id,
			relativePath: 'Test.Movie.2024.manual-link.en.srt',
			language: 'en',
			format: 'srt'
		});

		const result = await SubtitleSyncService.getInstance().applyManualOffset(
			'sub-sync-manual-link',
			1000
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('symlink');
		expect(await fsPromises.readFile(targetPath, 'utf8')).toBe(content);
	});

	it('rejects an API reference subtitle that traverses outside the media root', async () => {
		vi.mocked(syncSubtitles).mockReset();
		const files = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, MOVIE_ID));
		const movieFile = files[0];
		const mediaDir = `${ROOT_PATH}/Test Movie (2024)`;
		await mkdir(mediaDir, { recursive: true });
		await writeFile(`${mediaDir}/${movieFile.relativePath}`, 'video');
		await writeFile(`${mediaDir}/reference.en.srt`, 'reference');
		await writeFile(`${mediaDir}/target.en.srt`, 'target');

		await testDb.db.insert(subtitles).values({
			id: 'sub-sync-reference-traversal',
			movieId: MOVIE_ID,
			movieFileId: movieFile.id,
			relativePath: 'target.en.srt',
			language: 'en',
			format: 'srt'
		});

		const result = await SubtitleSyncService.getInstance().syncSubtitle(
			'sub-sync-reference-traversal',
			{
				referenceType: 'subtitle',
				referencePath: '../outside.srt'
			}
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('reference');
		expect(syncSubtitles).not.toHaveBeenCalled();
	});

	it('rejects an in-root symlink as the writable sync subtitle', async () => {
		vi.mocked(syncSubtitles).mockReset();
		const files = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, MOVIE_ID));
		const movieFile = files[0];
		const mediaDir = `${ROOT_PATH}/Test Movie (2024)`;
		const subtitlePath = `${mediaDir}/Test.Movie.2024.write-link.en.srt`;
		await mkdir(mediaDir, { recursive: true });
		await writeFile(`${mediaDir}/${movieFile.relativePath}`, 'video');
		await writeFile(`${mediaDir}/write-target.srt`, 'target');
		await symlink(`${mediaDir}/write-target.srt`, subtitlePath);

		await testDb.db.insert(subtitles).values({
			id: 'sub-sync-write-link',
			movieId: MOVIE_ID,
			movieFileId: movieFile.id,
			relativePath: 'Test.Movie.2024.write-link.en.srt',
			language: 'en',
			format: 'srt'
		});

		const result = await SubtitleSyncService.getInstance().syncSubtitle('sub-sync-write-link');

		expect(result.success).toBe(false);
		expect(result.error).toContain('symlink');
		expect(syncSubtitles).not.toHaveBeenCalled();
	});

	it('does not commit sync output after the validated subtitle path is retargeted', async () => {
		const files = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, MOVIE_ID));
		const movieFile = files[0];
		const mediaDir = `${ROOT_PATH}/Test Movie (2024)`;
		const subtitlePath = `${mediaDir}/Test.Movie.2024.commit-race.en.srt`;
		const outsideDir = `${ROOT_PATH}-commit-race-outside`;
		const outsideTarget = `${outsideDir}/target.srt`;
		await mkdir(mediaDir, { recursive: true });
		await mkdir(outsideDir, { recursive: true });
		await writeFile(`${mediaDir}/${movieFile.relativePath}`, 'video');
		await writeFile(subtitlePath, 'safe');
		await writeFile(outsideTarget, 'outside');

		await testDb.db.insert(subtitles).values({
			id: 'sub-sync-commit-race',
			movieId: MOVIE_ID,
			movieFileId: movieFile.id,
			relativePath: 'Test.Movie.2024.commit-race.en.srt',
			language: 'en',
			format: 'srt'
		});

		vi.mocked(syncSubtitles).mockImplementation(async (options) => {
			await rm(options.subtitlePath);
			await symlink(outsideTarget, options.subtitlePath);
			await writeFile(options.outputPath!, 'synced');
			return { success: true, offsetMs: 1, splitCount: 0, score: 1, alignmentTimeMs: 1 };
		});

		const result = await SubtitleSyncService.getInstance().syncSubtitle('sub-sync-commit-race');

		expect(result.success).toBe(false);
		expect(result.error).toContain('retargeted');
		expect(await fsPromises.readFile(outsideTarget, 'utf8')).toBe('outside');
		await rm(outsideDir, { recursive: true, force: true });
	});

	it('does not read or write an outside target when a subtitle link retargets after validation', async () => {
		const files = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, MOVIE_ID));
		const movieFile = files[0];
		const mediaDir = `${ROOT_PATH}/Test Movie (2024)`;
		const subtitlePath = `${mediaDir}/Test.Movie.2024.race.en.srt`;
		const inRootTarget = `${mediaDir}/race-safe.srt`;
		const outsideDir = `${ROOT_PATH}-race-outside`;
		const outsideTarget = `${outsideDir}/race.srt`;
		await mkdir(mediaDir, { recursive: true });
		await mkdir(outsideDir, { recursive: true });
		await writeFile(`${mediaDir}/${movieFile.relativePath}`, 'video');
		await writeFile(inRootTarget, '1\n00:00:00,000 --> 00:00:01,000\nSafe\n');
		await writeFile(outsideTarget, 'outside');
		await symlink(inRootTarget, subtitlePath);

		await testDb.db.insert(subtitles).values({
			id: 'sub-sync-race',
			movieId: MOVIE_ID,
			movieFileId: movieFile.id,
			relativePath: 'Test.Movie.2024.race.en.srt',
			language: 'en',
			format: 'srt'
		});

		const { openPathWithinBase, resolvePathWithinBase } = await import('../subtitle-paths.js');
		const validatedPath = await resolvePathWithinBase(mediaDir, subtitlePath);
		expect(validatedPath).toBe(subtitlePath);
		await rm(subtitlePath);
		await symlink(outsideTarget, subtitlePath);

		await expect(openPathWithinBase(mediaDir, validatedPath!, 'r+')).rejects.toThrow(
			'Path is outside the allowed base'
		);
		expect(await fsPromises.readFile(outsideTarget, 'utf8')).toBe('outside');
		await rm(outsideDir, { recursive: true, force: true });
	});
});
