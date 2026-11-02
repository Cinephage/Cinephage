import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper';
import { callHandler } from '../../../../test/api-helper';
import { randomUUID } from 'node:crypto';
import {
	downloadQueue,
	downloadHistory,
	downloadClients,
	movies,
	movieFiles
} from '#lib/server/db/schema.js';
import type { DownloadInfo } from '#lib/server/downloadClients/core/interfaces.js';

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

const CLIENT_ID = randomUUID();

const getDownloads = vi.fn();
vi.mock('#lib/server/downloadClients/DownloadClientManager.js', () => ({
	getDownloadClientManager: () => ({
		getEnabledClients: () =>
			Promise.resolve([
				{
					client: {
						id: CLIENT_ID,
						name: 'qbit',
						movieCategory: 'movies',
						tvCategory: 'tv',
						downloadPathLocal: '/downloads',
						downloadPathRemote: '/remote/downloads'
					},
					instance: { getDownloads }
				}
			])
	})
}));

const searchMovies = vi.fn();
vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: { searchMovies }
}));

const { GET } = await import('./+server');
const { GET: RESOLVE_GET } = await import('./resolve/+server');
const { POST: TRACK_POST } = await import('./track/+server');
const { POST: ENROLL_POST } = await import('./enroll/+server');

const HASH_A = 'a'.repeat(40);
const MOVIE_ID = randomUUID();

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

function adminOpts(url: string, params: Record<string, string> = {}) {
	return { url, params, auth: 'admin' as const };
}

