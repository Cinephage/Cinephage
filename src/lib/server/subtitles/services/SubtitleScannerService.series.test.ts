import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import {
	episodeFiles,
	episodes,
	rootFolders,
	series,
	subtitleHistory,
	subtitles
} from '#lib/server/db/schema.js';
import { join } from 'node:path';

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

const { SubtitleScannerService } = await import('./SubtitleScannerService');
const { resolveStoredSubtitlePath } = await import('../subtitle-paths');
const { SubtitleSyncService } = await import('./SubtitleSyncService');

const ROOT_PATH = '/tmp/cinephage-subtitle-scanner-series';
const ROOT_FOLDER_ID = 'root-tv';
const SERIES_ID = 'series-1';
const SERIES_PATH = join(ROOT_PATH, 'Show');

async function seedRootAndSeries(): Promise<void> {
	await testDb.db.insert(rootFolders).values({
		id: ROOT_FOLDER_ID,
		name: 'TV',
		path: ROOT_PATH,
		mediaType: 'tv',
		mediaSubType: 'standard'
	});
	await testDb.db.insert(series).values({
		id: SERIES_ID,
		tmdbId: 501,
		title: 'Show',
		path: 'Show',
		rootFolderId: ROOT_FOLDER_ID
	});
}

async function seedEpisode(id: string, season: number, episode: number): Promise<void> {
	await testDb.db.insert(episodes).values({
		id,
		seriesId: SERIES_ID,
		seasonNumber: season,
		episodeNumber: episode
	});
}

async function seedEpisodeFile(
	id: string,
	relativePath: string,
	episodeIds: string[]
): Promise<void> {
	await testDb.db.insert(episodeFiles).values({
		id,
		seriesId: SERIES_ID,
		seasonNumber: 1,
		relativePath,
		episodeIds
	});
}

interface SidecarInput {
	relativePath: string;
	videoFileName?: string;
}

function sidecar({ relativePath, videoFileName }: SidecarInput) {
	return {
		path: join(SERIES_PATH, relativePath),
		relativePath,
		size: 50,
		language: 'en' as const,
		isForced: false,
		isHearingImpaired: false,
		format: 'srt' as const,
		videoFileName
	};
}

type Scanner = ReturnType<typeof SubtitleScannerService.getInstance>;

function mockDiscovery(service: Scanner, items: ReturnType<typeof sidecar>[]) {
	vi.spyOn(service, 'discoverSubtitles').mockResolvedValue(items);
}

async function savedSubtitles() {
	return testDb.db.select().from(subtitles);
}

