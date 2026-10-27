/**
 * Tests for DownloadMonitorService listUnmatchedDownloads,
 * resolveUnmatchedEntries, trackUnmatchedDownloads and
 * enrollUnmatchedDownloads.
 *
 * Unmatched = present in a client under a Cinephage-managed label with no
 * download_queue row. Listing never mutates; the wizard matches and the
 * monitor imports; track/enroll record the outcome. Repeat calls are safe.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, clearTestDb } from '../../../../test/db-helper';
import {
	downloadClients,
	downloadQueue,
	downloadHistory,
	movies,
	movieFiles,
	series,
	episodeFiles,
	episodes,
	libraries,
	rootFolders,
	importFailures
} from '#lib/server/db/schema.js';
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

const getDownloads = vi.fn();
/** Mutable so path-specific tests can point the client at a temp dir. */
const clientPaths = { local: '/downloads', remote: '/remote/downloads' };
/** Mutable so protocol-specific tests can swap the client's implementation
 *  (e.g. 'sabnzbd') without a torrent client being assumed by default. */
const clientImplementation = { value: undefined as string | undefined };
vi.mock('../DownloadClientManager', () => ({
	getDownloadClientManager: () => ({
		getEnabledClients: () =>
			Promise.resolve([
				{
					client: {
						id: CLIENT_ID,
						name: 'qbit',
						implementation: clientImplementation.value,
						movieCategory: 'movies',
						tvCategory: 'tv',
						downloadPathLocal: clientPaths.local,
						downloadPathRemote: clientPaths.remote
					},
					instance: { getDownloads }
				}
			])
	})
}));

const { getDownloadMonitor } = await import('./DownloadMonitorService');
const { addMovieToLibrary } = await import('#lib/server/library/add/add-movie.js');
const { addSeriesToLibrary } = await import('#lib/server/library/add/add-series.js');

vi.mock('#lib/server/library/add/add-movie.js', () => ({
	addMovieToLibrary: vi.fn()
}));

vi.mock('#lib/server/library/add/add-series.js', () => ({
	addSeriesToLibrary: vi.fn()
}));

// listUnmatchedDownloads now computes a TMDB suggestion per unattached page
// item - without this mock every existing test here would make a
// real network call. Defaults to "nothing found"; suggestion-specific tests
// override the return value.
const tmdbSearchMovies = vi.fn().mockResolvedValue({ results: [] });
const tmdbSearchTv = vi.fn().mockResolvedValue({ results: [] });
vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		searchMovies: (...args: unknown[]) => tmdbSearchMovies(...args),
		searchTv: (...args: unknown[]) => tmdbSearchTv(...args),
		getMovie: vi.fn(),
		getTVShow: vi.fn(),
		findByExternalId: vi.fn().mockResolvedValue({ movie_results: [], tv_results: [] })
	}
}));

const CLIENT_ID = randomUUID();
const MOVIE_ID = randomUUID();
const SERIES_ID = randomUUID();
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);

function makeDownload(overrides: Partial<DownloadInfo> = {}): DownloadInfo {
	return {
		hash: HASH_A,
		name: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
		status: 'seeding',
		progress: 1,
		size: 10_000_000_000,
		downloadSpeed: 0,
		uploadSpeed: 0,
		category: 'movies',
		savePath: '/remote/downloads/complete/movies',
		contentPath: '/remote/downloads/complete/movies/Test.Movie.2026.1080p.WEB-DL-GROUP.mkv',
		...overrides
	} as DownloadInfo;
}

async function seedClient() {
	await testDb.db.insert(downloadClients).values({
		id: CLIENT_ID,
		name: 'qbit',
		implementation: 'qbittorrent',
		enabled: true,
		host: 'localhost',
		port: 8080,
		useSsl: false,
		movieCategory: 'movies',
		tvCategory: 'tv'
	});
}

async function seedMovie() {
	await testDb.db.insert(movies).values({
		id: MOVIE_ID,
		tmdbId: 42,
		title: 'Test Movie',
		year: 2026,
		path: 'Test Movie (2026)'
	});
}

async function seedMovieFile() {
	await testDb.db.insert(movieFiles).values({
		id: randomUUID(),
		movieId: MOVIE_ID,
		relativePath: 'Test Movie (2026) [Remux-1080p].mkv',
		size: 10_000_000_000
	});
}