beforeEach(async () => {
	clearTestDb(testDb);
	testDb.db.delete(downloadHistory).run();
	getDownloads.mockReset();
	searchMovies.mockReset();
	getDownloads.mockResolvedValue([makeDownload()]);
	searchMovies.mockResolvedValue({ results: [] });
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
	await testDb.db.insert(movies).values({
		id: MOVIE_ID,
		tmdbId: 42,
		title: 'Test Movie',
		year: 2026,
		path: 'Test Movie (2026)'
	});
	await testDb.db.insert(movieFiles).values({
		id: randomUUID(),
		movieId: MOVIE_ID,
		relativePath: 'Test Movie (2026) [Remux-1080p].mkv',
		size: 10_000_000_000
	});
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('GET /api/queue/unmatched', () => {
	it('requires admin', async () => {
		const { status, data } = await callHandler(GET, 'GET', undefined, {
			url: 'http://localhost/api/queue/unmatched'
		});
		expect(status).toBeGreaterThanOrEqual(400);
		expect((data as { success: boolean }).success).toBe(false);
	});

	it('lists unmatched downloads with paging metadata', async () => {
		const { status, data } = await callHandler(
			GET,
			'GET',
			undefined,
			adminOpts('http://localhost/api/queue/unmatched')
		);
		expect(status).toBe(200);
		const body = data as {
			success: boolean;
			items: { hash: string }[];
			total: number;
			page: number;
			limit: number;
		};
		expect(body.success).toBe(true);
		expect(body.total).toBe(1);
		expect(body.items).toHaveLength(1);
		expect(body.items[0].hash).toBe(HASH_A);
		expect(body.page).toBe(1);
	});

	it('resolves mediaType from the client category mapping', async () => {
		const { data } = await callHandler(
			GET,
			'GET',
			undefined,
			adminOpts('http://localhost/api/queue/unmatched')
		);
		const body = data as { items: { mediaType: 'movie' | 'tv' | null }[] };
		expect(body.items[0].mediaType).toBe('movie');
	});

	it('filters by mediaType', async () => {
		const movieResult = await callHandler(
			GET,
			'GET',
			undefined,
			adminOpts('http://localhost/api/queue/unmatched?mediaType=movie')
		);
		expect((movieResult.data as { total: number }).total).toBe(1);

		const tvResult = await callHandler(
			GET,
			'GET',
			undefined,
			adminOpts('http://localhost/api/queue/unmatched?mediaType=tv')
		);
		expect((tvResult.data as { total: number }).total).toBe(0);
	});
});
describe('GET /api/queue/unmatched/resolve', () => {
	it('requires admin', async () => {
		const { status } = await callHandler(RESOLVE_GET, 'GET', undefined, {
			url: `http://localhost/api/queue/unmatched/resolve?entries=${CLIENT_ID}:${HASH_A}`
		});
		expect(status).toBeGreaterThanOrEqual(400);
	});

	it('rejects empty entries', async () => {
		const { status, data } = await callHandler(
			RESOLVE_GET,
			'GET',
			undefined,
			adminOpts('http://localhost/api/queue/unmatched/resolve')
		);
		expect(status).toBe(400);
		expect((data as { success: boolean }).success).toBe(false);
	});

	it('resolves local paths and reports missing hashes', async () => {
		const hashB = 'b'.repeat(40);
		const { status, data } = await callHandler(
			RESOLVE_GET,
			'GET',
			undefined,
			adminOpts(
				`http://localhost/api/queue/unmatched/resolve?entries=${CLIENT_ID}:${HASH_A},${CLIENT_ID}:${hashB}`
			)
		);
		expect(status).toBe(200);
		const body = data as {
			success: boolean;
			resolved: {
				hash: string;
				localPath: string | null;
				progress: number;
				insideManagedRoot: boolean;
			}[];
			missing: { hash: string }[];
		};
		expect(body.success).toBe(true);
		expect(body.resolved).toHaveLength(1);
		expect(body.resolved[0].localPath).toBe(
			'/downloads/complete/movies/Test.Movie.2026.1080p.WEB-DL-GROUP.mkv'
		);
		expect(body.resolved[0].progress).toBe(1);
		expect(body.resolved[0].insideManagedRoot).toBe(false);
		expect(body.missing).toHaveLength(1);
	});
});

describe('POST /api/queue/unmatched/track', () => {
	it('requires admin', async () => {
		const { status } = await callHandler(
			TRACK_POST,
			'POST',
			{ pairs: [{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 }] },
			{ url: 'http://localhost/api/queue/unmatched/track' }
		);
		expect(status).toBeGreaterThanOrEqual(400);
	});

	it('rejects invalid bodies', async () => {
		const { status, data } = await callHandler(
			TRACK_POST,
			'POST',
			{ pairs: [] },
			adminOpts('http://localhost/api/queue/unmatched/track')
		);
		expect(status).toBe(400);
		expect((data as { success: boolean }).success).toBe(false);
	});

	it('tracks a torrent as seeding-imported', async () => {
		const { status, data } = await callHandler(
			TRACK_POST,
			'POST',
			{ pairs: [{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 }] },
			adminOpts('http://localhost/api/queue/unmatched/track')
		);
		expect(status).toBe(200);
		const body = data as { success: boolean; tracked: number };
		expect(body.success).toBe(true);
		expect(body.tracked).toBe(1);

		const rows = await testDb.db.select().from(downloadQueue);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('seeding-imported');
		expect(rows[0].movieId).toBe(MOVIE_ID);
	});

	it('skips tracking when the library holds no file', async () => {
		testDb.db.delete(movieFiles).run();
		const { status, data } = await callHandler(
			TRACK_POST,
			'POST',
			{ pairs: [{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 }] },
			adminOpts('http://localhost/api/queue/unmatched/track')
		);
		expect(status).toBe(200);
		const body = data as {
			success: boolean;
			tracked: number;
			skipped: { hash: string; reason: string }[];
		};
		expect(body.success).toBe(true);
		expect(body.tracked).toBe(0);
		expect(body.skipped).toEqual([{ hash: HASH_A, reason: 'no_library_file' }]);
		expect(await testDb.db.select().from(downloadQueue)).toHaveLength(0);
	});
});

describe('POST /api/queue/unmatched/enroll', () => {
	it('requires admin', async () => {
		const { status } = await callHandler(
			ENROLL_POST,
			'POST',
			{ pairs: [{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 }] },
			{ url: 'http://localhost/api/queue/unmatched/enroll' }
		);
		expect(status).toBeGreaterThanOrEqual(400);
	});

	it('rejects invalid bodies', async () => {
		const { status, data } = await callHandler(
			ENROLL_POST,
			'POST',
			{ pairs: [] },
			adminOpts('http://localhost/api/queue/unmatched/enroll')
		);
		expect(status).toBe(400);
		expect((data as { success: boolean }).success).toBe(false);
	});

	it('enrolls a torrent at mirrored status', async () => {
		getDownloads.mockResolvedValue([makeDownload({ status: 'downloading', progress: 0.4 })]);
		const { status, data } = await callHandler(
			ENROLL_POST,
			'POST',
			{ pairs: [{ hash: HASH_A, mediaType: 'movie', tmdbId: 42 }] },
			adminOpts('http://localhost/api/queue/unmatched/enroll')
		);
		expect(status).toBe(200);
		const body = data as { success: boolean; enrolled: number };
		expect(body.success).toBe(true);
		expect(body.enrolled).toBe(1);

		const rows = await testDb.db.select().from(downloadQueue);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('downloading');
		expect(rows[0].importedAt).toBeNull();
	});
});
