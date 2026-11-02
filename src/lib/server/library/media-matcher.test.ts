/**
 * Media matcher regression tests.
 *
 * Bug #488: accepting a match for a file that lives outside the existing
 * series'/movie's own root folder (or folder layout) wrote an episode_files /
 * movie_files row whose path cannot be resolved - ENOENT on every consumer,
 * has_file=1 false "complete" state, and rows flapping on every scan.
 *
 * The match must be refused unless the file is inside the existing entry's
 * root folder + path (the same rule disk-scan enforces for auto-linking).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, clearTestDb, type TestDatabase } from '../../../test/db-helper';
import { eq, and } from 'drizzle-orm';
import {
	rootFolders,
	series,
	seasons,
	movies,
	movieFiles,
	episodeFiles,
	episodes,
	unmatchedFiles,
	libraries,
	downloadQueue,
	downloadClients,
	requests,
	user
} from '#lib/server/db/schema.js';
import { RootFolderConflictError } from '#lib/errors/index.js';
import { setSidecarSettings } from '#lib/server/library/sidecar/sidecarSettings.js';

const mocks = vi.hoisted(() => ({
	getTVShow: vi.fn(),
	getMovie: vi.fn(),
	getTvExternalIds: vi.fn(),
	getMovieExternalIds: vi.fn(),
	getSeason: vi.fn(),
	searchMovies: vi.fn(),
	searchTv: vi.fn(),
	extractMediaInfo: vi.fn(),
	getSettings: vi.fn(),
	resolveOwningLibraryForRootFolder: vi.fn(),
	reorganizeFolder: vi.fn(),
	previewMovie: vi.fn(),
	previewSeries: vi.fn(),
	executeRenames: vi.fn(),
	getClientInstance: vi.fn(),
	cancelByQueueId: vi.fn(),
	writeFile: vi.fn()
}));

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return { ...actual, writeFile: mocks.writeFile };
});

vi.mock('#lib/server/library/naming/RenamePreviewService.js', () => ({
	RenamePreviewService: class {
		reorganizeFolder = mocks.reorganizeFolder;
		previewMovie = mocks.previewMovie;
		previewSeries = mocks.previewSeries;
		executeRenames = mocks.executeRenames;
	}
}));

vi.mock('#lib/server/downloadClients/DownloadClientManager.js', () => ({
	getDownloadClientManager: () => ({
		getClientInstance: mocks.getClientInstance
	})
}));

vi.mock('#lib/server/acquisition/AcquisitionService.js', () => ({
	acquisitionService: {
		cancelByQueueId: mocks.cancelByQueueId
	}
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

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		getTVShow: mocks.getTVShow,
		getMovie: mocks.getMovie,
		getTvExternalIds: mocks.getTvExternalIds,
		getMovieExternalIds: mocks.getMovieExternalIds,
		getSeason: mocks.getSeason,
		searchMovies: mocks.searchMovies,
		searchTv: mocks.searchTv
	}
}));

vi.mock('#lib/server/library/media-info.js', () => ({
	mediaInfoService: {
		extractMediaInfo: mocks.extractMediaInfo
	}
}));

vi.mock('#lib/server/monitoring/MonitoringScheduler.js', () => ({
	monitoringScheduler: {
		getSettings: mocks.getSettings
	}
}));

vi.mock('#lib/server/subtitles/services/SubtitleImportService.js', () => ({
	searchSubtitlesForNewMedia: vi.fn()
}));

vi.mock('#lib/server/library/LibraryEntityService.js', () => ({
	getLibraryEntityService: () => ({
		resolveOwningLibraryForRootFolder: mocks.resolveOwningLibraryForRootFolder
	})
}));

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

const testDb: TestDatabase = createTestDb();

const { mediaMatcherService } = await import('./media-matcher.js');
const { unmatchedFileService } = await import('./unmatched-file-service.js');

async function insertRootFolder(id: string, path: string, mediaType: 'movie' | 'tv') {
	await testDb.db.insert(rootFolders).values({
		id,
		name: id,
		path,
		mediaType
	});
}

async function insertUnmatchedFile(input: {
	id: string;
	path: string;
	rootFolderId: string;
	mediaType: 'movie' | 'tv';
	parsedSeason?: number | null;
	parsedEpisode?: number | null;
}) {
	await testDb.db.insert(unmatchedFiles).values({
		id: input.id,
		path: input.path,
		rootFolderId: input.rootFolderId,
		mediaType: input.mediaType,
		parsedSeason: input.parsedSeason ?? null,
		parsedEpisode: input.parsedEpisode ?? null
	});
}

async function countEpisodeFiles(seriesId: string): Promise<number> {
	const rows = await testDb.db
		.select()
		.from(episodeFiles)
		.where(eq(episodeFiles.seriesId, seriesId));
	return rows.length;
}

async function countMovieFiles(movieId: string): Promise<number> {
	const rows = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, movieId));
	return rows.length;
}

async function unmatchedStillExists(id: string): Promise<boolean> {
	const rows = await testDb.db.select().from(unmatchedFiles).where(eq(unmatchedFiles.id, id));
	return rows.length > 0;
}

beforeEach(() => {
	vi.clearAllMocks();
	clearTestDb(testDb);

	// Library row referenced by series/movies foreign keys (not cleared by
	// clearTestDb, so delete any row from a previous test first).
	testDb.db.delete(libraries).run();
	testDb.db
		.insert(libraries)
		.values({
			id: 'lib-1',
			name: 'Test Library',
			slug: 'test-library',
			mediaType: 'tv'
		})
		.run();

	mocks.getTvExternalIds.mockResolvedValue({ tvdb_id: null, imdb_id: null });
	mocks.getMovieExternalIds.mockResolvedValue({ imdb_id: null });
	mocks.extractMediaInfo.mockResolvedValue({ format: 'mkv' });
	mocks.getSettings.mockResolvedValue({ subtitleSearchOnImportEnabled: false });
	mocks.resolveOwningLibraryForRootFolder.mockResolvedValue({
		id: 'lib-1',
		defaultWantsSubtitles: false,
		qualityProfileId: null
	});

	const emptyPreview = {
		willChange: [],
		alreadyCorrect: [],
		collisions: [],
		errors: [],
		totalFiles: 0,
		totalWillChange: 0,
		totalAlreadyCorrect: 0,
		totalCollisions: 0,
		totalErrors: 0
	};
	mocks.reorganizeFolder.mockResolvedValue({ success: true });
	mocks.previewMovie.mockResolvedValue(emptyPreview);
	mocks.previewSeries.mockResolvedValue(emptyPreview);
	mocks.executeRenames.mockResolvedValue({
		success: true,
		processed: 0,
		succeeded: 0,
		failed: 0,
		results: [],
		warnings: []
	});
	mocks.writeFile.mockResolvedValue(undefined);
	// The settings table isn't cleared by clearTestDb - reset explicitly so a
	// sidecar-enabling test doesn't leak into the next one.
	setSidecarSettings({ enabled: false });
});

describe('MediaMatcherService acceptMatch root folder conflict guard (bug #488)', () => {
	it('refuses to link a TV file into an existing series under a different root folder', async () => {
		await insertRootFolder('rf-a', '/mnt/tv-a', 'tv');
		await insertRootFolder('rf-b', '/mnt/tv-b', 'tv');
		await testDb.db.insert(series).values({
			id: 's1',
			tmdbId: 1001,
			title: 'Show (2016)',
			path: 'Show (2016)',
			rootFolderId: 'rf-a',
			libraryId: 'lib-1'
		});
		await insertUnmatchedFile({
			id: 'uf1',
			path: '/mnt/tv-b/Show (2016)/Season 4/ep.mkv',
			rootFolderId: 'rf-b',
			mediaType: 'tv',
			parsedSeason: 4,
			parsedEpisode: 1
		});

		await expect(mediaMatcherService.acceptMatch('uf1', 1001, 'tv')).rejects.toThrow(
			RootFolderConflictError
		);
		expect(await countEpisodeFiles('s1')).toBe(0);
		expect(await unmatchedStillExists('uf1')).toBe(true);
	});

	it('refuses to link a TV file into an existing series under the same root but a different folder', async () => {
		await insertRootFolder('rf-a', '/mnt/tv-a', 'tv');
		await testDb.db.insert(series).values({
			id: 's1',
			tmdbId: 1001,
			title: 'Show (2016)',
			path: 'Show (2016)',
			rootFolderId: 'rf-a',
			libraryId: 'lib-1'
		});
		await insertUnmatchedFile({
			id: 'uf1',
			path: '/mnt/tv-a/Other Name/Season 4/ep.mkv',
			rootFolderId: 'rf-a',
			mediaType: 'tv',
			parsedSeason: 4,
			parsedEpisode: 1
		});

		await expect(mediaMatcherService.acceptMatch('uf1', 1001, 'tv')).rejects.toThrow(
			RootFolderConflictError
		);
		expect(await countEpisodeFiles('s1')).toBe(0);
	});

	it('links a TV file normally when the root folder path has a trailing slash (GitHub #595)', async () => {
		// A plain String.startsWith comparison used to false-positive a
		// conflict whenever the two path strings differed only cosmetically,
		// e.g. a root folder re-saved with a trailing slash (a real
		// troubleshooting step users take, and something NFS-backed root
		// folders can produce on their own). path.relative() normalizes this.
		await insertRootFolder('rf-a', '/mnt/tv-a/', 'tv');
		await testDb.db.insert(series).values({
			id: 's1',
			tmdbId: 1001,
			title: 'Show (2016)',
			path: 'Show (2016)',
			rootFolderId: 'rf-a',
			libraryId: 'lib-1'
		});
		await insertUnmatchedFile({
			id: 'uf1',
			path: '/mnt/tv-a/Show (2016)/Season 4/ep.mkv',
			rootFolderId: 'rf-a',
			mediaType: 'tv',
			parsedSeason: 4,
			parsedEpisode: 1
		});
		mocks.getTVShow.mockResolvedValue({ id: 1001, name: 'Show (2016)', seasons: [] });

		await mediaMatcherService.acceptMatch('uf1', 1001, 'tv');

		expect(await countEpisodeFiles('s1')).toBe(1);
		expect(await unmatchedStillExists('uf1')).toBe(false);
	});

	it('links a TV file normally when it is inside the existing series root folder and path', async () => {
		await insertRootFolder('rf-a', '/mnt/tv-a', 'tv');
		await testDb.db.insert(series).values({
			id: 's1',
			tmdbId: 1001,
			title: 'Show (2016)',
			path: 'Show (2016)',
			rootFolderId: 'rf-a',
			libraryId: 'lib-1'
		});
		await insertUnmatchedFile({
			id: 'uf1',
			path: '/mnt/tv-a/Show (2016)/Season 4/ep.mkv',
			rootFolderId: 'rf-a',
			mediaType: 'tv',
			parsedSeason: 4,
			parsedEpisode: 1
		});
		mocks.getTVShow.mockResolvedValue({ id: 1001, name: 'Show (2016)', seasons: [] });

		await mediaMatcherService.acceptMatch('uf1', 1001, 'tv');

		expect(await countEpisodeFiles('s1')).toBe(1);
		expect(await unmatchedStillExists('uf1')).toBe(false);
	});

	it('refuses to link a movie file into an existing movie under a different root folder', async () => {
		await insertRootFolder('rf-a', '/mnt/movies-a', 'movie');
		await insertRootFolder('rf-b', '/mnt/movies-b', 'movie');
		await testDb.db.insert(movies).values({
			id: 'm1',
			tmdbId: 2001,
			title: 'Movie (2010)',
			path: 'Movie (2010)',
			rootFolderId: 'rf-a',
			libraryId: 'lib-1'
		});
		await insertUnmatchedFile({
			id: 'uf2',
			path: '/mnt/movies-b/Movie (2010)/movie.mkv',
			rootFolderId: 'rf-b',
			mediaType: 'movie'
		});

		await expect(mediaMatcherService.acceptMatch('uf2', 2001, 'movie')).rejects.toThrow(
			RootFolderConflictError
		);
		expect(await countMovieFiles('m1')).toBe(0);
	});

	it('links a movie file normally when it is inside the existing movie root folder and path', async () => {
		await insertRootFolder('rf-a', '/mnt/movies-a', 'movie');
		await testDb.db.insert(movies).values({
			id: 'm1',
			tmdbId: 2001,
			title: 'Movie (2010)',
			path: 'Movie (2010)',
			rootFolderId: 'rf-a',
			libraryId: 'lib-1'
		});
		await insertUnmatchedFile({
			id: 'uf2',
			path: '/mnt/movies-a/Movie (2010)/movie.mkv',
			rootFolderId: 'rf-a',
			mediaType: 'movie'
		});
		mocks.getMovie.mockResolvedValue({
			id: 2001,
			title: 'Movie (2010)',
			release_date: '2010-05-01'
		});

		await mediaMatcherService.acceptMatch('uf2', 2001, 'movie');

		expect(await countMovieFiles('m1')).toBe(1);
		const [movieRow] = await testDb.db
			.select({ hasFile: movies.hasFile })
			.from(movies)
			.where(eq(movies.id, 'm1'));
		expect(movieRow.hasFile).toBe(true);
	});

	it('creates a new series under the file root folder when no series exists yet', async () => {
		await insertRootFolder('rf-b', '/mnt/tv-b', 'tv');
		await insertUnmatchedFile({
			id: 'uf3',
			path: '/mnt/tv-b/New Show (2020)/Season 1/ep1.mkv',
			rootFolderId: 'rf-b',
			mediaType: 'tv',
			parsedSeason: 1,
			parsedEpisode: 1
		});
		mocks.getTVShow.mockResolvedValue({
			id: 9999,
			name: 'New Show (2020)',
			first_air_date: '2020-01-01',
			seasons: [{ season_number: 1, name: 'Season 1', episode_count: 1 }]
		});
		mocks.getSeason.mockResolvedValue({
			episodes: [
				{
					id: 999,
					season_number: 1,
					episode_number: 1,
					name: 'Pilot',
					overview: '',
					air_date: '2020-01-01',
					runtime: 45
				}
			]
		});

		await mediaMatcherService.acceptMatch('uf3', 9999, 'tv');

		const [created] = await testDb.db.select().from(series).where(eq(series.tmdbId, 9999));
		expect(created.rootFolderId).toBe('rf-b');
		expect(created.path).toBe('New Show (2020)');
		// Writers never persist the resolved default profile onto items.
		expect(created.languageProfileId).toBeNull();
		expect(await countEpisodeFiles(created.id)).toBe(1);

		const epRows = await testDb.db
			.select()
			.from(episodes)
			.where(and(eq(episodes.seriesId, created.id), eq(episodes.episodeNumber, 1)));
		expect(epRows).toHaveLength(1);
	});
});

describe('sidecar files on manual match', () => {
	// Artwork download is skipped in these tests
	// (includeArtwork: false) to keep them network-free.
	it('writes a movie .nfo when a manual match completes and sidecars are enabled', async () => {
		setSidecarSettings({ enabled: true, includeArtwork: false });

		await insertRootFolder('rf-m', '/mnt/movies-m', 'movie');
		await insertUnmatchedFile({
			id: 'uf-sidecar-movie',
			path: '/mnt/movies-m/Movie (2010)/movie.mkv',
			rootFolderId: 'rf-m',
			mediaType: 'movie'
		});
		mocks.getMovie.mockResolvedValue({
			id: 3001,
			title: 'Movie (2010)',
			release_date: '2010-05-01'
		});

		await mediaMatcherService.acceptMatch('uf-sidecar-movie', 3001, 'movie');

		const nfoCall = mocks.writeFile.mock.calls.find((call) =>
			String(call[0]).endsWith('movie.nfo')
		);
		expect(nfoCall).toBeDefined();
		expect(nfoCall![0]).toBe('/mnt/movies-m/Movie (2010)/movie.nfo');
		expect(String(nfoCall![1])).toContain('<title>Movie (2010)</title>');
	});

	it('does not write a .nfo when sidecars are disabled', async () => {
		setSidecarSettings({ enabled: false });

		await insertRootFolder('rf-m2', '/mnt/movies-m2', 'movie');
		await insertUnmatchedFile({
			id: 'uf-sidecar-movie-off',
			path: '/mnt/movies-m2/Movie (2011)/movie.mkv',
			rootFolderId: 'rf-m2',
			mediaType: 'movie'
		});
		mocks.getMovie.mockResolvedValue({
			id: 3002,
			title: 'Movie (2011)',
			release_date: '2011-05-01'
		});

		await mediaMatcherService.acceptMatch('uf-sidecar-movie-off', 3002, 'movie');

		expect(mocks.writeFile).not.toHaveBeenCalled();
	});

	it('writes episode and tvshow .nfo files when a manual TV match completes', async () => {
		setSidecarSettings({ enabled: true, includeArtwork: false });

		await insertRootFolder('rf-t', '/mnt/tv-t', 'tv');
		await insertUnmatchedFile({
			id: 'uf-sidecar-tv',
			path: '/mnt/tv-t/Show (2021)/Season 1/ep1.mkv',
			rootFolderId: 'rf-t',
			mediaType: 'tv',
			parsedSeason: 1,
			parsedEpisode: 1
		});
		mocks.getTVShow.mockResolvedValue({
			id: 4001,
			name: 'Show (2021)',
			first_air_date: '2021-01-01',
			seasons: [{ season_number: 1, name: 'Season 1', episode_count: 1 }]
		});
		mocks.getSeason.mockResolvedValue({
			episodes: [
				{
					id: 111,
					season_number: 1,
					episode_number: 1,
					name: 'Pilot',
					overview: '',
					air_date: '2021-01-01',
					runtime: 45
				}
			]
		});

		await mediaMatcherService.acceptMatch('uf-sidecar-tv', 4001, 'tv');

		const writtenPaths = mocks.writeFile.mock.calls.map((call) => String(call[0]));
		expect(writtenPaths).toContain('/mnt/tv-t/Show (2021)/Season 1/ep1.nfo');
		expect(writtenPaths).toContain('/mnt/tv-t/Show (2021)/tvshow.nfo');

		const episodeNfoCall = mocks.writeFile.mock.calls.find(
			(call) => String(call[0]) === '/mnt/tv-t/Show (2021)/Season 1/ep1.nfo'
		);
		expect(String(episodeNfoCall![1])).toContain('<showtitle>Show (2021)</showtitle>');
	});
});

describe('MediaMatcherService auto-match root folder conflict (bug #488)', () => {
	it('keeps the file unmatched with reason root_folder_conflict when auto-match hits a conflicting root', async () => {
		await insertRootFolder('rf-a', '/mnt/tv-a', 'tv');
		await insertRootFolder('rf-b', '/mnt/tv-b', 'tv');
		await testDb.db.insert(series).values({
			id: 's1',
			tmdbId: 1001,
			title: 'Show (2016)',
			path: 'Show (2016)',
			rootFolderId: 'rf-a',
			libraryId: 'lib-1'
		});
		await insertUnmatchedFile({
			id: 'uf1',
			path: '/mnt/tv-b/Show (2016) [tmdbid-1001]/Season 4/ep.mkv',
			rootFolderId: 'rf-b',
			mediaType: 'tv',
			parsedSeason: 4,
			parsedEpisode: 1
		});
		mocks.getTVShow.mockResolvedValue({ id: 1001, name: 'Show (2016)', seasons: [] });

		const result = await mediaMatcherService.processUnmatchedFile('uf1');

		expect(result.matched).toBe(false);
		expect(result.reason).toContain('root folder');
		expect(await countEpisodeFiles('s1')).toBe(0);

		const [row] = await testDb.db.select().from(unmatchedFiles).where(eq(unmatchedFiles.id, 'uf1'));
		expect(row.reason).toBe('root_folder_conflict');
	});
});

describe('Manual match via unmatchedFileService (bug #488)', () => {
	it('surfaces the root folder conflict as a per-file failure', async () => {
		await insertRootFolder('rf-a', '/mnt/tv-a', 'tv');
		await insertRootFolder('rf-b', '/mnt/tv-b', 'tv');
		await testDb.db.insert(series).values({
			id: 's1',
			tmdbId: 1001,
			title: 'Show (2016)',
			path: 'Show (2016)',
			rootFolderId: 'rf-a',
			libraryId: 'lib-1'
		});
		await insertUnmatchedFile({
			id: 'uf1',
			path: '/mnt/tv-b/Show (2016)/Season 4/ep.mkv',
			rootFolderId: 'rf-b',
			mediaType: 'tv',
			parsedSeason: 4,
			parsedEpisode: 1
		});

		const result = await unmatchedFileService.matchFiles({
			fileIds: ['uf1'],
			tmdbId: 1001,
			mediaType: 'tv'
		});

		expect(result.failed).toBe(1);
		expect(result.matched).toBe(0);
		expect(result.errors[0]).toContain('root folder');
		expect(await countEpisodeFiles('s1')).toBe(0);
	});
});

describe('series-directory context matching (issue #513)', () => {
	it('matches a TV file whose filename is polluted, via its series folder name', async () => {
		await insertRootFolder('rf-513', '/media/series', 'tv');
		await insertUnmatchedFile({
			id: 'uf-513',
			path: '/media/series/Breaking Bad/Season 3/Breaking Bad - [3x13] - Full Measure.mkv',
			rootFolderId: 'rf-513',
			mediaType: 'tv',
			parsedSeason: 3,
			parsedEpisode: 13
		});

		mocks.searchTv.mockImplementation(async (query: string) => {
			if (/breaking bad/i.test(query)) {
				return {
					results: [{ id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20' }]
				};
			}
			return { results: [] };
		});
		mocks.getTVShow.mockResolvedValue({
			id: 1396,
			name: 'Breaking Bad',
			first_air_date: '2008-01-20',
			seasons: [{ season_number: 3, name: 'Season 3', episode_count: 13 }]
		});
		mocks.getSeason.mockResolvedValue({
			episodes: [
				{
					id: 1,
					season_number: 3,
					episode_number: 13,
					name: 'Full Measure',
					overview: '',
					air_date: '2010-06-13',
					runtime: 47
				}
			]
		});

		const result = await mediaMatcherService.processUnmatchedFile('uf-513');
		expect(result.matched).toBe(true);
		expect(result.tmdbId).toBe(1396);
		const [created] = await testDb.db.select().from(series).where(eq(series.tmdbId, 1396));
		expect(created.title).toBe('Breaking Bad');
	});
});

describe('title matching hardening (issue #513 leftovers)', () => {
	it('auto-matches a movie whose local title is the TMDB original (foreign) title', async () => {
		await insertRootFolder('rf-lab', '/media/movies', 'movie');
		await insertUnmatchedFile({
			id: 'uf-lab',
			path: '/media/movies/Im Labyrinth des Schweigens (2010).mkv',
			rootFolderId: 'rf-lab',
			mediaType: 'movie'
		});
		mocks.searchMovies.mockResolvedValue({
			results: [
				{
					id: 45642,
					title: 'Labyrinth of Lies',
					original_title: 'Im Labyrinth des Schweigens',
					release_date: '2010-11-11'
				}
			]
		});
		mocks.getMovie.mockResolvedValue({
			id: 45642,
			title: 'Labyrinth of Lies',
			original_title: 'Im Labyrinth des Schweigens',
			release_date: '2010-11-11'
		});

		const result = await mediaMatcherService.processUnmatchedFile('uf-lab');

		expect(result.matched).toBe(true);
		expect(result.tmdbId).toBe(45642);
	});

	it('auto-matches a movie whose parsed title carries a trailing article and queries TMDB with the canonical form', async () => {
		await insertRootFolder('rf-lion', '/media/movies', 'movie');
		await insertUnmatchedFile({
			id: 'uf-lion',
			path: '/media/movies/Lion King, The (1994).mkv',
			rootFolderId: 'rf-lion',
			mediaType: 'movie'
		});
		mocks.searchMovies.mockResolvedValue({
			results: [
				{
					id: 8587,
					title: 'The Lion King',
					original_title: 'The Lion King',
					release_date: '1994-06-15'
				}
			]
		});
		mocks.getMovie.mockResolvedValue({
			id: 8587,
			title: 'The Lion King',
			original_title: 'The Lion King',
			release_date: '1994-06-15'
		});

		const result = await mediaMatcherService.processUnmatchedFile('uf-lion');

		expect(mocks.searchMovies).toHaveBeenCalledWith(
			expect.stringMatching(/^the lion king$/i),
			1994,
			true
		);
		expect(result.matched).toBe(true);
		expect(result.tmdbId).toBe(8587);

		const [createdMovie] = await testDb.db.select().from(movies).where(eq(movies.tmdbId, 8587));
		expect(createdMovie.languageProfileId).toBeNull();
	});
});

describe('special episode title fallback (AroTheHawk report)', () => {
	// Episode titles below are LIVE TMDB season-0 data, verified 2026-09-20
	// (BSG tmdb 1972, Cosmos tmdb 1430). Do not "fix" them to match
	// expectations — change the matcher instead.

	it('acceptMatch resolves a title-only special via season 0 title match', async () => {
		await insertRootFolder('rf-bsg', '/mnt/tv-bsg', 'tv');
		await testDb.db.insert(series).values({
			id: 's-bsg',
			tmdbId: 1972,
			title: 'Battlestar Galactica',
			path: 'Battlestar Galactica (2003) {tvdb-73545}',
			rootFolderId: 'rf-bsg',
			libraryId: 'lib-1'
		});
		await testDb.db.insert(episodes).values([
			{
				id: 'ep-razor-1',
				seriesId: 's-bsg',
				seasonNumber: 0,
				episodeNumber: 19,
				title: 'Razor (1)',
				airDate: '2007-11-24'
			},
			{
				id: 'ep-razor-2',
				seriesId: 's-bsg',
				seasonNumber: 0,
				episodeNumber: 20,
				title: 'Razor (2)',
				airDate: '2007-11-24'
			}
		]);
		await insertUnmatchedFile({
			id: 'uf-razor',
			path: '/mnt/tv-bsg/Battlestar Galactica (2003) {tvdb-73545}/Razor (2007)/Razor (2007).mp4',
			rootFolderId: 'rf-bsg',
			mediaType: 'tv'
		});
		mocks.getTVShow.mockResolvedValue({ id: 1972, name: 'Battlestar Galactica', seasons: [] });

		await mediaMatcherService.acceptMatch('uf-razor', 1972, 'tv');

		expect(await countEpisodeFiles('s-bsg')).toBe(1);
		const [fileRow] = await testDb.db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, 's-bsg'));
		expect(fileRow.seasonNumber).toBe(0);
		// "razor2" is contained in normalized "razor2007"; "razor1" is not.
		expect(fileRow.episodeIds).toEqual(['ep-razor-2']);
		expect(fileRow.relativePath).toBe('Razor (2007)/Razor (2007).mp4');
		expect(await unmatchedStillExists('uf-razor')).toBe(false);
	});

	it('acceptMatch maps an absolute number onto the single regular season (Cosmos)', async () => {
		await insertRootFolder('rf-cosmos', '/mnt/tv-cosmos', 'tv');
		await testDb.db.insert(series).values({
			id: 's-cosmos',
			tmdbId: 1430,
			title: 'Cosmos: A Personal Voyage',
			path: 'Cosmos (1980) {tvdb-74995}',
			rootFolderId: 'rf-cosmos',
			libraryId: 'lib-1'
		});
		// Live shape: season 0 specials + a single regular season of 13.
		await testDb.db.insert(episodes).values([
			{
				id: 'ep-cosmos-s0',
				seriesId: 's-cosmos',
				seasonNumber: 0,
				episodeNumber: 1,
				title: 'A Dialogue Between Carl Sagan And Ted Turner',
				airDate: '1989-04-18'
			},
			...Array.from({ length: 12 }, (_, i) => ({
				id: `ep-cosmos-${i + 1}`,
				seriesId: 's-cosmos',
				seasonNumber: 1,
				episodeNumber: i + 1,
				title: `Cosmos Episode ${i + 1}`,
				airDate: null
			})),
			{
				id: 'ep-cosmos-13',
				seriesId: 's-cosmos',
				seasonNumber: 1,
				episodeNumber: 13,
				title: 'Who Speaks for Earth?',
				airDate: '1980-12-21'
			}
		]);
		await insertUnmatchedFile({
			id: 'uf-cosmos',
			path: '/mnt/tv-cosmos/Cosmos (1980) {tvdb-74995}/Episode 13 - Quem Responde Pela Terra (Who Speaks for Earth).mkv',
			rootFolderId: 'rf-cosmos',
			mediaType: 'tv',
			parsedEpisode: 13
		});
		mocks.getTVShow.mockResolvedValue({
			id: 1430,
			name: 'Cosmos: A Personal Voyage',
			seasons: []
		});

		await mediaMatcherService.acceptMatch('uf-cosmos', 1430, 'tv');

		expect(await countEpisodeFiles('s-cosmos')).toBe(1);
		const [fileRow] = await testDb.db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, 's-cosmos'));
		expect(fileRow.seasonNumber).toBe(1);
		expect(fileRow.episodeIds).toEqual(['ep-cosmos-13']);
	});

	it('still throws when no special title matches the file', async () => {
		await insertRootFolder('rf-bsg2', '/mnt/tv-bsg2', 'tv');
		await testDb.db.insert(series).values({
			id: 's-bsg2',
			tmdbId: 1973,
			title: 'Battlestar Galactica',
			path: 'Battlestar Galactica (2003) {tvdb-73545}',
			rootFolderId: 'rf-bsg2',
			libraryId: 'lib-1'
		});
		await testDb.db.insert(episodes).values({
			id: 'ep-bsg2-19',
			seriesId: 's-bsg2',
			seasonNumber: 0,
			episodeNumber: 19,
			title: 'Razor (1)',
			airDate: '2007-11-24'
		});
		await insertUnmatchedFile({
			id: 'uf-plan',
			path: '/mnt/tv-bsg2/Battlestar Galactica (2003) {tvdb-73545}/The Plan (2009)/The Plan (2009).mp4',
			rootFolderId: 'rf-bsg2',
			mediaType: 'tv'
		});
		mocks.getTVShow.mockResolvedValue({ id: 1973, name: 'Battlestar Galactica', seasons: [] });

		await expect(mediaMatcherService.acceptMatch('uf-plan', 1973, 'tv')).rejects.toThrow(
			'Could not determine season/episode from filename'
		);
		expect(await countEpisodeFiles('s-bsg2')).toBe(0);
		expect(await unmatchedStillExists('uf-plan')).toBe(true);
	});
});

describe('MediaMatcherService rematchMovie / rematchSeries (Change Match feature)', () => {
	it('rematches a movie in place: updates metadata, reorganizes the folder, and renames files', async () => {
		await insertRootFolder('rf-m', '/mnt/movies-a', 'movie');
		await testDb.db.insert(movies).values({
			id: 'm1',
			tmdbId: 1,
			title: 'Wrong Movie',
			path: 'Wrong Movie (1999)',
			rootFolderId: 'rf-m',
			libraryId: 'lib-1',
			year: 1999,
			hasFile: true
		});
		mocks.getMovie.mockResolvedValue({
			id: 2,
			title: 'Right Movie',
			original_title: 'Right Movie',
			original_language: 'en',
			release_date: '2020-06-01',
			overview: 'The correct one',
			poster_path: '/right.jpg',
			backdrop_path: '/right-bd.jpg',
			runtime: 100,
			genres: [{ name: 'Drama' }]
		});
		mocks.getMovieExternalIds.mockResolvedValue({ imdb_id: 'tt9999' });

		const result = await mediaMatcherService.rematchMovie('m1', 2);

		expect(result.title).toBe('Right Movie');
		const [updated] = await testDb.db.select().from(movies).where(eq(movies.id, 'm1'));
		expect(updated.tmdbId).toBe(2);
		expect(updated.title).toBe('Right Movie');
		expect(updated.year).toBe(2020);
		expect(updated.imdbId).toBe('tt9999');
		expect(mocks.reorganizeFolder).toHaveBeenCalledWith('m1', 'movie');
		expect(mocks.previewMovie).toHaveBeenCalledWith('m1');
	});

	it('rejects rematching a movie onto a tmdbId already used by a different movie', async () => {
		await insertRootFolder('rf-m', '/mnt/movies-a', 'movie');
		await testDb.db.insert(movies).values({
			id: 'm1',
			tmdbId: 1,
			title: 'Movie One',
			path: 'Movie One (1999)',
			rootFolderId: 'rf-m',
			libraryId: 'lib-1'
		});
		await testDb.db.insert(movies).values({
			id: 'm2',
			tmdbId: 2,
			title: 'Movie Two',
			path: 'Movie Two (2001)',
			rootFolderId: 'rf-m',
			libraryId: 'lib-1'
		});

		await expect(mediaMatcherService.rematchMovie('m1', 2)).rejects.toThrow(
			'Movie Two" is already matched'
		);
		expect(mocks.reorganizeFolder).not.toHaveBeenCalled();
	});

	it("rejects a no-op rematch to the movie's current tmdbId", async () => {
		await insertRootFolder('rf-m', '/mnt/movies-a', 'movie');
		await testDb.db.insert(movies).values({
			id: 'm1',
			tmdbId: 1,
			title: 'Movie One',
			path: 'Movie One (1999)',
			rootFolderId: 'rf-m',
			libraryId: 'lib-1'
		});

		await expect(mediaMatcherService.rematchMovie('m1', 1)).rejects.toThrow('already matched');
	});

	it('cancels active downloads before rematching a movie', async () => {
		await insertRootFolder('rf-m', '/mnt/movies-a', 'movie');
		await testDb.db.insert(movies).values({
			id: 'm1',
			tmdbId: 1,
			title: 'Wrong Movie',
			path: 'Wrong Movie (1999)',
			rootFolderId: 'rf-m',
			libraryId: 'lib-1'
		});
		await testDb.db.insert(downloadClients).values({
			id: 'dc1',
			name: 'Test Client',
			implementation: 'qbittorrent',
			host: 'localhost',
			port: 8080
		});
		await testDb.db.insert(downloadQueue).values({
			id: 'q1',
			downloadClientId: 'dc1',
			downloadId: 'abc123',
			title: 'Wrong.Movie.1999.mkv',
			protocol: 'torrent',
			movieId: 'm1'
		});
		mocks.getClientInstance.mockResolvedValue({ removeDownload: vi.fn() });
		mocks.getMovie.mockResolvedValue({ id: 2, title: 'Right Movie', release_date: '2020-01-01' });

		await mediaMatcherService.rematchMovie('m1', 2);

		expect(mocks.cancelByQueueId).toHaveBeenCalledWith('q1', expect.any(String));
		const remainingQueue = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, 'q1'));
		expect(remainingQueue).toHaveLength(0);
	});

	it('backfills requests.tmdbId when a movie is rematched', async () => {
		await insertRootFolder('rf-m', '/mnt/movies-a', 'movie');
		await testDb.db.insert(movies).values({
			id: 'm1',
			tmdbId: 1,
			title: 'Wrong Movie',
			path: 'Wrong Movie (1999)',
			rootFolderId: 'rf-m',
			libraryId: 'lib-1'
		});
		await testDb.db.insert(user).values({
			id: 'user-1',
			email: 'requester@example.com',
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		});
		await testDb.db.insert(requests).values({
			id: 'req1',
			mediaType: 'movie',
			tmdbId: 1,
			title: 'Wrong Movie',
			movieId: 'm1',
			requestedBy: 'user-1'
		});
		mocks.getMovie.mockResolvedValue({ id: 2, title: 'Right Movie', release_date: '2020-01-01' });

		await mediaMatcherService.rematchMovie('m1', 2);

		const [req] = await testDb.db.select().from(requests).where(eq(requests.id, 'req1'));
		expect(req.tmdbId).toBe(2);
	});

	it('rematches a series in place: regenerates episodes and re-links existing files by season/episode number', async () => {
		await insertRootFolder('rf-s', '/mnt/tv-a', 'tv');
		await testDb.db.insert(series).values({
			id: 's1',
			tmdbId: 10,
			title: 'Wrong Show',
			path: 'Wrong Show (2020)',
			rootFolderId: 'rf-s',
			libraryId: 'lib-1',
			monitored: true
		});
		await testDb.db.insert(episodes).values({
			id: 'ep-old-1',
			seriesId: 's1',
			seasonNumber: 1,
			episodeNumber: 1,
			title: 'Old Pilot'
		});
		await testDb.db.insert(episodeFiles).values({
			id: 'ef1',
			seriesId: 's1',
			seasonNumber: 1,
			relativePath: 'Season 1/ep1.mkv',
			episodeIds: ['ep-old-1']
		});

		mocks.getTVShow.mockResolvedValue({
			id: 20,
			name: 'Right Show',
			first_air_date: '2021-02-01',
			seasons: [{ season_number: 1, name: 'Season 1', episode_count: 1 }]
		});
		mocks.getSeason.mockResolvedValue({
			episodes: [
				{
					id: 555,
					season_number: 1,
					episode_number: 1,
					name: 'Real Pilot',
					overview: '',
					air_date: '2021-02-01',
					runtime: 30
				}
			]
		});

		const result = await mediaMatcherService.rematchSeries('s1', 20);

		expect(result.title).toBe('Right Show');
		const [updatedSeries] = await testDb.db.select().from(series).where(eq(series.id, 's1'));
		expect(updatedSeries.tmdbId).toBe(20);
		expect(updatedSeries.title).toBe('Right Show');
		expect(updatedSeries.episodeGroupId).toBeNull();

		const newEpisodes = await testDb.db.select().from(episodes).where(eq(episodes.seriesId, 's1'));
		expect(newEpisodes).toHaveLength(1);
		expect(newEpisodes[0].title).toBe('Real Pilot');
		expect(newEpisodes[0].hasFile).toBe(true);

		const [relinkedFile] = await testDb.db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.id, 'ef1'));
		expect(relinkedFile.episodeIds).toEqual([newEpisodes[0].id]);

		expect(mocks.reorganizeFolder).toHaveBeenCalledWith('s1', 'series');
		expect(mocks.previewSeries).toHaveBeenCalledWith('s1');
	});

	it('preserves per-season and per-episode unmonitored choices across the episode rebuild', async () => {
		// deleteAllSeasonsAndEpisodes + populateSeriesEpisodes wipes and
		// recreates every season/episode row; without explicitly carrying
		// forward the prior monitored flags, a rematch (or an ordinary
		// refresh, same pattern) would silently re-monitor everything the
		// user had turned off.
		await insertRootFolder('rf-s', '/mnt/tv-a', 'tv');
		await testDb.db.insert(series).values({
			id: 's1',
			tmdbId: 10,
			title: 'Wrong Show',
			path: 'Wrong Show (2020)',
			rootFolderId: 'rf-s',
			libraryId: 'lib-1',
			monitored: true
		});
		await testDb.db.insert(seasons).values({
			id: 'season-old-1',
			seriesId: 's1',
			seasonNumber: 1,
			monitored: false
		});
		await testDb.db.insert(episodes).values([
			{
				id: 'ep-old-1',
				seriesId: 's1',
				seasonId: 'season-old-1',
				seasonNumber: 1,
				episodeNumber: 1,
				title: 'Old Pilot',
				monitored: false
			},
			{
				id: 'ep-old-2',
				seriesId: 's1',
				seasonId: 'season-old-1',
				seasonNumber: 1,
				episodeNumber: 2,
				title: 'Old Episode 2',
				monitored: true
			}
		]);

		mocks.getTVShow.mockResolvedValue({
			id: 20,
			name: 'Right Show',
			first_air_date: '2021-02-01',
			seasons: [{ season_number: 1, name: 'Season 1', episode_count: 2 }]
		});
		mocks.getSeason.mockResolvedValue({
			episodes: [
				{
					id: 555,
					season_number: 1,
					episode_number: 1,
					name: 'Real Pilot',
					overview: '',
					air_date: '2021-02-01',
					runtime: 30
				},
				{
					id: 556,
					season_number: 1,
					episode_number: 2,
					name: 'Real Episode 2',
					overview: '',
					air_date: '2021-02-08',
					runtime: 30
				}
			]
		});

		await mediaMatcherService.rematchSeries('s1', 20);

		const [newSeason] = await testDb.db
			.select()
			.from(seasons)
			.where(and(eq(seasons.seriesId, 's1'), eq(seasons.seasonNumber, 1)));
		expect(newSeason.monitored).toBe(false);

		const newEpisodes = await testDb.db.select().from(episodes).where(eq(episodes.seriesId, 's1'));
		const ep1 = newEpisodes.find((e) => e.episodeNumber === 1);
		const ep2 = newEpisodes.find((e) => e.episodeNumber === 2);
		expect(ep1?.monitored).toBe(false);
		expect(ep2?.monitored).toBe(true);
	});

	it('leaves a file unmatched when its season/episode number does not exist on the new show', async () => {
		await insertRootFolder('rf-s', '/mnt/tv-a', 'tv');
		await testDb.db.insert(series).values({
			id: 's1',
			tmdbId: 10,
			title: 'Wrong Show',
			path: 'Wrong Show (2020)',
			rootFolderId: 'rf-s',
			libraryId: 'lib-1'
		});
		await testDb.db.insert(episodes).values({
			id: 'ep-old-5',
			seriesId: 's1',
			seasonNumber: 5,
			episodeNumber: 9,
			title: 'Old Episode'
		});
		await testDb.db.insert(episodeFiles).values({
			id: 'ef1',
			seriesId: 's1',
			seasonNumber: 5,
			relativePath: 'Season 5/ep9.mkv',
			episodeIds: ['ep-old-5']
		});

		mocks.getTVShow.mockResolvedValue({
			id: 20,
			name: 'Right Show',
			seasons: [{ season_number: 1, name: 'Season 1', episode_count: 1 }]
		});
		mocks.getSeason.mockResolvedValue({
			episodes: [
				{
					id: 555,
					season_number: 1,
					episode_number: 1,
					name: 'Pilot',
					overview: '',
					air_date: '2021-02-01',
					runtime: 30
				}
			]
		});

		await mediaMatcherService.rematchSeries('s1', 20);

		const [file] = await testDb.db.select().from(episodeFiles).where(eq(episodeFiles.id, 'ef1'));
		expect(file.episodeIds).toBeNull();
	});

	it('rejects rematching a series onto a tmdbId already used by a different series', async () => {
		await insertRootFolder('rf-s', '/mnt/tv-a', 'tv');
		await testDb.db.insert(series).values({
			id: 's1',
			tmdbId: 10,
			title: 'Show One',
			path: 'Show One (2020)',
			rootFolderId: 'rf-s',
			libraryId: 'lib-1'
		});
		await testDb.db.insert(series).values({
			id: 's2',
			tmdbId: 20,
			title: 'Show Two',
			path: 'Show Two (2021)',
			rootFolderId: 'rf-s',
			libraryId: 'lib-1'
		});

		await expect(mediaMatcherService.rematchSeries('s1', 20)).rejects.toThrow(
			'Show Two" is already matched'
		);
		expect(mocks.reorganizeFolder).not.toHaveBeenCalled();
	});
});

describe('duplicate-file replacement on deliberate (re-)match (issue #627)', () => {
	it('retires the old movie file (single-quality) when a deliberate match links a differently-named file', async () => {
		await insertRootFolder('rf-627a', '/mnt/movies-627a', 'movie');
		await testDb.db.insert(movies).values({
			id: 'm627a',
			tmdbId: 6271,
			title: 'Movie X (2020)',
			path: 'Movie X (2020)',
			rootFolderId: 'rf-627a',
			libraryId: 'lib-1',
			hasFile: true
		});
		await testDb.db.insert(movieFiles).values({
			id: 'mf627a-old',
			movieId: 'm627a',
			relativePath: 'Movie X (2020) (Bluray-2160p-HDR10 DTS-X-7.1 x265).mkv',
			size: 1000,
			quality: { resolution: '2160p' }
		});
		await insertUnmatchedFile({
			id: 'uf627a',
			path: '/mnt/movies-627a/Movie X (2020)/Movie X (2020) (Bluray-2160p-x265 DTS7.1).mkv',
			rootFolderId: 'rf-627a',
			mediaType: 'movie'
		});
		mocks.getMovie.mockResolvedValue({
			id: 6271,
			title: 'Movie X (2020)',
			release_date: '2020-01-01'
		});

		await mediaMatcherService.acceptMatch('uf627a', 6271, 'movie', { allowReplace: true });

		const files = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, 'm627a'));
		expect(files).toHaveLength(1);
		expect(files[0].relativePath).toBe('Movie X (2020) (Bluray-2160p-x265 DTS7.1).mkv');
	});

	it("also removes the displaced file's .nfo sidecar, not just the video (no stale orphan)", async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), 'cinephage-627-nfo-'));
		try {
			await insertRootFolder('rf-627nfo', tmpRoot, 'movie');
			await testDb.db.insert(movies).values({
				id: 'm627nfo',
				tmdbId: 62710,
				title: 'Movie Nfo (2020)',
				path: 'Movie Nfo (2020)',
				rootFolderId: 'rf-627nfo',
				libraryId: 'lib-1',
				hasFile: true
			});
			const oldRelativePath = 'Movie Nfo (2020) (Bluray-2160p-HDR10 DTS-X-7.1 x265).mkv';
			await testDb.db.insert(movieFiles).values({
				id: 'mf627nfo-old',
				movieId: 'm627nfo',
				relativePath: oldRelativePath,
				size: 1000,
				quality: { resolution: '2160p' }
			});
			const movieDir = join(tmpRoot, 'Movie Nfo (2020)');
			const oldFilePath = join(movieDir, oldRelativePath);
			const oldNfoPath = join(movieDir, 'Movie Nfo (2020) (Bluray-2160p-HDR10 DTS-X-7.1 x265).nfo');
			mkdirSync(movieDir, { recursive: true });
			writeFileSync(oldFilePath, 'old video bytes');
			writeFileSync(oldNfoPath, '<movie></movie>');

			await insertUnmatchedFile({
				id: 'uf627nfo',
				path: join(movieDir, 'Movie Nfo (2020) (Bluray-2160p-x265 DTS7.1).mkv'),
				rootFolderId: 'rf-627nfo',
				mediaType: 'movie'
			});
			mocks.getMovie.mockResolvedValue({
				id: 62710,
				title: 'Movie Nfo (2020)',
				release_date: '2020-01-01'
			});

			await mediaMatcherService.acceptMatch('uf627nfo', 62710, 'movie', { allowReplace: true });

			await expect(access(oldNfoPath)).rejects.toThrow();
		} finally {
			await rm(tmpRoot, { recursive: true, force: true });
		}
	});

	it('does not retire a different resolution bucket in multi-quality mode', async () => {
		await insertRootFolder('rf-627b', '/mnt/movies-627b', 'movie');
		await testDb.db.insert(movies).values({
			id: 'm627b',
			tmdbId: 6272,
			title: 'Movie Y (2021)',
			path: 'Movie Y (2021)',
			rootFolderId: 'rf-627b',
			libraryId: 'lib-1',
			hasFile: true,
			desiredQualities: ['2160p', '1080p']
		});
		await testDb.db.insert(movieFiles).values({
			id: 'mf627b-1080p',
			movieId: 'm627b',
			relativePath: 'Movie Y (2021) (Bluray-1080p-x264).mkv',
			size: 500,
			quality: { resolution: '1080p' }
		});
		await insertUnmatchedFile({
			id: 'uf627b',
			path: '/mnt/movies-627b/Movie Y (2021)/Movie Y (2021) (Bluray-2160p-x265).mkv',
			rootFolderId: 'rf-627b',
			mediaType: 'movie'
		});
		mocks.getMovie.mockResolvedValue({
			id: 6272,
			title: 'Movie Y (2021)',
			release_date: '2021-01-01'
		});

		await mediaMatcherService.acceptMatch('uf627b', 6272, 'movie', { allowReplace: true });

		const files = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, 'm627b'));
		expect(files).toHaveLength(2);
	});

	it('leaves the old movie file alone when the match is not deliberate (allowReplace defaults to false)', async () => {
		await insertRootFolder('rf-627c', '/mnt/movies-627c', 'movie');
		await testDb.db.insert(movies).values({
			id: 'm627c',
			tmdbId: 6273,
			title: 'Movie Z (2019)',
			path: 'Movie Z (2019)',
			rootFolderId: 'rf-627c',
			libraryId: 'lib-1',
			hasFile: true
		});
		await testDb.db.insert(movieFiles).values({
			id: 'mf627c-old',
			movieId: 'm627c',
			relativePath: 'Movie Z (2019) (Bluray-2160p-HDR10 DTS-X-7.1 x265).mkv',
			size: 1000,
			quality: { resolution: '2160p' }
		});
		await insertUnmatchedFile({
			id: 'uf627c',
			path: '/mnt/movies-627c/Movie Z (2019)/Movie Z (2019) (Bluray-2160p-x265 DTS7.1).mkv',
			rootFolderId: 'rf-627c',
			mediaType: 'movie'
		});
		mocks.getMovie.mockResolvedValue({
			id: 6273,
			title: 'Movie Z (2019)',
			release_date: '2019-01-01'
		});

		await mediaMatcherService.acceptMatch('uf627c', 6273, 'movie');

		const files = await testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, 'm627c'));
		expect(files).toHaveLength(2);
	});

	it('retires the old episode file when a deliberate match covers the same episode under a new name', async () => {
		await insertRootFolder('rf-627d', '/mnt/tv-627d', 'tv');
		await testDb.db.insert(series).values({
			id: 's627d',
			tmdbId: 6274,
			title: 'Show X (2020)',
			path: 'Show X (2020)',
			rootFolderId: 'rf-627d',
			libraryId: 'lib-1'
		});
		await testDb.db.insert(seasons).values({
			seriesId: 's627d',
			seasonNumber: 1
		});
		const [ep1] = await testDb.db
			.insert(episodes)
			.values({
				seriesId: 's627d',
				seasonNumber: 1,
				episodeNumber: 1,
				hasFile: true
			})
			.returning();
		await testDb.db.insert(episodeFiles).values({
			id: 'ef627d-old',
			seriesId: 's627d',
			seasonNumber: 1,
			episodeIds: [ep1.id],
			relativePath: 'Season 1/Show X - S01E01 - Old Name.mkv',
			size: 500
		});
		await insertUnmatchedFile({
			id: 'uf627d',
			path: '/mnt/tv-627d/Show X (2020)/Season 1/Show X - S01E01 - New Name.mkv',
			rootFolderId: 'rf-627d',
			mediaType: 'tv',
			parsedSeason: 1,
			parsedEpisode: 1
		});
		mocks.getTVShow.mockResolvedValue({
			id: 6274,
			name: 'Show X (2020)',
			first_air_date: '2020-01-01',
			seasons: [{ season_number: 1, name: 'Season 1', episode_count: 1 }]
		});
		mocks.getSeason.mockResolvedValue({
			episodes: [
				{
					id: 1,
					season_number: 1,
					episode_number: 1,
					name: 'Pilot',
					overview: '',
					air_date: '2020-01-01',
					runtime: 45
				}
			]
		});

		await mediaMatcherService.acceptMatch('uf627d', 6274, 'tv', { allowReplace: true });

		const files = await testDb.db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, 's627d'));
		expect(files).toHaveLength(1);
		expect(files[0].relativePath).toBe('Season 1/Show X - S01E01 - New Name.mkv');
	});
});

describe('collection tagging on manual match', () => {
	it('tags a newly-created movie with its TMDB collection', async () => {
		await insertRootFolder('rf-coll', '/mnt/movies-coll', 'movie');
		await insertUnmatchedFile({
			id: 'uf-coll',
			path: '/mnt/movies-coll/Weapons Collection/Weapons (2025)/Weapons (2025).mkv',
			rootFolderId: 'rf-coll',
			mediaType: 'movie'
		});
		mocks.getMovie.mockResolvedValue({
			id: 7001,
			title: 'Weapons',
			release_date: '2025-08-08',
			belongs_to_collection: { id: 999, name: 'Weapons Collection' }
		});

		await mediaMatcherService.acceptMatch('uf-coll', 7001, 'movie');

		const [movie] = await testDb.db.select().from(movies).where(eq(movies.tmdbId, 7001));
		expect(movie.tmdbCollectionId).toBe(999);
		expect(movie.collectionName).toBe('Weapons Collection');
	});

	it('leaves collection fields null when the movie has no TMDB collection', async () => {
		await insertRootFolder('rf-nocoll', '/mnt/movies-nocoll', 'movie');
		await insertUnmatchedFile({
			id: 'uf-nocoll',
			path: '/mnt/movies-nocoll/Standalone (2024)/Standalone (2024).mkv',
			rootFolderId: 'rf-nocoll',
			mediaType: 'movie'
		});
		mocks.getMovie.mockResolvedValue({
			id: 7002,
			title: 'Standalone',
			release_date: '2024-01-01',
			belongs_to_collection: null
		});

		await mediaMatcherService.acceptMatch('uf-nocoll', 7002, 'movie');

		const [movie] = await testDb.db.select().from(movies).where(eq(movies.tmdbId, 7002));
		expect(movie.tmdbCollectionId).toBeNull();
		expect(movie.collectionName).toBeNull();
	});
});