beforeEach(async () => {
	clearTestDb(testDb);
	// clearTestDb does not cover downloadHistory.
	testDb.db.delete(downloadHistory).run();
	getDownloads.mockReset();
	clientPaths.local = '/downloads';
	clientPaths.remote = '/remote/downloads';
	clientImplementation.value = undefined;
	tmdbSearchMovies.mockReset().mockResolvedValue({ results: [] });
	tmdbSearchTv.mockReset().mockResolvedValue({ results: [] });
	vi.mocked(addMovieToLibrary).mockReset();
	vi.mocked(addMovieToLibrary).mockImplementation(async (input) => {
		await testDb.db.insert(movies).values({
			id: MOVIE_ID,
			tmdbId: input.tmdbId,
			title: 'Auto Added',
			path: 'Auto Added'
		});
		return {
			outcome: 'added',
			movieId: MOVIE_ID,
			tmdbId: input.tmdbId,
			title: 'Auto Added',
			year: null,
			path: 'Auto Added',
			monitored: false,
			searchTriggered: false
		};
	});
	vi.mocked(addSeriesToLibrary).mockReset();
	vi.mocked(addSeriesToLibrary).mockImplementation(async (input) => {
		await testDb.db.insert(series).values({
			id: SERIES_ID,
			tmdbId: input.tmdbId,
			title: 'Auto Added Show',
			path: 'Auto Added Show'
		});
		return {
			outcome: 'added',
			seriesId: SERIES_ID,
			tmdbId: input.tmdbId,
			title: 'Auto Added Show',
			year: null,
			path: 'Auto Added Show',
			monitored: false,
			episodeCount: 0,
			searchTriggered: false
		};
	});
	await seedClient();
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('listUnmatchedDownloads', () => {
	it('lists client downloads in our categories with no queue row', async () => {
		getDownloads.mockResolvedValue([makeDownload()]);

		const result = await getDownloadMonitor().listUnmatchedDownloads();

		expect(result.total).toBe(1);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].hash).toBe(HASH_A);
		expect(result.items[0].clientId).toBe(CLIENT_ID);
	});

	it('includes manually-added torrents with no label', async () => {
		getDownloads.mockResolvedValue([makeDownload({ category: undefined })]);

		const result = await getDownloadMonitor().listUnmatchedDownloads();

		expect(result.total).toBe(1);
		expect(result.items[0].category).toBeUndefined();
	});

	it('still excludes foreign labels', async () => {
		getDownloads.mockResolvedValue([makeDownload({ category: 'linux-isos' })]);

		const result = await getDownloadMonitor().listUnmatchedDownloads();

		expect(result.total).toBe(0);
	});

	it('excludes tracked downloads', async () => {
		getDownloads.mockResolvedValue([
			makeDownload(),
			makeDownload({ hash: HASH_B, category: 'other' })
		]);
		await testDb.db.insert(downloadQueue).values({
			id: randomUUID(),
			downloadClientId: CLIENT_ID,
			downloadId: HASH_A,
			title: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
			protocol: 'torrent',
			status: 'downloading',
			addedAt: new Date().toISOString()
		});

		const result = await getDownloadMonitor().listUnmatchedDownloads();

		expect(result.total).toBe(0);
		expect(result.items).toHaveLength(0);
	});

	it('excludes an already-imported usenet download even after its queue row is gone', async () => {
		// Mirrors what removeCompletedDownloads does once SABnzbd reports the
		// job as removable: the download_queue row is cleaned up, but SAB's
		// own history retention can keep showing the job indefinitely - a
		// live queue row is not a reliable "already handled" signal for
		// usenet the way it is for a still-seeding torrent.
		getDownloads.mockResolvedValue([makeDownload({ status: 'completed' })]);
		await testDb.db.insert(downloadHistory).values({
			downloadClientId: CLIENT_ID,
			downloadClientName: 'SABnzbd',
			downloadId: HASH_A,
			infoHash: HASH_A,
			title: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
			protocol: 'usenet',
			status: 'imported',
			statusReason: 'Already in library - linked from the Unmatched tab, no files moved'
		});

		const result = await getDownloadMonitor().listUnmatchedDownloads();

		expect(result.total).toBe(0);
		expect(result.items).toHaveLength(0);
	});

	it('marks exact infohash hits as attachable, nothing else', async () => {
		getDownloads.mockResolvedValue([makeDownload()]);
		await seedMovie();
		await testDb.db.insert(movieFiles).values({
			id: randomUUID(),
			movieId: MOVIE_ID,
			relativePath: 'Test Movie (2026) [Remux-1080p].mkv',
			size: 10_000_000_000,
			infoHash: HASH_A.toUpperCase()
		});

		const result = await getDownloadMonitor().listUnmatchedDownloads();

		expect(result.total).toBe(1);
		expect(result.items[0].attachable).toMatchObject({
			mediaType: 'movie',
			tmdbId: 42,
			title: 'Test Movie'
		});
		// Suggestion is skipped (left null, not computed) for items that
		// already have a confirmed infohash attach - a probabilistic guess
		// next to a sure match would just be noise.
		expect(result.items[0].suggestion).toBeNull();
		expect('held' in result.items[0]).toBe(false);
	});

	it('skips unreachable clients instead of failing the listing', async () => {
		getDownloads.mockRejectedValue(new Error('client down'));

		const result = await getDownloadMonitor().listUnmatchedDownloads();

		expect(result.total).toBe(0);
		expect(result.items).toHaveLength(0);
	});

	it('paginates: total counts all, items honor page/limit', async () => {
		getDownloads.mockResolvedValue([
			makeDownload({ hash: HASH_A }),
			makeDownload({ hash: HASH_B, name: 'Other.Movie.2025.720p.WEB-DL-GROUP' })
		]);

		const page1 = await getDownloadMonitor().listUnmatchedDownloads({ page: 1, limit: 1 });
		expect(page1.total).toBe(2);
		expect(page1.items).toHaveLength(1);

		const page2 = await getDownloadMonitor().listUnmatchedDownloads({ page: 2, limit: 1 });
		expect(page2.items).toHaveLength(1);
		expect(page2.items[0].hash).not.toBe(page1.items[0].hash);
	});

	it('filters by date range, preferring completedOn over addedOn', async () => {
		getDownloads.mockResolvedValue([
			// Old item, outside the range.
			makeDownload({
				hash: HASH_A,
				addedOn: new Date('2020-01-01T00:00:00.000Z'),
				completedOn: new Date('2020-01-02T00:00:00.000Z')
			}),
			// Recent item, inside the range - only completedOn matters here,
			// addedOn alone (if it were read instead) would fall outside it.
			makeDownload({
				hash: HASH_B,
				name: 'Other.Movie.2025.720p.WEB-DL-GROUP',
				addedOn: new Date('2020-01-01T00:00:00.000Z'),
				completedOn: new Date('2026-06-15T00:00:00.000Z')
			}),
			// No date at all - never excluded on a guess.
			makeDownload({ hash: HASH_C, name: 'Undated.Movie.2024.1080p.WEB-DL-GROUP' })
		]);

		const result = await getDownloadMonitor().listUnmatchedDownloads({
			startDate: '2026-06-01',
			endDate: '2026-06-30'
		});

		expect(result.items.map((i) => i.hash).sort()).toEqual([HASH_B, HASH_C].sort());
	});

	it('excludes single files and folders Cinephage cannot import', async () => {
		const root = await mkdtemp(join(tmpdir(), 'unmatched-list-'));
		// Video nested one folder deep: proves the walk recurses.
		const goodFolder = join(root, 'Movie.2026.1080p');
		await mkdir(join(goodFolder, 'Extras'), { recursive: true });
		await writeFile(join(goodFolder, 'Extras', 'feature.mkv'), 'x');
		const junkFolder = join(root, 'Junk.Release');
		await mkdir(junkFolder, { recursive: true });
		await writeFile(join(junkFolder, 'readme.txt'), 'x');
		const exe = join(root, 'not-a-video.exe');
		await writeFile(exe, 'x');
		clientPaths.local = root;
		clientPaths.remote = root;
		getDownloads.mockResolvedValue([
			makeDownload({ hash: HASH_A, name: 'Bad.Release', contentPath: exe }),
			makeDownload({ hash: HASH_B, name: 'Movie.2026.1080p', contentPath: goodFolder }),
			makeDownload({ hash: HASH_C, name: 'Junk.Release', contentPath: junkFolder })
		]);

		const res = await getDownloadMonitor().listUnmatchedDownloads();

		expect(res.items.map((item) => item.hash)).toEqual([HASH_B]);
		expect(res.total).toBe(1);
		await rm(root, { recursive: true, force: true });
	});

	it('accepts .strm placeholder files (WebDAV/debrid mounts, e.g. NZBDav)', async () => {
		const root = await mkdtemp(join(tmpdir(), 'unmatched-strm-'));
		const strmFolder = join(root, 'Movie.2026.REMUX');
		await mkdir(strmFolder, { recursive: true });
		await writeFile(join(strmFolder, 'Movie.2026.REMUX.mkv.strm'), 'x');
		clientPaths.local = root;
		clientPaths.remote = root;
		getDownloads.mockResolvedValue([
			makeDownload({ hash: HASH_A, name: 'Movie.2026.REMUX', contentPath: strmFolder })
		]);

		const res = await getDownloadMonitor().listUnmatchedDownloads();

		expect(res.items.map((item) => item.hash)).toEqual([HASH_A]);
		await rm(root, { recursive: true, force: true });
	});

	it('attaches a TMDB suggestion for a well-formed release name', async () => {
		getDownloads.mockResolvedValue([makeDownload()]);
		tmdbSearchMovies.mockResolvedValue({
			results: [
				{ id: 42, title: 'Test Movie', release_date: '2026-01-01', original_title: 'Test Movie' }
			]
		});

		const result = await getDownloadMonitor().listUnmatchedDownloads();

		expect(result.items[0].suggestion).toMatchObject({
			mediaType: 'movie',
			tmdbId: 42,
			title: 'Test Movie',
			year: 2026
		});
		expect(result.items[0].suggestion?.confidence).toBeGreaterThan(0);
	});

	it('hits TMDB once for two items sharing a parsed title on one page', async () => {
		getDownloads.mockResolvedValue([
			makeDownload({ hash: HASH_A, name: 'Test.Movie.2026.1080p.WEB-DL-GROUP' }),
			makeDownload({ hash: HASH_B, name: 'Test.Movie.2026.2160p.BluRay-OTHERGROUP' })
		]);
		tmdbSearchMovies.mockResolvedValue({
			results: [{ id: 42, title: 'Test Movie', release_date: '2026-01-01' }]
		});

		const result = await getDownloadMonitor().listUnmatchedDownloads();

		expect(result.items).toHaveLength(2);
		expect(result.items.every((item) => item.suggestion?.tmdbId === 42)).toBe(true);
		expect(tmdbSearchMovies).toHaveBeenCalledTimes(1);
	});

	it('yields suggestion: null for an unparseable name without throwing', async () => {
		getDownloads.mockResolvedValue([makeDownload({ name: '....' })]);

		const result = await getDownloadMonitor().listUnmatchedDownloads();

		expect(result.items).toHaveLength(1);
		expect(result.items[0].suggestion).toBeNull();
		expect(tmdbSearchMovies).not.toHaveBeenCalled();
	});

	it('search filters before total/pagination, not just the current page (issue #628)', async () => {
		const downloads = Array.from({ length: 30 }, (_, i) =>
			makeDownload({
				hash: `${i}`.padStart(40, '0'),
				name:
					i === 27
						? 'Needle.In.A.Haystack.2026.1080p.WEB-DL-GROUP'
						: `Filler.${i}.2026.1080p.WEB-DL-GROUP`
			})
		);
		getDownloads.mockResolvedValue(downloads);

		// Unfiltered: 30 items, "Needle" sits on page 2 (limit 25).
		const unfiltered = await getDownloadMonitor().listUnmatchedDownloads({ limit: 25 });
		expect(unfiltered.total).toBe(30);

		// Searching for it must find it and report a correct, filtered total -
		// not silently miss it because it wasn't on the already-loaded page 1.
		const filtered = await getDownloadMonitor().listUnmatchedDownloads({
			limit: 25,
			search: 'needle'
		});
		expect(filtered.total).toBe(1);
		expect(filtered.items).toHaveLength(1);
		expect(filtered.items[0].name).toBe('Needle.In.A.Haystack.2026.1080p.WEB-DL-GROUP');
	});
});
describe('resolveUnmatchedEntries', () => {
	it('maps untracked torrents to local paths and reports missing hashes', async () => {
		getDownloads.mockResolvedValue([makeDownload()]);

		const result = await getDownloadMonitor().resolveUnmatchedEntries([
			{ clientId: CLIENT_ID, hash: HASH_A },
			{ clientId: CLIENT_ID, hash: HASH_B }
		]);

		expect(result.resolved).toHaveLength(1);
		expect(result.resolved[0]).toMatchObject({
			clientId: CLIENT_ID,
			hash: HASH_A,
			name: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
			searchHint: 'Test Movie'
		});
		expect(result.resolved[0].localPath).toBe(
			'/downloads/complete/movies/Test.Movie.2026.1080p.WEB-DL-GROUP.mkv'
		);
		expect(result.missing).toHaveLength(1);
		expect(result.missing[0]).toMatchObject({ hash: HASH_B.toLowerCase() });
		expect(result.alreadyTracked).toHaveLength(0);
	});

	it('reports tracked torrents as alreadyTracked instead of resolving', async () => {
		getDownloads.mockResolvedValue([makeDownload()]);
		await testDb.db.insert(downloadQueue).values({
			id: randomUUID(),
			downloadClientId: CLIENT_ID,
			downloadId: HASH_A,
			title: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
			protocol: 'torrent',
			status: 'paused',
			addedAt: new Date().toISOString()
		});

		const result = await getDownloadMonitor().resolveUnmatchedEntries([
			{ clientId: CLIENT_ID, hash: HASH_A }
		]);

		expect(result.resolved).toHaveLength(0);
		expect(result.alreadyTracked).toEqual([{ clientId: CLIENT_ID, hash: HASH_A.toLowerCase() }]);
		expect(result.missing).toHaveLength(0);
	});
});

