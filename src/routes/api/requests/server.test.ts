/**
 * Endpoint-level security tests for the request API: viewers are hard-scoped
 * to their own rows, admin mutations are admin-only, unauthenticated calls
 * 401. The DB is real; TMDB/add-orchestrator boundaries are mocked like the
 * service tests.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper';
import {
	requests,
	userRequestSettings,
	settings,
	user,
	rootFolders,
	libraries,
	movies,
	series,
	episodes
} from '#lib/server/db/schema.js';
import { createTestUser } from '../../../test/fixtures/auth.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis(),
	fatal: vi.fn(),
	trace: vi.fn()
}));
vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger),
	createRequestLogger: vi.fn(() => mockLogger),
	runWithLogContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn())
}));

vi.mock('#lib/server/library/LibraryAddService.js', () => ({
	fetchMovieDetails: vi.fn(async () => ({
		title: 'Endpoint Movie',
		poster_path: null,
		release_date: '2023-05-05',
		original_language: 'en',
		original_title: 'Endpoint Movie',
		genres: [],
		overview: ''
	})),
	fetchSeriesDetails: vi.fn(async () => ({
		name: 'Endpoint Show',
		poster_path: null,
		first_air_date: '2020-01-01',
		original_language: 'en',
		original_name: 'Endpoint Show',
		genres: [],
		seasons: [{ season_number: 1, episode_count: 2 }]
	})),
	fetchMovieExternalIds: vi.fn(async () => ({ imdbId: 'tt1' })),
	fetchSeriesExternalIds: vi.fn(async () => ({ imdbId: 'tt2', tvdbId: 9 })),
	validateRootFolder: vi.fn(async () => undefined),
	getAnimeSubtypeEnforcement: vi.fn(async () => false),
	getEffectiveScoringProfileId: vi.fn(async () => null),
	triggerMovieSearch: vi.fn(async () => ({ triggered: true })),
	triggerSeriesSearch: vi.fn(async () => ({ triggered: true }))
}));

const addMovieToLibrary = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/library/add/add-movie.js', () => ({ addMovieToLibrary }));
vi.mock('#lib/server/library/add/add-series.js', () => ({ addSeriesToLibrary: vi.fn() }));
vi.mock('#lib/server/blocked-media/service.js', () => ({
	blockedMediaService: { isBlocked: vi.fn(async () => false) }
}));

const { GET, POST } = await import('./+server.js');
const { GET: GET_COUNT } = await import('./count/+server.js');
const { GET: GET_MEDIA_STATUS } = await import('./media-status/+server.js');
const { DELETE } = await import('./[id]/+server.js');
const { POST: POST_APPROVE } = await import('./[id]/approve/+server.js');
const { POST: POST_DECLINE } = await import('./[id]/decline/+server.js');
const { POST: POST_FULFILL } = await import('./[id]/fulfill/+server.js');
const { POST: POST_BULK } = await import('./bulk/+server.js');
const { getRequestSettingsService } =
	await import('#lib/server/requests/RequestSettingsService.js');

// api-helper synthesizes these exact ids for auth:'user' / auth:'admin'.
const VIEWER_ID = 'test-user-user';
const ADMIN_ID = 'test-admin-user';

afterAll(() => destroyTestDb(testDb));

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(requests).run();
	testDb.db.delete(userRequestSettings).run();
	testDb.db.delete(settings).run();
	testDb.db.delete(user).run();
	testDb.db.delete(libraries).run();
	testDb.db.delete(movies).run();
	testDb.db.delete(series).run();
	getRequestSettingsService().invalidateCache();
	testDb.db
		.insert(user)
		.values([
			createTestUser({ id: VIEWER_ID, username: 'viewer', email: 'v@test.local', role: 'user' }),
			createTestUser({ id: ADMIN_ID, username: 'admin', email: 'a@test.local', role: 'admin' })
		])
		.run();
	testDb.db
		.insert(rootFolders)
		.values({ id: 'rf', name: 'M', path: '/m', mediaType: 'movie' })
		.run();
	testDb.db
		.insert(libraries)
		.values({ id: 'lib', name: 'Movies', slug: 'movies', mediaType: 'movie' })
		.run();
});

async function callJson(
	// never contravariance: any concrete RequestHandler is assignable here.
	handler: (event: never) => Response | Promise<Response>,
	method: string,
	body: unknown,
	options: { url?: string; auth?: 'admin' | 'user' | false; params?: Record<string, string> }
): Promise<{ status: number; data: any }> {
	const { callHandlerRaw, createRequest, createRequestEvent } =
		await import('../../../test/api-helper.js');
	// callHandlerRaw drives its own event; for handlers we imported directly
	// we build the event the same way so params/url are honored.
	if (options.params || options.url) {
		const request = createRequest(method, body, {
			url: options.url ?? 'http://localhost/api/requests',
			auth: options.auth ?? 'user'
		});
		const event = createRequestEvent(request, options.params ?? {}, {
			url: options.url,
			auth: options.auth ?? 'user'
		});
		const response = await handler(event as never);
		const data = await response.json().catch(() => null);
		return { status: response.status, data };
	}
	const { status, response } = await callHandlerRaw(handler as never, method, body, {
		auth: options.auth ?? 'user',
		url: options.url
	});
	const data = await response.json().catch(() => null);
	return { status, data };
}

describe('POST /api/requests', () => {
	it('lets a viewer create a request', async () => {
		const { status, data } = await callJson(
			POST,
			'POST',
			{ mediaType: 'movie', tmdbId: 99 },
			{
				auth: 'user'
			}
		);
		expect(status).toBe(201);
		expect(data.request.status).toBe('pending');
		expect(data.request.requestedBy).toBe(VIEWER_ID);
	});

	it('401s unauthenticated', async () => {
		const { status } = await callJson(
			POST,
			'POST',
			{ mediaType: 'movie', tmdbId: 99 },
			{
				auth: false
			}
		);
		expect(status).toBe(401);
	});

	it('maps quota failures to coded 403s', async () => {
		await getRequestSettingsService().saveRequestSettings({
			defaultQuotas: { movie: { limit: 1, days: 30 }, tv: { limit: null, days: null } }
		});
		await callJson(POST, 'POST', { mediaType: 'movie', tmdbId: 99 }, { auth: 'user' });
		const { status, data } = await callJson(
			POST,
			'POST',
			{ mediaType: 'movie', tmdbId: 100 },
			{ auth: 'user' }
		);
		expect(status).toBe(403);
		expect(data.code).toBe('movie_quota');
	});
});

describe('GET /api/requests', () => {
	it('scopes viewers to their own rows and admins to everything', async () => {
		await callJson(POST, 'POST', { mediaType: 'movie', tmdbId: 99 }, { auth: 'user' });
		await callJson(POST, 'POST', { mediaType: 'movie', tmdbId: 100 }, { auth: 'admin' });

		const viewerView = await callJson(GET, 'GET', undefined, { auth: 'user' });
		expect(viewerView.data.requests).toHaveLength(1);
		expect(viewerView.data.requests[0].requestedBy).toBe(VIEWER_ID);

		const adminView = await callJson(GET, 'GET', undefined, { auth: 'admin' });
		expect(adminView.data.requests).toHaveLength(2);
	});
});

describe('GET /api/requests/count', () => {
	it('returns own counts + quota for viewers', async () => {
		await callJson(POST, 'POST', { mediaType: 'movie', tmdbId: 99 }, { auth: 'user' });
		const { data } = await callJson(GET_COUNT, 'GET', undefined, { auth: 'user' });
		expect(data.counts.total).toBe(1);
		expect(data.counts.pending).toBe(1);
		expect(data.quota.movie).toMatchObject({ used: 1 });
	});
});

describe('DELETE /api/requests/[id]', () => {
	it('lets the owner cancel their own pending request', async () => {
		const created = await callJson(
			POST,
			'POST',
			{ mediaType: 'movie', tmdbId: 99 },
			{
				auth: 'user'
			}
		);
		const { status, data } = await callJson(DELETE, 'DELETE', undefined, {
			auth: 'user',
			params: { id: created.data.request.id }
		});
		expect(status).toBe(200);
		expect(data.request.status).toBe('cancelled');
	});

	it('404s another viewer cancelling someone else’s request', async () => {
		const created = await callJson(
			POST,
			'POST',
			{ mediaType: 'movie', tmdbId: 99 },
			{
				auth: 'admin'
			}
		);
		const { status } = await callJson(DELETE, 'DELETE', undefined, {
			auth: 'user',
			params: { id: created.data.request.id }
		});
		expect(status).toBe(404);
	});
});

describe('admin mutations', () => {
	it('403s viewers on approve', async () => {
		const created = await callJson(
			POST,
			'POST',
			{ mediaType: 'movie', tmdbId: 99 },
			{
				auth: 'user'
			}
		);
		const { status } = await callJson(POST_APPROVE, 'POST', undefined, {
			auth: 'user',
			params: { id: created.data.request.id }
		});
		expect(status).toBe(403);
	});

	it('requires a decline reason', async () => {
		const created = await callJson(
			POST,
			'POST',
			{ mediaType: 'movie', tmdbId: 99 },
			{
				auth: 'user'
			}
		);
		const noReason = await callJson(
			POST_DECLINE,
			'POST',
			{},
			{ auth: 'admin', params: { id: created.data.request.id } }
		);
		expect([400, 422]).toContain(noReason.status);

		const withReason = await callJson(
			POST_DECLINE,
			'POST',
			{ reason: 'not available' },
			{ auth: 'admin', params: { id: created.data.request.id } }
		);
		expect(withReason.status).toBe(200);
		expect(withReason.data.request.declineReason).toBe('not available');
	});

	it('bulk decline reports per-id outcomes and enforces reason', async () => {
		const a = await callJson(POST, 'POST', { mediaType: 'movie', tmdbId: 99 }, { auth: 'user' });
		const b = await callJson(POST, 'POST', { mediaType: 'movie', tmdbId: 100 }, { auth: 'user' });

		const missingReason = await callJson(
			POST_BULK,
			'POST',
			{ ids: [a.data.request.id], action: 'decline' },
			{ auth: 'admin' }
		);
		expect(missingReason.status).toBe(400);

		const bulk = await callJson(
			POST_BULK,
			'POST',
			{
				ids: [a.data.request.id, b.data.request.id, 'missing-id'],
				action: 'decline',
				reason: 'batch cleanup'
			},
			{ auth: 'admin' }
		);
		expect(bulk.status).toBe(200);
		const okIds = bulk.data.results.filter((r: { ok: boolean }) => r.ok);
		const failedIds = bulk.data.results.filter((r: { ok: boolean }) => !r.ok);
		expect(okIds).toHaveLength(2);
		expect(failedIds).toHaveLength(1);
	});
});

describe('DELETE /api/requests/[id] — decided requests', () => {
	it('lets the owner remove their own declined request outright', async () => {
		const created = await callJson(
			POST,
			'POST',
			{ mediaType: 'movie', tmdbId: 99 },
			{ auth: 'user' }
		);
		await callJson(
			POST_DECLINE,
			'POST',
			{ reason: 'not available' },
			{ auth: 'admin', params: { id: created.data.request.id } }
		);

		const removed = await callJson(DELETE, 'DELETE', undefined, {
			auth: 'user',
			params: { id: created.data.request.id }
		});
		expect(removed.status).toBe(200);
		expect(removed.data.deleted).toBe(true);

		const rows = testDb.db.select().from(requests).all();
		expect(rows).toHaveLength(0);
	});

	it("lets an admin remove a viewer's cancelled request", async () => {
		const created = await callJson(
			POST,
			'POST',
			{ mediaType: 'movie', tmdbId: 99 },
			{ auth: 'user' }
		);
		await callJson(DELETE, 'DELETE', undefined, {
			auth: 'user',
			params: { id: created.data.request.id }
		});

		const removed = await callJson(DELETE, 'DELETE', undefined, {
			auth: 'admin',
			params: { id: created.data.request.id }
		});
		expect(removed.status).toBe(200);
		expect(removed.data.deleted).toBe(true);
	});

	it('removes a fulfilled request and keeps active ones behind invalid_status', async () => {
		const created = await callJson(
			POST,
			'POST',
			{ mediaType: 'movie', tmdbId: 99 },
			{ auth: 'user' }
		);
		const id = created.data.request.id;
		await callJson(POST_FULFILL, 'POST', undefined, { auth: 'admin', params: { id } });

		const removed = await callJson(DELETE, 'DELETE', undefined, { auth: 'user', params: { id } });
		expect(removed.status).toBe(200);
		expect(removed.data.deleted).toBe(true);

		// An approved (active, non-pending) request cannot be removed —
		// decline is the verb there. (Failed requests ARE owner-removable;
		// that's covered in the service suite.) Seed the movie row AFTER the
		// request exists (create rejects in-library titles) so approval takes
		// the existing-row branch and genuinely lands `approved` without
		// touching the mocked add orchestrator.
		const active = await callJson(
			POST,
			'POST',
			{ mediaType: 'movie', tmdbId: 100 },
			{ auth: 'user' }
		);
		testDb.db
			.insert(movies)
			.values({
				tmdbId: 100,
				title: 'Approved But Not Imported',
				path: 'Approved But Not Imported (2020)',
				libraryId: 'lib',
				rootFolderId: 'rf',
				hasFile: false
			})
			.run();
		const approved = await callJson(POST_APPROVE, 'POST', undefined, {
			auth: 'admin',
			params: { id: active.data.request.id }
		});
		expect(approved.data.request.status).toBe('approved');
		const conflict = await callJson(DELETE, 'DELETE', undefined, {
			auth: 'user',
			params: { id: active.data.request.id }
		});
		expect(conflict.status).toBe(409);
		expect(conflict.data.code).toBe('invalid_status');
	});

	it("404s a viewer removing someone else's decided request", async () => {
		const created = await callJson(
			POST,
			'POST',
			{ mediaType: 'movie', tmdbId: 99 },
			{ auth: 'admin' }
		);
		await callJson(
			POST_DECLINE,
			'POST',
			{ reason: 'nope' },
			{ auth: 'admin', params: { id: created.data.request.id } }
		);

		const removed = await callJson(DELETE, 'DELETE', undefined, {
			auth: 'user',
			params: { id: created.data.request.id }
		});
		expect(removed.status).toBe(404);
	});
});

describe('GET /api/requests/media-status', () => {
	it('401s unauthenticated and 400s on bad params', async () => {
		const unauth = await callJson(GET_MEDIA_STATUS, 'GET', undefined, {
			auth: false,
			url: 'http://localhost/api/requests/media-status?mediaType=movie&tmdbId=99'
		});
		expect(unauth.status).toBe(401);

		const bad = await callJson(GET_MEDIA_STATUS, 'GET', undefined, {
			auth: 'user',
			url: 'http://localhost/api/requests/media-status?mediaType=book&tmdbId=99'
		});
		expect(bad.status).toBe(400);
	});

	it('reports movie library state and active requests', async () => {
		const created = await callJson(
			POST,
			'POST',
			{ mediaType: 'movie', tmdbId: 99 },
			{ auth: 'user' }
		);
		expect(created.status).toBe(201);

		const empty = await callJson(GET_MEDIA_STATUS, 'GET', undefined, {
			auth: 'user',
			url: 'http://localhost/api/requests/media-status?mediaType=movie&tmdbId=42'
		});
		expect(empty.data).toMatchObject({
			success: true,
			active: false,
			inLibrary: false,
			hasFile: false
		});

		const status = await callJson(GET_MEDIA_STATUS, 'GET', undefined, {
			auth: 'user',
			url: 'http://localhost/api/requests/media-status?mediaType=movie&tmdbId=99'
		});
		expect(status.data).toMatchObject({ success: true, active: true, inLibrary: false });

		testDb.db
			.insert(movies)
			.values({
				tmdbId: 42,
				title: 'Owned',
				path: 'Owned (2020)',
				libraryId: 'lib',
				rootFolderId: 'rf',
				hasFile: true
			})
			.run();
		const owned = await callJson(GET_MEDIA_STATUS, 'GET', undefined, {
			auth: 'user',
			url: 'http://localhost/api/requests/media-status?mediaType=movie&tmdbId=42'
		});
		expect(owned.data).toMatchObject({ active: false, inLibrary: true, hasFile: true });
	});

	it('reports series active scopes and on-disk episodes', async () => {
		const created = await callJson(
			POST,
			'POST',
			{ mediaType: 'series', tmdbId: 77, seasons: [1] },
			{ auth: 'user' }
		);
		expect(created.status).toBe(201);

		const scoped = await callJson(GET_MEDIA_STATUS, 'GET', undefined, {
			auth: 'user',
			url: 'http://localhost/api/requests/media-status?mediaType=series&tmdbId=77'
		});
		expect(scoped.data.activeScopes).toEqual([{ seasons: [1], episodes: [] }]);
		expect(scoped.data.inLibrary).toBe(false);

		testDb.db
			.insert(series)
			.values({ tmdbId: 77, title: 'Show', path: 'Show', libraryId: 'lib', rootFolderId: 'rf' })
			.run();
		const show = testDb.db
			.select()
			.from(series)
			.all()
			.find((s) => s.tmdbId === 77)!;
		testDb.db
			.insert(episodes)
			.values([
				{
					seriesId: show.id,
					tmdbId: 1,
					seasonNumber: 1,
					episodeNumber: 1,
					title: 'Pilot',
					hasFile: true
				},
				{
					seriesId: show.id,
					tmdbId: 2,
					seasonNumber: 1,
					episodeNumber: 2,
					title: 'Two',
					hasFile: false
				}
			])
			.run();

		const onDisk = await callJson(GET_MEDIA_STATUS, 'GET', undefined, {
			auth: 'user',
			url: 'http://localhost/api/requests/media-status?mediaType=series&tmdbId=77'
		});
		expect(onDisk.data.availableEpisodes).toEqual(['1x1']);
	});
});