describe('SubtitleScannerService scanSeriesSubtitles association', () => {
	beforeEach(async () => {
		testDb.db.delete(subtitleHistory).run();
		testDb.db.delete(subtitles).run();
		testDb.db.delete(episodeFiles).run();
		testDb.db.delete(episodes).run();
		testDb.db.delete(series).run();
		testDb.db.delete(rootFolders).run();
		mockLogger.info.mockClear();
		mockLogger.error.mockClear();
		mockLogger.warn.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	it('associates by exact video-stem match even when the directory has several episodes', async () => {
		await seedRootAndSeries();
		await seedEpisode('ep-1', 1, 1);
		await seedEpisode('ep-2', 1, 2);
		await seedEpisodeFile('ef-1', 'Season 01/Show S01E01.mkv', ['ep-1']);
		await seedEpisodeFile('ef-2', 'Season 01/Show S01E02.mkv', ['ep-2']);

		const service = SubtitleScannerService.getInstance();
		mockDiscovery(service, [
			sidecar({
				relativePath: 'Season 01/Show S01E01.en.srt',
				videoFileName: 'Show S01E01'
			})
		]);

		const result = await service.scanSeriesSubtitles(SERIES_ID);

		expect(result.added).toBe(1);
		expect(result.skipped).toBe(0);

		const saved = await savedSubtitles();
		expect(saved).toHaveLength(1);
		expect(saved[0].episodeId).toBe('ep-1');
		// Episode-dir-relative (season folder stripped), matching download/delete/sync.
		expect(saved[0].relativePath).toBe('Show S01E01.en.srt');
	});

	it('associates by parsed SxxExx when the stems differ', async () => {
		await seedRootAndSeries();
		await seedEpisode('ep-1', 1, 1);
		await seedEpisode('ep-2', 1, 2);
		await seedEpisodeFile('ef-1', 'Season 01/Show.Alpha.S01E01.mkv', ['ep-1']);
		await seedEpisodeFile('ef-2', 'Season 01/Show.Beta.S01E02.mkv', ['ep-2']);

		const service = SubtitleScannerService.getInstance();
		mockDiscovery(service, [
			sidecar({
				relativePath: 'Season 01/Random.Name.S01E02.en.srt',
				videoFileName: 'Random.Name.S01E02'
			})
		]);

		const result = await service.scanSeriesSubtitles(SERIES_ID);

		expect(result.added).toBe(1);
		const saved = await savedSubtitles();
		expect(saved[0].episodeId).toBe('ep-2');
	});

	it('skips and reports a sidecar in a shared season dir with multiple episodes (headline defect)', async () => {
		await seedRootAndSeries();
		await seedEpisode('ep-1', 1, 1);
		await seedEpisode('ep-2', 1, 2);
		await seedEpisodeFile('ef-1', 'Season 01/Show S01E01.mkv', ['ep-1']);
		await seedEpisodeFile('ef-2', 'Season 01/Show S01E02.mkv', ['ep-2']);

		const service = SubtitleScannerService.getInstance();
		mockDiscovery(service, [
			sidecar({ relativePath: 'Season 01/commentary.en.srt', videoFileName: 'commentary' })
		]);

		const result = await service.scanSeriesSubtitles(SERIES_ID);

		expect(result.added).toBe(0);
		expect(result.skipped).toBe(1);
		expect(result.ambiguous).toHaveLength(1);
		expect(result.ambiguous[0]).toContain('commentary.en.srt');
		expect(result.ambiguous[0]).toContain('2 episode files');
		expect(await savedSubtitles()).toHaveLength(0);
	});

	it('uses directory proximity only when the directory has exactly one episode file', async () => {
		await seedRootAndSeries();
		await seedEpisode('ep-1', 1, 1);
		await seedEpisodeFile('ef-1', 'Season 01/Show.Whatever.mkv', ['ep-1']);

		const service = SubtitleScannerService.getInstance();
		mockDiscovery(service, [
			sidecar({ relativePath: 'Season 01/mystery.en.srt', videoFileName: 'mystery' })
		]);

		const result = await service.scanSeriesSubtitles(SERIES_ID);

		expect(result.added).toBe(1);
		const saved = await savedSubtitles();
		expect(saved[0].episodeId).toBe('ep-1');
	});

	it('skips a sidecar with no episode file in its directory', async () => {
		await seedRootAndSeries();
		await seedEpisode('ep-1', 1, 1);
		await seedEpisodeFile('ef-1', 'Show S01E01.mkv', ['ep-1']);

		const service = SubtitleScannerService.getInstance();
		mockDiscovery(service, [
			sidecar({ relativePath: 'Extras/behind.en.srt', videoFileName: 'behind' })
		]);

		const result = await service.scanSeriesSubtitles(SERIES_ID);

		expect(result.skipped).toBe(1);
		expect(result.ambiguous[0]).toContain('no episode file');
	});

	it('stores episode rows on the episode-dir base that resolves identically via subtitle-paths and sync', async () => {
		await seedRootAndSeries();
		await seedEpisode('ep-1', 1, 1);
		await seedEpisodeFile('ef-1', 'Season 01/Show S01E01.mkv', ['ep-1']);

		const service = SubtitleScannerService.getInstance();
		mockDiscovery(service, [
			sidecar({
				relativePath: 'Season 01/Show S01E01.en.srt',
				videoFileName: 'Show S01E01'
			})
		]);

		const result = await service.scanSeriesSubtitles(SERIES_ID);
		expect(result.added).toBe(1);

		const [row] = await savedSubtitles();
		expect(row.relativePath).toBe('Show S01E01.en.srt');

		const expectedAbs = join(ROOT_PATH, 'Show', 'Season 01', 'Show S01E01.en.srt');

		const resolved = await resolveStoredSubtitlePath(row);
		expect(resolved).toBe(expectedAbs);

		const syncService = SubtitleSyncService.getInstance() as unknown as {
			getSubtitlePaths(r: typeof row): Promise<{ subtitlePath: string | null }>;
		};
		const paths = await syncService.getSubtitlePaths(row);
		expect(paths.subtitlePath).toBe(expectedAbs);
	});

	it('creates one row per episode for a multi-episode sidecar and is scan-stable', async () => {
		await seedRootAndSeries();
		await seedEpisode('ep-1', 1, 1);
		await seedEpisode('ep-2', 1, 2);
		await seedEpisodeFile('ef-both', 'Season 01/Show S01E01E02.mkv', ['ep-1', 'ep-2']);

		const service = SubtitleScannerService.getInstance();
		mockDiscovery(service, [
			sidecar({
				relativePath: 'Season 01/Show S01E01E02.en.srt',
				videoFileName: 'Show S01E01E02'
			})
		]);

		const first = await service.scanSeriesSubtitles(SERIES_ID);

		expect(first.added).toBe(2);
		const saved = await savedSubtitles();
		expect(saved).toHaveLength(2);
		expect(saved.map((row) => row.episodeId).sort()).toEqual(['ep-1', 'ep-2']);
		expect(new Set(saved.map((row) => row.relativePath))).toEqual(
			new Set(['Show S01E01E02.en.srt'])
		);

		// A second scan must not delete the sibling episode's row.
		const second = await service.scanSeriesSubtitles(SERIES_ID);
		expect(second.removed).toBe(0);
		expect(await savedSubtitles()).toHaveLength(2);
	});

	it('reassigns a stored row whose file now belongs to a different episode', async () => {
		await seedRootAndSeries();
		await seedEpisode('ep-1', 1, 1);
		await seedEpisode('ep-2', 1, 2);
		await seedEpisodeFile('ef-1', 'Season 01/Show S01E01.mkv', ['ep-1']);
		await seedEpisodeFile('ef-2', 'Season 01/Show S01E02.mkv', ['ep-2']);
		// Pre-existing row for the S01E01 sidecar but wrongly attached to ep-2.
		await testDb.db.insert(subtitles).values({
			id: 'sub-stale',
			episodeId: 'ep-2',
			relativePath: 'Show S01E01.en.srt',
			language: 'en',
			isForced: false,
			isHearingImpaired: false,
			format: 'srt',
			size: 40
		});

		const service = SubtitleScannerService.getInstance();
		mockDiscovery(service, [
			sidecar({
				relativePath: 'Season 01/Show S01E01.en.srt',
				videoFileName: 'Show S01E01'
			})
		]);

		const result = await service.scanSeriesSubtitles(SERIES_ID);

		// The old (ep-2) row points at the same absolute file as the desired
		// (ep-1) row, so it is removed as a stale association and re-added.
		expect(result.added).toBe(1);
		expect(result.removed).toBe(1);
		const saved = await savedSubtitles();
		expect(saved).toHaveLength(1);
		expect(saved[0].episodeId).toBe('ep-1');
		expect(saved[0].relativePath).toBe('Show S01E01.en.srt');

		const history = await testDb.db.select().from(subtitleHistory);
		expect(history.filter((h) => h.action === 'deleted')).toHaveLength(1);
	});

	it('skips discovery for a series with no episode files but still cleans its stale subtitle rows (arr parity)', async () => {
		await seedRootAndSeries();
		await seedEpisode('ep-1', 1, 1);
		// No episode files: nothing to discover, folder may not even exist.
		// A subtitle row survived from when the file existed.
		await testDb.db.insert(subtitles).values({
			id: 'sub-orphan',
			episodeId: 'ep-1',
			relativePath: 'Season 01/Show S01E01.en.srt',
			language: 'en',
			isForced: false,
			isHearingImpaired: false,
			format: 'srt',
			size: 40
		});

		const service = SubtitleScannerService.getInstance();
		const discoverSpy = vi.spyOn(service, 'discoverSubtitles').mockResolvedValue([]);

		const result = await service.scanSeriesSubtitles(SERIES_ID);

		expect(discoverSpy).not.toHaveBeenCalled();
		expect(result.errors).toHaveLength(0);
		// Owner-keyed reconcile sees the row; its path cannot resolve (the
		// episode has no media file anymore), so it is deleted.
		expect(result.removed).toBe(1);
		expect(await savedSubtitles()).toHaveLength(0);
	});

	it('logs a missing scan target at debug, not error', async () => {
		const service = SubtitleScannerService.getInstance();
		const missing = '/tmp/cinephage-does-not-exist-xyz';

		const discovered = await service.discoverSubtitles(missing, missing);

		expect(discovered).toEqual([]);
		expect(mockLogger.error).not.toHaveBeenCalled();
		expect(mockLogger.debug).toHaveBeenCalled();
	});
});