describe('trackUnmatchedDownloads', () => {
	it('tracks a movie torrent as seeding-imported with a history marker', async () => {
		getDownloads.mockResolvedValue([makeDownload()]);
		await seedMovie();
		await seedMovieFile();

		const result = await getDownloadMonitor().trackUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 }
		]);

		expect(result.tracked).toHaveLength(1);
		expect(result.skipped).toHaveLength(0);

		const [row] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.downloadId, HASH_A));
		expect(row.status).toBe('seeding-imported');
		expect(row.movieId).toBe(MOVIE_ID);
		expect(row.importedAt).not.toBeNull();
		// Stamped so an unmatch later knows this row came from the
		// Unmatched tab, not a real grab (see AcquisitionService.releaseUnmatchedQueueItems).
		expect(row.origin).toBe('unmatched_track');

		const history = await testDb.db
			.select()
			.from(downloadHistory)
			.where(eq(downloadHistory.downloadId, HASH_A));
		expect(history).toHaveLength(1);
		expect(history[0].movieId).toBe(MOVIE_ID);
		// Quality/group should parse the same as a normal import, and the
		// Source column should read "Torrent" rather than sit blank - there
		// is no indexer behind an Unmatched-tab link to show instead.
		expect(history[0].quality).toMatchObject({ resolution: '1080p', source: 'webdl' });
		expect(history[0].releaseGroup).toBe('DL-GROUP');
		expect(history[0].indexerName).toBe('Torrent');
		expect(history[0].statusReason).not.toMatch(/import wizard/i);
	});

	it('records a wizard import with its real transfer mode/path, no status-reason line', async () => {
		// trackUnmatchedGroup (the import wizard) calls this same endpoint
		// right after its own transfer completes, purely to link the
		// download client's job. With the wizard's transfer details in
		// hand, the history row should look like any other successful
		// import ("Import Method" / "Imported to"), not a status-reason
		// sentence - that's reserved for the Unmatched tab's own Attach,
		// where nothing is ever transferred.
		getDownloads.mockResolvedValue([makeDownload()]);
		await seedMovie();
		await seedMovieFile();

		await getDownloadMonitor().trackUnmatchedDownloads([
			{
				hash: HASH_A,
				mediaType: 'movie',
				tmdbId: 42,
				viaWizardImport: true,
				transferMode: 'hardlink',
				importedPath: '/movies/Test Movie (2026)/Test Movie (2026).mkv'
			}
		]);

		const [history] = await testDb.db
			.select()
			.from(downloadHistory)
			.where(eq(downloadHistory.downloadId, HASH_A));
		expect(history.statusReason).toBeNull();
		expect(history.transferMode).toBe('hardlink');
		expect(history.importedPath).toBe('/movies/Test Movie (2026)/Test Movie (2026).mkv');
	});

	it('falls back to a status-reason line for a wizard import with no transfer details', async () => {
		getDownloads.mockResolvedValue([makeDownload({ hash: HASH_B })]);
		await seedMovie();
		await seedMovieFile();

		await getDownloadMonitor().trackUnmatchedDownloads([
			{ hash: HASH_B, mediaType: 'movie', tmdbId: 42, viaWizardImport: true }
		]);

		const [history] = await testDb.db
			.select()
			.from(downloadHistory)
			.where(eq(downloadHistory.downloadId, HASH_B));
		expect(history.statusReason).toMatch(/import wizard/i);
		expect(history.statusReason).not.toMatch(/no file transfer/i);
	});

	it('tracks a usenet movie as imported (no seeding state), not torrent-labeled', async () => {
		clientImplementation.value = 'sabnzbd';
		getDownloads.mockResolvedValue([makeDownload({ status: 'completed' })]);
		await seedMovie();
		await seedMovieFile();

		const result = await getDownloadMonitor().trackUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 }
		]);

		expect(result.tracked).toHaveLength(1);

		const [row] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.downloadId, HASH_A));
		// Usenet never "seeds" - a status of seeding-imported here would be
		// torrent terminology leaking onto a usenet download.
		expect(row.status).toBe('imported');

		const history = await testDb.db
			.select()
			.from(downloadHistory)
			.where(eq(downloadHistory.downloadId, HASH_A));
		expect(history[0].protocol).toBe('usenet');
		expect(history[0].indexerName).toBe('NZB');
	});

	it('tracks a series torrent with its season number', async () => {
		getDownloads.mockResolvedValue([
			makeDownload({
				name: 'Test.Show.S01E01.1080p.WEB-DL-GROUP',
				category: 'tv',
				contentPath: '/remote/downloads/complete/tv/Test.Show.S01E01.1080p.WEB-DL-GROUP.mkv'
			})
		]);
		const seriesId = randomUUID();
		await testDb.db.insert(series).values({
			id: seriesId,
			tmdbId: 1399,
			title: 'Test Show',
			year: 2008,
			path: 'Test Show (2008)'
		});
		await testDb.db.insert(episodeFiles).values({
			id: randomUUID(),
			seriesId,
			seasonNumber: 1,
			relativePath: 'Season 01/Test Show S01E01.mkv',
			size: 5_000_000_000
		});

		const result = await getDownloadMonitor().trackUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'tv', tmdbId: 1399 }
		]);

		expect(result.tracked).toHaveLength(1);
		const [row] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.downloadId, HASH_A));
		expect(row.seriesId).toBe(seriesId);
		expect(row.seasonNumber).toBe(1);
		expect(row.movieId).toBeNull();
	});

	it('tracks a specific episode when the season has files for some but not all episodes', async () => {
		getDownloads.mockResolvedValue([
			makeDownload({
				name: 'Test.Show.S01E02.1080p.WEB-DL-GROUP',
				category: 'tv',
				contentPath: '/remote/downloads/complete/tv/Test.Show.S01E02.1080p.WEB-DL-GROUP.mkv'
			})
		]);
		const seriesId = randomUUID();
		await testDb.db.insert(series).values({
			id: seriesId,
			tmdbId: 1399,
			title: 'Test Show',
			year: 2008,
			path: 'Test Show (2008)'
		});
		// Season has files for episodes 1 and 3, but not 2.
		await testDb.db.insert(episodes).values([
			{ id: randomUUID(), seriesId, seasonNumber: 1, episodeNumber: 1, hasFile: true },
			{ id: randomUUID(), seriesId, seasonNumber: 1, episodeNumber: 2, hasFile: false },
			{ id: randomUUID(), seriesId, seasonNumber: 1, episodeNumber: 3, hasFile: true }
		]);
		await testDb.db.insert(episodeFiles).values([
			{
				id: randomUUID(),
				seriesId,
				seasonNumber: 1,
				relativePath: 'Season 01/Test Show S01E01.mkv',
				size: 5_000_000_000
			},
			{
				id: randomUUID(),
				seriesId,
				seasonNumber: 1,
				relativePath: 'Season 01/Test Show S01E03.mkv',
				size: 5_000_000_000
			}
		]);

		// Requesting episode 2 (no file) must be rejected even though the
		// season as a whole clearly has files.
		const missing = await getDownloadMonitor().trackUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'tv', tmdbId: 1399, seasonNumber: 1, episodeNumber: 2 }
		]);
		expect(missing.tracked).toHaveLength(0);
		expect(missing.skipped).toEqual([{ hash: HASH_A, reason: 'no_library_file' }]);

		// Requesting episode 1 (has a file) must succeed.
		const present = await getDownloadMonitor().trackUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'tv', tmdbId: 1399, seasonNumber: 1, episodeNumber: 1 }
		]);
		expect(present.tracked).toHaveLength(1);
		const [row] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.downloadId, HASH_A));
		expect(row.seasonNumber).toBe(1);
	});

	it('is idempotent and validates pairs', async () => {
		getDownloads.mockResolvedValue([makeDownload()]);
		await seedMovie();
		await seedMovieFile();
		await getDownloadMonitor().trackUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 }
		]);

		const result = await getDownloadMonitor().trackUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 },
			{ hash: HASH_B, mediaType: 'movie', tmdbId: 42 },
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 999999 },
			{ hash: '', mediaType: 'movie', tmdbId: 42 }
		]);

		expect(result.tracked).toHaveLength(0);
		expect(result.skipped.map((s) => s.reason).sort()).toEqual(
			['already_tracked', 'invalid_pair', 'not_in_client', 'not_in_library'].sort()
		);
	});

	it('rejects pairs for library items with no file on disk', async () => {
		getDownloads.mockResolvedValue([makeDownload()]);
		await seedMovie();

		const result = await getDownloadMonitor().trackUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 }
		]);

		expect(result.tracked).toHaveLength(0);
		expect(result.skipped).toEqual([{ hash: HASH_A, reason: 'no_library_file' }]);
		expect(await testDb.db.select().from(downloadQueue)).toHaveLength(0);
		expect(await testDb.db.select().from(downloadHistory)).toHaveLength(0);
	});

	it('rejects partial torrents even when the library file exists', async () => {
		getDownloads.mockResolvedValue([makeDownload({ status: 'downloading', progress: 0.4 })]);
		await seedMovie();
		await seedMovieFile();

		const result = await getDownloadMonitor().trackUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 }
		]);

		expect(result.tracked).toHaveLength(0);
		expect(result.skipped).toEqual([{ hash: HASH_A, reason: 'incomplete' }]);
		expect(await testDb.db.select().from(downloadQueue)).toHaveLength(0);
	});

	it('refuses content Cinephage cannot import, on both link and enroll', async () => {
		const root = await mkdtemp(join(tmpdir(), 'unmatched-bad-'));
		const exe = join(root, 'setup.exe');
		await writeFile(exe, 'x');
		clientPaths.local = root;
		clientPaths.remote = root;
		getDownloads.mockResolvedValue([makeDownload({ contentPath: exe })]);
		await seedMovie();
		await seedMovieFile();

		const tracked = await getDownloadMonitor().trackUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 }
		]);
		expect(tracked.skipped).toEqual([{ hash: HASH_A, reason: 'unsupported_filetype' }]);

		const enrolled = await getDownloadMonitor().enrollUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 42, rootFolderId: 'rf-1' }
		]);
		expect(enrolled.skipped).toEqual([{ hash: HASH_A, reason: 'unsupported_filetype' }]);

		expect(await testDb.db.select().from(downloadQueue)).toHaveLength(0);
		expect(await testDb.db.select().from(downloadHistory)).toHaveLength(0);
		await rm(root, { recursive: true, force: true });
	});
});

