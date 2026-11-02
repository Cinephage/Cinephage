/**
 * Tests for the request workflow authority. The DB is real; TMDB fetches,
 * the shared add orchestrators, search triggers, and the blocked-media
 * service are mocked at module boundaries. Exercises the create validation
 * order, auto-approve resolution, availability predicates (including
 * multi-quality buckets and unaired episodes), TTL expiry, and the
 * blocked-media deny path.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper';
import {
	requests,
	userRequestSettings,
	user,
	settings,
	movies,
	movieFiles,
	series,
	seasons,
	episodes,
	rootFolders
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

const movieDetails = {
	title: 'Test Movie',
	poster_path: '/poster.jpg',
	release_date: '2023-05-05',
	original_language: 'en',
	original_title: 'Test Movie',
	genres: [{ id: 1, name: 'Drama' }],
	overview: 'An overview'
};
const seriesDetails = {
	name: 'Test Show',
	poster_path: '/show.jpg',
	first_air_date: '2020-01-01',
	original_language: 'en',
	original_name: 'Test Show',
	genres: [{ id: 1, name: 'Drama' }],
	seasons: [
		{ season_number: 1, episode_count: 3 },
		{ season_number: 2, episode_count: 2 }
	]
};

const addMovieToLibrary = vi.hoisted(() => vi.fn());
const addSeriesToLibrary = vi.hoisted(() => vi.fn());
const triggerMovieSearch = vi.hoisted(() => vi.fn(async () => ({ triggered: true })));
const triggerSeriesSearch = vi.hoisted(() => vi.fn(async () => ({ triggered: true })));

vi.mock('#lib/server/library/LibraryAddService.js', () => ({
	fetchMovieDetails: vi.fn(async () => movieDetails),
	fetchSeriesDetails: vi.fn(async () => seriesDetails),
	fetchMovieExternalIds: vi.fn(async () => ({ imdbId: 'tt0000001' })),
	fetchSeriesExternalIds: vi.fn(async () => ({ imdbId: 'tt0000002', tvdbId: 123 })),
	validateRootFolder: vi.fn(async () => undefined),
	getAnimeSubtypeEnforcement: vi.fn(async () => false),
	getEffectiveScoringProfileId: vi.fn(async () => 'profile-1'),
	triggerMovieSearch,
	triggerSeriesSearch
}));

vi.mock('#lib/server/library/add/add-movie.js', () => ({ addMovieToLibrary }));
vi.mock('#lib/server/library/add/add-series.js', () => ({ addSeriesToLibrary }));
vi.mock('#lib/server/blocked-media/service.js', () => ({
	blockedMediaService: { isBlocked: vi.fn(async () => false) }
}));
vi.mock('#lib/server/library/LibraryEntityService.js', () => ({
	getLibraryEntityService: vi.fn(() => ({
		resolveOwningLibraryForRootFolder: vi.fn(async () => ({ id: 'lib-1' }))
	}))
}));
vi.mock('#lib/server/library/naming/NamingSettingsService.js', () => ({
	namingSettingsService: { getConfigSync: () => ({ movieFolderFormat: '{title}' }) }
}));

const { getRequestService } = await import('./RequestService.js');
const { getRequestSettingsService } = await import('./RequestSettingsService.js');
const { getUserRequestSettingsService } = await import('./UserRequestSettingsService.js');
const { declinePendingRequestsForBlockedMedia } = await import('./deny.js');
const { ACTIVE_REQUEST_STATUSES } = await import('./types.js');

let viewerId: string;
let adminId: string;

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(requests).run();
	testDb.db.delete(userRequestSettings).run();
	testDb.db.delete(settings).run();
	testDb.db.delete(user).run();
	getRequestSettingsService().invalidateCache();
	vi.clearAllMocks();
	addMovieToLibrary.mockReset();
	addSeriesToLibrary.mockReset();
	addMovieToLibrary.mockImplementation(async (input: { tmdbId: number }) => {
		const movieId = `movie-added-${input.tmdbId}`;
		testDb.db
			.insert(movies)
			.values({
				id: movieId,
				tmdbId: input.tmdbId,
				title: 'Test Movie',
				path: `folder-${movieId}`,
				hasFile: false,
				monitored: true
			})
			.onConflictDoNothing()
			.run();
		return {
			outcome: 'added',
			movieId,
			tmdbId: input.tmdbId,
			title: 'Test Movie',
			year: 2023,
			path: `folder-${movieId}`,
			monitored: true,
			searchTriggered: true
		};
	});
	addSeriesToLibrary.mockImplementation(async (input: { tmdbId: number }) => {
		const seriesId = `series-added-${input.tmdbId}`;
		testDb.db
			.insert(series)
			.values({
				id: seriesId,
				tmdbId: input.tmdbId,
				title: 'Test Show',
				path: `folder-${seriesId}`,
				monitored: true
			})
			.onConflictDoNothing()
			.run();
		return {
			outcome: 'added',
			seriesId,
			tmdbId: input.tmdbId,
			title: 'Test Show',
			year: 2020,
			path: `folder-${seriesId}`,
			monitored: true,
			episodeCount: 5,
			searchTriggered: true
		};
	});
	triggerMovieSearch.mockClear();
	triggerSeriesSearch.mockClear();

	viewerId = randomUUID();
	adminId = randomUUID();
	testDb.db
		.insert(user)
		.values([
			createTestUser({ id: viewerId, username: 'viewer', email: 'v@test.local', role: 'user' }),
			createTestUser({ id: adminId, username: 'admin', email: 'a@test.local', role: 'admin' })
		])
		.run();
	testDb.db
		.insert(rootFolders)
		.values([
			{
				id: 'rf-movie',
				name: 'Movies',
				path: '/media/movies',
				mediaType: 'movie',
				isDefault: true
			},
			{ id: 'rf-tv', name: 'TV', path: '/media/tv', mediaType: 'tv', isDefault: true }
		])
		.onConflictDoNothing()
		.run();
});

function viewer() {
	return { id: viewerId, role: 'user' as const };
}

describe('create validation order', () => {
	it('creates a pending movie request with a TTL stamp and snapshot', async () => {
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });

		expect(created.status).toBe('pending');
		expect(created.title).toBe('Test Movie');
		expect(created.expiresAt).toBeTruthy();
		expect(created.requestedBy).toBe(viewerId);
	});

	it('rejects when requests are globally disabled', async () => {
		await getRequestSettingsService().saveRequestSettings({ requestsEnabled: false });
		await expect(
			getRequestService().create(viewer(), { mediaType: 'movie', tmdbId: 42 })
		).rejects.toMatchObject({ code: 'requests_disabled' });
	});

	it('rejects when the account is disabled for requesting', async () => {
		await getUserRequestSettingsService().updateUserRequestSettings(viewerId, {
			requestsDisabled: true
		});
		await expect(
			getRequestService().create(viewer(), { mediaType: 'movie', tmdbId: 42 })
		).rejects.toMatchObject({ code: 'requesting_disabled' });
	});

	it('rejects blocked media', async () => {
		const { blockedMediaService } = await import('#lib/server/blocked-media/service.js');
		vi.mocked(blockedMediaService.isBlocked).mockResolvedValueOnce(true);
		await expect(
			getRequestService().create(viewer(), { mediaType: 'movie', tmdbId: 42 })
		).rejects.toMatchObject({ code: 'blocked_media' });
	});

	it('rejects an available movie and a monitored wanted movie', async () => {
		const svc = getRequestService();
		testDb.db
			.insert(movies)
			.values({
				id: 'm-have',
				tmdbId: 42,
				title: 'Test Movie',
				path: 'folder-m-have',
				hasFile: true,
				monitored: true
			})
			.run();
		await expect(svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 })).rejects.toMatchObject({
			code: 'already_available'
		});

		testDb.db.update(movies).set({ hasFile: false }).where(eqId('m-have')).run();
		await expect(svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 })).rejects.toMatchObject({
			code: 'already_in_library'
		});
	});

	it('rejects duplicate active movie requests', async () => {
		const svc = getRequestService();
		await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		await expect(svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 })).rejects.toMatchObject({
			code: 'duplicate_request'
		});
	});

	it('allows re-request after decline cooldown passes but blocks within it', async () => {
		const svc = getRequestService();
		await getRequestSettingsService().saveRequestSettings({ reRequestCooldownDays: 7 });
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		await svc.decline(created.id, { id: adminId, role: 'admin' }, 'not needed');

		await expect(svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 })).rejects.toMatchObject({
			code: 'cooldown'
		});

		await getRequestSettingsService().saveRequestSettings({ reRequestCooldownDays: 0 });
		const again = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		expect(again.status).toBe('pending');
	});

	it('enforces the movie quota with counts', async () => {
		await getRequestSettingsService().saveRequestSettings({
			defaultQuotas: {
				movie: { limit: 1, days: 30 },
				tv: { limit: null, days: null }
			}
		});
		const svc = getRequestService();
		await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		await expect(svc.create(viewer(), { mediaType: 'movie', tmdbId: 43 })).rejects.toMatchObject({
			code: 'movie_quota'
		});
	});

	it('enforces the TV quota in episode units', async () => {
		await getRequestSettingsService().saveRequestSettings({
			defaultQuotas: {
				movie: { limit: null, days: null },
				tv: { limit: 2, days: 30 }
			},
			tvQuotaUnit: 'episodes'
		});
		const svc = getRequestService();
		// Season 1 has 3 episodes (mocked TMDB): over a limit of 2.
		await expect(
			svc.create(viewer(), { mediaType: 'series', tmdbId: 77, seasons: [1] })
		).rejects.toMatchObject({ code: 'tv_quota' });

		// Two explicit episodes fit exactly.
		const created = await svc.create(viewer(), {
			mediaType: 'series',
			tmdbId: 77,
			episodes: [
				{ seasonNumber: 1, episodeNumber: 1 },
				{ seasonNumber: 1, episodeNumber: 2 }
			]
		});
		expect(created.status).toBe('pending');
	});

	it('rejects invalid scopes: season 0, empty series scope, movie with seasons', async () => {
		const svc = getRequestService();
		await expect(
			svc.create(viewer(), { mediaType: 'series', tmdbId: 77, seasons: [0] })
		).rejects.toMatchObject({ code: 'invalid_scope' });
		await expect(svc.create(viewer(), { mediaType: 'series', tmdbId: 77 })).rejects.toMatchObject({
			code: 'invalid_scope'
		});
		await expect(
			svc.create(viewer(), { mediaType: 'movie', tmdbId: 42, seasons: [1] })
		).rejects.toMatchObject({ code: 'invalid_scope' });
	});

	it('filters episode scope against already-available episodes of an in-library series', async () => {
		const svc = getRequestService();
		insertSeriesWithEpisodes('s-1', 77, [
			{ season: 1, episode: 1, hasFile: true },
			{ season: 1, episode: 2, hasFile: false }
		]);

		const created = await svc.create(viewer(), {
			mediaType: 'series',
			tmdbId: 77,
			episodes: [
				{ seasonNumber: 1, episodeNumber: 1 },
				{ seasonNumber: 1, episodeNumber: 2 }
			]
		});
		expect(created.episodes).toEqual([{ seasonNumber: 1, episodeNumber: 2 }]);

		await expect(
			svc.create(viewer(), {
				mediaType: 'series',
				tmdbId: 77,
				episodes: [{ seasonNumber: 1, episodeNumber: 1 }]
			})
		).rejects.toMatchObject({ code: 'already_available' });
	});

	it('blocks overlapping series scope from an active request', async () => {
		const svc = getRequestService();
		await svc.create(viewer(), { mediaType: 'series', tmdbId: 77, seasons: [1] });
		await expect(
			svc.create(viewer(), {
				mediaType: 'series',
				tmdbId: 77,
				episodes: [{ seasonNumber: 1, episodeNumber: 2 }]
			})
		).rejects.toMatchObject({ code: 'duplicate_request' });

		// A disjoint season is fine.
		const other = await svc.create(viewer(), { mediaType: 'series', tmdbId: 77, seasons: [2] });
		expect(other.status).toBe('pending');
	});
});

describe('post-review hardening', () => {
	it('pending whole-season requests debit TV quota in episode units', async () => {
		await getRequestSettingsService().saveRequestSettings({
			defaultQuotas: {
				movie: { limit: null, days: null },
				tv: { limit: 2, days: 30 }
			},
			tvQuotaUnit: 'episodes'
		});
		const svc = getRequestService();
		// Season 2 has 2 episodes (mocked TMDB): fits exactly, then blocks
		// the next request while it is still pending (not yet approved).
		const first = await svc.create(viewer(), { mediaType: 'series', tmdbId: 77, seasons: [2] });
		expect(first.episodeCountSnapshot).toEqual([{ season: 2, count: 2 }]);
		await expect(
			svc.create(viewer(), {
				mediaType: 'series',
				tmdbId: 78,
				episodes: [{ seasonNumber: 1, episodeNumber: 1 }]
			})
		).rejects.toMatchObject({ code: 'tv_quota' });
	});

	it('seasons unit counts seasons touched by episode picks at create', async () => {
		await getRequestSettingsService().saveRequestSettings({
			defaultQuotas: {
				movie: { limit: null, days: null },
				tv: { limit: 1, days: 30 }
			},
			tvQuotaUnit: 'seasons'
		});
		const svc = getRequestService();
		// Episodes from two different seasons = 2 units against a limit of 1.
		await expect(
			svc.create(viewer(), {
				mediaType: 'series',
				tmdbId: 77,
				episodes: [
					{ seasonNumber: 1, episodeNumber: 1 },
					{ seasonNumber: 2, episodeNumber: 1 }
				]
			})
		).rejects.toMatchObject({ code: 'tv_quota' });
	});

	it('cooldown applies after TTL expiry, not only after decline', async () => {
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		testDb.db
			.update(requests)
			.set({ expiresAt: '2000-01-01T00:00:00.000Z' })
			.where(eq(requests.id, created.id))
			.run();
		await svc.expireStalePending();

		await expect(svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 })).rejects.toMatchObject({
			code: 'cooldown'
		});
	});

	it('rejects scopes that do not exist on TMDB', async () => {
		const svc = getRequestService();
		// Mocked TMDB has seasons 1 (3 eps) and 2 (2 eps) only.
		await expect(
			svc.create(viewer(), { mediaType: 'series', tmdbId: 77, seasons: [3] })
		).rejects.toMatchObject({ code: 'invalid_scope' });
		await expect(
			svc.create(viewer(), {
				mediaType: 'series',
				tmdbId: 77,
				episodes: [{ seasonNumber: 1, episodeNumber: 99 }]
			})
		).rejects.toMatchObject({ code: 'invalid_scope' });
	});

	it('rejects banned requesters even though the hooks gate let them through', async () => {
		const svc = getRequestService();
		await expect(
			svc.create({ ...viewer(), banned: true }, { mediaType: 'movie', tmdbId: 42 })
		).rejects.toMatchObject({ code: 'banned' });
	});

	it('quota window: requests older than the window stop counting', async () => {
		await getRequestSettingsService().saveRequestSettings({
			defaultQuotas: {
				movie: { limit: 1, days: 30 },
				tv: { limit: null, days: null }
			}
		});
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		testDb.db
			.update(requests)
			.set({ createdAt: '2000-01-01T00:00:00.000Z' })
			.where(eq(requests.id, created.id))
			.run();
		const fresh = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 43 });
		expect(fresh.status).toBe('pending');
	});

	it('a concurrent second approve does no duplicate work and does not corrupt status', async () => {
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });

		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		addMovieToLibrary.mockImplementationOnce(async (input: { tmdbId: number }) => {
			await gate;
			const movieId = `movie-added-${input.tmdbId}`;
			testDb.db
				.insert(movies)
				.values({
					id: movieId,
					tmdbId: input.tmdbId,
					title: 'Test Movie',
					path: `folder-${movieId}`,
					hasFile: false,
					monitored: true
				})
				.onConflictDoNothing()
				.run();
			return {
				outcome: 'added',
				movieId,
				tmdbId: input.tmdbId,
				title: 'Test Movie',
				year: 2023,
				path: `folder-${movieId}`,
				monitored: true,
				searchTriggered: true
			};
		});
		const first = svc.approve(created.id, { id: adminId, role: 'admin' });
		// Let the first call claim the transition before starting the second.
		await new Promise((resolve) => setTimeout(resolve, 25));
		await expect(svc.approve(created.id, { id: adminId, role: 'admin' })).rejects.toMatchObject({
			code: 'invalid_status'
		});
		release!();
		const result = await first;
		expect(result.failureReason).toBeNull();
		expect(result.status).toBe('approved');
		expect(addMovieToLibrary).toHaveBeenCalledTimes(1);
	});

	it('writes durable notification rows: pending to admins, decline to the requester', async () => {
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		const pendingRows = testDb.sqlite
			.prepare('SELECT user_id, event FROM request_notifications')
			.all() as Array<{ user_id: string; event: string }>;
		expect(pendingRows).toEqual([{ user_id: adminId, event: 'request_pending' }]);

		await svc.decline(created.id, { id: adminId, role: 'admin' }, 'nope');
		const declinedRows = testDb.sqlite
			.prepare("SELECT user_id, event FROM request_notifications WHERE event = 'request_declined'")
			.all() as Array<{ user_id: string; event: string }>;
		expect(declinedRows).toEqual([{ user_id: viewerId, event: 'request_declined' }]);
	});
});

describe('auto-approve resolution', () => {
	it('auto-approves per-user override and calls the add orchestrator', async () => {
		await getUserRequestSettingsService().updateUserRequestSettings(viewerId, {
			autoApprove: true
		});
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });

		expect(created.status).toBe('approved');
		expect(created.autoApproved).toBe(true);
		expect(created.decidedBy).toBe(viewerId);
		expect(addMovieToLibrary).toHaveBeenCalledWith(
			expect.objectContaining({ tmdbId: 42, searchOnAdd: true, monitored: true })
		);
	});

	it('honors the global auto-approve setting per media type', async () => {
		await getRequestSettingsService().saveRequestSettings({
			autoApprove: { movie: true, series: false }
		});
		const svc = getRequestService();

		const movie = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		expect(movie.status).toBe('approved');

		const show = await svc.create(viewer(), { mediaType: 'series', tmdbId: 77, seasons: [1] });
		expect(show.status).toBe('pending');
	});

	it('parks in awaiting_target when no writable root folder exists', async () => {
		const svc = getRequestService();
		await getUserRequestSettingsService().updateUserRequestSettings(viewerId, {
			autoApprove: true
		});
		// No rootFolders rows at all -> resolveTargetRootFolder returns null.
		testDb.db.delete(rootFolders).run();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		expect(created.status).toBe('awaiting_target');
		expect(addMovieToLibrary).not.toHaveBeenCalled();
	});
});

describe('approve', () => {
	it('drives the add orchestrator and links the library row', async () => {
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		const approved = await svc.approve(created.id, { id: adminId, role: 'admin' });

		expect(approved.status).toBe('approved');
		expect(approved.movieId).toBe('movie-added-42');
		expect(approved.decidedBy).toBe(adminId);
		expect(approved.expiresAt).toBeNull();
	});

	it('re-monitors an existing movie instead of re-adding', async () => {
		const svc = getRequestService();
		testDb.db
			.insert(movies)
			.values({
				id: 'm-existing',
				tmdbId: 42,
				title: 'Test Movie',
				path: 'folder-m-existing',
				hasFile: false,
				monitored: false
			})
			.run();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		await svc.approve(created.id, { id: adminId, role: 'admin' });

		expect(addMovieToLibrary).not.toHaveBeenCalled();
		expect(triggerMovieSearch).toHaveBeenCalled();
		const row = testDb.sqlite
			.prepare('SELECT monitored FROM movies WHERE id = ?')
			.get('m-existing') as { monitored: number };
		expect(row.monitored).toBe(1);
	});

	it('fails the request when the add orchestrator throws, and retry recovers', async () => {
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });

		addMovieToLibrary.mockRejectedValueOnce(new Error('TMDB unreachable'));
		const failed = await svc.approve(created.id, { id: adminId, role: 'admin' });
		expect(failed.status).toBe('failed');
		expect(failed.failureReason).toContain('TMDB unreachable');

		const retried = await svc.retry(created.id, { id: adminId, role: 'admin' });
		expect(retried.status).toBe('approved');
	});

	it('fails approval when TMDB no longer reports the requested seasons', async () => {
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'series', tmdbId: 77, seasons: [1] });

		const { fetchSeriesDetails } = await import('#lib/server/library/LibraryAddService.js');
		vi.mocked(fetchSeriesDetails).mockResolvedValue({
			...seriesDetails,
			seasons: [{ season_number: 2, episode_count: 2 }]
		} as never);
		const failed = await svc.approve(created.id, { id: adminId, role: 'admin' });
		expect(failed.status).toBe('failed');
		expect(failed.failureReason).toContain('no longer exist');
		expect(addSeriesToLibrary).not.toHaveBeenCalled();
	});

	it('decline requires a reason and blocks re-request during cooldown', async () => {
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		const declined = await svc.decline(created.id, { id: adminId, role: 'admin' }, 'nope');
		expect(declined.status).toBe('declined');
		expect(declined.declineReason).toBe('nope');

		await expect(svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 })).rejects.toMatchObject({
			code: 'cooldown'
		});
	});

	it('only the owner can cancel their own pending request', async () => {
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });

		const other = { id: randomUUID(), role: 'user' as const };
		await expect(svc.cancel(created.id, other)).rejects.toMatchObject({ code: 'not_found' });

		const cancelled = await svc.cancel(created.id, viewer());
		expect(cancelled.status).toBe('cancelled');
	});
});

describe('availability predicate', () => {
	it('single-quality movie: hasFile decides', async () => {
		const svc = getRequestService();
		insertMovie('m-single', 42, { hasFile: false });
		const request = { ...baseRequest('movie', 42), movieId: 'm-single' };
		expect(await svc.evaluatePredicate(request)).toBe(false);

		testDb.db.update(movies).set({ hasFile: true }).where(eqId('m-single')).run();
		expect(await svc.evaluatePredicate({ ...request, movieId: 'm-single' })).toBe(true);
	});

	it('multi-quality movie: every effective bucket must be filled', async () => {
		const svc = getRequestService();
		insertMovie('m-multi', 42, { hasFile: true, desiredQualities: ['2160p', '1080p'] });
		insertMovieFile('f-1080', 'm-multi', '1080p');

		const request = { ...baseRequest('movie', 42), movieId: 'm-multi' };
		expect(await svc.evaluatePredicate(request)).toBe(false);

		insertMovieFile('f-2160', 'm-multi', '2160p');
		expect(await svc.evaluatePredicate(request)).toBe(true);
	});

	it('series: episode entries need files; unaired season entries keep it open', async () => {
		const svc = getRequestService();
		insertSeriesWithEpisodes('s-tv', 77, [
			{ season: 1, episode: 1, hasFile: false },
			{ season: 1, episode: 2, hasFile: true },
			{ season: 2, episode: 1, hasFile: false }
		]);

		const episodeRequest = {
			...baseRequest('series', 77),
			seriesId: 's-tv',
			episodes: [{ seasonNumber: 1, episodeNumber: 2 }]
		};
		expect(await svc.evaluatePredicate(episodeRequest)).toBe(true);

		const openRequest = {
			...baseRequest('series', 77),
			seriesId: 's-tv',
			episodes: [{ seasonNumber: 1, episodeNumber: 1 }]
		};
		expect(await svc.evaluatePredicate(openRequest)).toBe(false);

		const seasonRequest = { ...baseRequest('series', 77), seriesId: 's-tv', seasons: [1] };
		expect(await svc.evaluatePredicate(seasonRequest)).toBe(false);
	});
});

describe('fulfillment projection and expiry', () => {
	it('fulfills pending requests directly when the media appears', async () => {
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		insertMovie('m-landed', 42, { hasFile: true });

		const advanced = await svc.advanceFulfilledByMedia('movie', 42);
		expect(advanced).toBe(1);
		const after = await svc.getRequest(created.id);
		expect(after.status).toBe('fulfilled');
		expect(after.movieId).toBe('m-landed');
	});

	it('expires stale pending requests with the expired reason', async () => {
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		testDb.db
			.update(requests)
			.set({ expiresAt: '2000-01-01T00:00:00.000Z' })
			.where(eq(requests.id, created.id))
			.run();

		const expired = await svc.expireStalePending();
		expect(expired).toBe(1);
		const after = await svc.getRequest(created.id);
		expect(after.status).toBe('expired');
		expect(after.declineReason).toBe('expired');
	});

	it('declines active requests when media is blocked', async () => {
		const svc = getRequestService();
		await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });

		const declined = await declinePendingRequestsForBlockedMedia(42, 'movie');
		expect(declined).toBe(1);
		const rows = testDb.sqlite.prepare('SELECT status FROM requests').all() as Array<{
			status: string;
		}>;
		expect(rows[0].status).toBe('declined');
	});
});

describe('deleted-media reconciliation', () => {
	it('fails approved requests orphaned by media deletion and notifies the requester', async () => {
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		// Real FK path: approve stamps the movie id, then deleting the movie
		// row nulls it (ON DELETE SET NULL) — exactly the orphan class.
		insertMovie('m-deleted', 42, { hasFile: false });
		testDb.db
			.update(requests)
			.set({ status: 'approved', movieId: 'm-deleted' })
			.where(eq(requests.id, created.id))
			.run();
		testDb.db.delete(movies).where(eqId('m-deleted')).run();

		const afterDelete = await svc.getRequest(created.id);
		expect(afterDelete.movieId).toBeNull();

		const failed = await svc.reconcileDeletedMedia();
		expect(failed).toBe(1);
		const after = await svc.getRequest(created.id);
		expect(after.status).toBe('failed');
		expect(after.failureReason).toBe('Library item was deleted');

		const notifs = testDb.sqlite
			.prepare('SELECT event FROM request_notifications WHERE user_id = ?')
			.all(viewerId) as Array<{ event: string }>;
		expect(notifs.some((n) => n.event === 'request_failed')).toBe(true);
	});

	it('leaves approved requests that still carry their library id, and other statuses, untouched', async () => {
		const svc = getRequestService();
		const orphan = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		const linked = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 43 });
		const pending = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 44 });
		insertMovie('m-alive', 43, { hasFile: false });

		testDb.db
			.update(requests)
			.set({ status: 'approved', movieId: null })
			.where(eq(requests.id, orphan.id))
			.run();
		testDb.db
			.update(requests)
			.set({ status: 'approved', movieId: 'm-alive' })
			.where(eq(requests.id, linked.id))
			.run();
		void pending;

		const failed = await svc.reconcileDeletedMedia();
		expect(failed).toBe(1);
		expect((await svc.getRequest(orphan.id)).status).toBe('failed');
		expect((await svc.getRequest(linked.id)).status).toBe('approved');
		expect((await svc.getRequest(pending.id)).status).toBe('pending');
	});

	it('treats failed as terminal: owners may remove the row (unlocking a fresh request)', async () => {
		const svc = getRequestService();
		const created = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		testDb.db
			.update(requests)
			.set({ status: 'failed', failureReason: 'Library item was deleted' })
			.where(eq(requests.id, created.id))
			.run();

		const result = await svc.cancelOrRemove(created.id, viewer());
		expect(result.kind).toBe('removed');
		const rows = testDb.sqlite
			.prepare('SELECT COUNT(*) AS c FROM requests WHERE id = ?')
			.get(created.id) as { c: number };
		expect(rows.c).toBe(0);

		// With the failed row gone, the title is requestable again.
		const recreated = await svc.create(viewer(), { mediaType: 'movie', tmdbId: 42 });
		expect(recreated.status).toBe('pending');
	});
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function eqId(id: string) {
	return eq(movies.id, id);
}

function baseRequest(mediaType: 'movie' | 'series', tmdbId: number) {
	return {
		id: randomUUID(),
		mediaType,
		tmdbId,
		movieId: null,
		seriesId: null,
		seasons: null,
		episodes: null
	};
}

function insertMovie(
	id: string,
	tmdbId: number,
	opts: { hasFile: boolean; desiredQualities?: string[] }
) {
	testDb.db
		.insert(movies)
		.values({
			id,
			tmdbId,
			title: 'Test Movie',
			path: `folder-${id}`,
			hasFile: opts.hasFile,
			monitored: true,
			desiredQualities: (opts.desiredQualities ?? null) as never
		})
		.run();
}

function insertMovieFile(id: string, movieId: string, resolution: string) {
	testDb.db
		.insert(movieFiles)
		.values({
			id,
			movieId,
			relativePath: `${id}.mkv`,
			quality: { resolution } as never
		})
		.run();
}

function insertSeriesWithEpisodes(
	seriesId: string,
	tmdbId: number,
	eps: Array<{ season: number; episode: number; hasFile: boolean }>
) {
	testDb.db
		.insert(series)
		.values({
			id: seriesId,
			tmdbId,
			title: 'Test Show',
			path: `folder-${seriesId}`,
			monitored: true
		})
		.run();
	const seasonNumbers = [...new Set(eps.map((e) => e.season))];
	for (const seasonNumber of seasonNumbers) {
		testDb.db
			.insert(seasons)
			.values({
				id: `season-${seriesId}-${seasonNumber}`,
				seriesId,
				seasonNumber,
				monitored: true
			})
			.run();
	}
	for (const ep of eps) {
		testDb.db
			.insert(episodes)
			.values({
				id: `ep-${seriesId}-${ep.season}-${ep.episode}`,
				seriesId,
				seasonId: `season-${seriesId}-${ep.season}`,
				tmdbId: ep.season * 1000 + ep.episode,
				seasonNumber: ep.season,
				episodeNumber: ep.episode,
				title: `Episode ${ep.episode}`,
				monitored: true,
				hasFile: ep.hasFile
			})
			.run();
	}
}

void rootFolders;
void ACTIVE_REQUEST_STATUSES;