describe('enrollUnmatchedDownloads', () => {
	it('enrolls a mid-download torrent at mirrored status with no history marker', async () => {
		getDownloads.mockResolvedValue([makeDownload({ status: 'downloading', progress: 0.4 })]);
		await seedMovie();

		const result = await getDownloadMonitor().enrollUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 }
		]);

		expect(result.enrolled).toHaveLength(1);
		expect(result.skipped).toHaveLength(0);

		const [row] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.downloadId, HASH_A));
		expect(row.status).toBe('downloading');
		expect(row.movieId).toBe(MOVIE_ID);
		expect(row.importedAt).toBeNull();
		expect(row.origin).toBe('unmatched_enroll');

		const history = await testDb.db
			.select()
			.from(downloadHistory)
			.where(eq(downloadHistory.downloadId, HASH_A));
		expect(history).toHaveLength(0);
	});

	it('maps client errors to failed rows and skips tracked hashes', async () => {
		getDownloads.mockResolvedValue([
			makeDownload({ status: 'error', errorMessage: 'missing files' })
		]);
		await seedMovie();

		const failed = await getDownloadMonitor().enrollUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 }
		]);
		expect(failed.enrolled).toHaveLength(1);
		const [row] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.downloadId, HASH_A));
		expect(row.status).toBe('failed');
		expect(row.errorMessage).toBe('missing files');

		const again = await getDownloadMonitor().enrollUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 }
		]);
		expect(again.enrolled).toHaveLength(0);
		expect(again.skipped).toEqual([{ hash: HASH_A, reason: 'already_tracked' }]);
	});

	it('auto-adds matches new to the library unmonitored, without search', async () => {
		getDownloads.mockResolvedValue([makeDownload()]);

		const result = await getDownloadMonitor().enrollUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 777, rootFolderId: 'rf-1' }
		]);

		expect(result.enrolled).toHaveLength(1);
		expect(result.skipped).toHaveLength(0);
		expect(vi.mocked(addMovieToLibrary)).toHaveBeenCalledWith({
			tmdbId: 777,
			rootFolderId: 'rf-1',
			monitored: false,
			minimumAvailability: 'released',
			availabilityDelay: 0,
			searchOnAdd: false,
			wantsSubtitles: true
		});

		const [row] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.downloadId, HASH_A));
		expect(row.movieId).toBe(MOVIE_ID);
		expect(row.status).toBe('seeding');
	});

	it('auto-adds a new TV match unmonitored, without search', async () => {
		getDownloads.mockResolvedValue([
			makeDownload({ name: 'Test.Show.S01E01.1080p.WEB-DL-GROUP', category: 'tv' })
		]);

		const result = await getDownloadMonitor().enrollUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'tv', tmdbId: 999, rootFolderId: 'rf-1', seasonNumber: 1 }
		]);

		expect(result.enrolled).toHaveLength(1);
		expect(result.skipped).toHaveLength(0);
		expect(vi.mocked(addSeriesToLibrary)).toHaveBeenCalledWith({
			tmdbId: 999,
			rootFolderId: 'rf-1',
			monitored: false,
			seasonFolder: true,
			seriesType: 'standard',
			monitorType: 'none',
			monitorNewItems: 'all',
			monitorSpecials: false,
			searchOnAdd: false,
			wantsSubtitles: true
		});

		const [row] = await testDb.db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.downloadId, HASH_A));
		expect(row.seriesId).toBe(SERIES_ID);
		expect(row.seasonNumber).toBe(1);
		expect(row.status).toBe('seeding');
	});

	it('never adds to the library when the torrent cannot be enrolled', async () => {
		// Torrent gone from the client.
		getDownloads.mockResolvedValue([]);
		const gone = await getDownloadMonitor().enrollUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 777, rootFolderId: 'rf-1' }
		]);
		expect(gone.skipped).toEqual([{ hash: HASH_A, reason: 'not_in_client' }]);
		expect(vi.mocked(addMovieToLibrary)).not.toHaveBeenCalled();
		expect(await testDb.db.select().from(movies)).toHaveLength(0);

		// Torrent in a foreign category.
		getDownloads.mockResolvedValue([makeDownload({ category: 'other' })]);
		const foreign = await getDownloadMonitor().enrollUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 777, rootFolderId: 'rf-1' }
		]);
		expect(foreign.skipped).toEqual([{ hash: HASH_A, reason: 'foreign_category' }]);
		expect(vi.mocked(addMovieToLibrary)).not.toHaveBeenCalled();
		expect(await testDb.db.select().from(movies)).toHaveLength(0);
	});

	it('skips new matches without a resolvable destination, and failed adds', async () => {
		getDownloads.mockResolvedValue([makeDownload()]);

		// No rootFolderId given and no library has a default root folder for
		// 'movie' configured (none seeded in this test) -
		// resolveDefaultRootFolderId falls through to null.
		const noDest = await getDownloadMonitor().enrollUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 777 }
		]);
		expect(noDest.enrolled).toHaveLength(0);
		expect(noDest.skipped).toEqual([{ hash: HASH_A, reason: 'no_default_root_folder' }]);
		expect(vi.mocked(addMovieToLibrary)).not.toHaveBeenCalled();

		vi.mocked(addMovieToLibrary).mockRejectedValueOnce(new Error('TMDB down'));
		const failedAdd = await getDownloadMonitor().enrollUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 777, rootFolderId: 'rf-1' }
		]);
		expect(failedAdd.enrolled).toHaveLength(0);
		expect(failedAdd.skipped).toEqual([{ hash: HASH_A, reason: 'add_failed' }]);
		expect(await testDb.db.select().from(downloadQueue)).toHaveLength(0);

		// Both genuine skips (not just a toast) should be visible on Reports.
		const failures = await testDb.db
			.select({ failureStage: importFailures.failureStage, reason: importFailures.reason })
			.from(importFailures);
		expect(failures).toEqual(
			expect.arrayContaining([
				{ failureStage: 'unmatched_accept', reason: 'no_default_root_folder' },
				{ failureStage: 'unmatched_accept', reason: 'add_failed' }
			])
		);
	});

	it('prefers the library flagged isDefault over whichever candidate lists first', async () => {
		getDownloads.mockResolvedValue([makeDownload()]);
		await testDb.db.insert(rootFolders).values([
			{ id: 'rf-first', name: 'First', path: '/first', mediaType: 'movie' },
			{ id: 'rf-default', name: 'Default', path: '/default', mediaType: 'movie' }
		]);
		// listLibraries() orders by sortOrder then name - "AAA" sorts ahead
		// of "ZZZ" regardless of isDefault, so a name/order-based pick alone
		// would wrongly choose the non-default one here. isDefault must win.
		await testDb.db.insert(libraries).values([
			{
				id: 'lib-first',
				name: 'AAA First Movies',
				slug: 'first-movies',
				mediaType: 'movie',
				mediaSubType: 'standard',
				isDefault: false,
				defaultRootFolderId: 'rf-first'
			},
			{
				id: 'lib-default',
				name: 'ZZZ Default Movies',
				slug: 'default-movies',
				mediaType: 'movie',
				mediaSubType: 'standard',
				isDefault: true,
				defaultRootFolderId: 'rf-default'
			}
		]);

		const result = await getDownloadMonitor().enrollUnmatchedDownloads([
			{ hash: HASH_A, mediaType: 'movie', tmdbId: 777 }
		]);

		expect(result.skipped).toHaveLength(0);
		expect(vi.mocked(addMovieToLibrary)).toHaveBeenCalledWith(
			expect.objectContaining({ rootFolderId: 'rf-default' })
		);
	});
});
