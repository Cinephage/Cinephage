/**
 * fetchSearchActivity backs the Activity page's "Searches" tab. Covers the
 * parts that are easy to get subtly wrong: pagination/total staying correct
 * after an in-process title search and status filter are applied (titles
 * aren't a monitoringHistory column - they're resolved via movies/series
 * joins after the SQL fetch), and sorting.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper';
import {
	movies,
	monitoringHistory,
	series,
	episodes,
	scoringProfiles,
	monitoringSettings
} from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

const { ActivityService } = await import('./ActivityService');

afterAll(() => destroyTestDb(testDb));

async function seedMovie(title: string): Promise<string> {
	const id = randomUUID();
	await testDb.db
		.insert(movies)
		.values({ id, tmdbId: Math.floor(Math.random() * 1_000_000), title, path: `/movies/${id}` });
	return id;
}

async function seedHistoryRow(
	movieId: string,
	overrides: Partial<typeof monitoringHistory.$inferInsert> = {}
): Promise<void> {
	await testDb.db.insert(monitoringHistory).values({
		taskType: 'missing',
		movieId,
		status: 'no_results',
		releasesFound: 0,
		executedAt: new Date().toISOString(),
		...overrides
	});
}

beforeEach(() => {
	testDb.db.delete(monitoringHistory).run();
	testDb.db.delete(episodes).run();
	testDb.db.delete(series).run();
	testDb.db.delete(movies).run();
	testDb.db.delete(scoringProfiles).run();
	testDb.db.delete(monitoringSettings).run();
});

describe('ActivityService.fetchSearchActivity', () => {
	it('paginates correctly and reports a total matching the filtered set, not the raw fetch', async () => {
		// One movie per row - fetchSearchActivity collapses multiple attempts
		// against the SAME item down to one, so pagination/total is tested
		// across distinct items instead.
		for (let i = 0; i < 30; i++) {
			const movieId = await seedMovie(`Paginated Movie ${i}`);
			await seedHistoryRow(movieId, { executedAt: new Date(2026, 0, 1, 0, i).toISOString() });
		}

		const service = ActivityService.getInstance();
		const page1 = await service.fetchSearchActivity({ page: 1, limit: 25 });
		expect(page1.total).toBe(30);
		expect(page1.items).toHaveLength(25);

		const page2 = await service.fetchSearchActivity({ page: 2, limit: 25 });
		expect(page2.items).toHaveLength(5);

		// No overlap between pages.
		const page1Ids = new Set(page1.items.map((i) => i.id));
		for (const item of page2.items) {
			expect(page1Ids.has(item.id)).toBe(false);
		}
	});

	it('collapses repeated attempts against the same item down to its most recent row', async () => {
		const movieId = await seedMovie('Repeatedly Searched Movie');
		await seedHistoryRow(movieId, {
			status: 'skipped',
			executedAt: new Date(2026, 0, 1, 0, 0).toISOString()
		});
		await seedHistoryRow(movieId, {
			status: 'grabbed',
			releasesFound: 1,
			executedAt: new Date(2026, 0, 2, 0, 0).toISOString()
		});

		const service = ActivityService.getInstance();
		const result = await service.fetchSearchActivity({});

		expect(result.total).toBe(1);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].status).toBe('grabbed');
		expect(result.items[0].executedAt).toBe(new Date(2026, 0, 2, 0, 0).toISOString());
	});

	it('keeps separate rows for different episodes of the same series', async () => {
		const seriesId = randomUUID();
		await testDb.db.insert(series).values({
			id: seriesId,
			tmdbId: 777,
			title: 'Multi Episode Series',
			path: `/tv/${seriesId}`
		});
		const episodeAId = randomUUID();
		const episodeBId = randomUUID();
		await testDb.db.insert(episodes).values([
			{ id: episodeAId, seriesId, seasonNumber: 1, episodeNumber: 1 },
			{ id: episodeBId, seriesId, seasonNumber: 1, episodeNumber: 2 }
		]);
		await testDb.db.insert(monitoringHistory).values([
			{
				taskType: 'missing',
				seriesId,
				episodeId: episodeAId,
				status: 'no_results',
				releasesFound: 0,
				executedAt: new Date().toISOString()
			},
			{
				taskType: 'missing',
				seriesId,
				episodeId: episodeBId,
				status: 'no_results',
				releasesFound: 0,
				executedAt: new Date().toISOString()
			}
		]);

		const service = ActivityService.getInstance();
		const result = await service.fetchSearchActivity({});
		expect(result.total).toBe(2);
	});

	it('filters by status and reflects the filtered total, not the unfiltered one', async () => {
		const movieId = await seedMovie('Status Filtered Movie');
		await seedHistoryRow(movieId, { status: 'grabbed', releasesFound: 1 });
		await seedHistoryRow(movieId, { status: 'no_results' });
		await seedHistoryRow(movieId, { status: 'no_results' });

		const service = ActivityService.getInstance();
		const result = await service.fetchSearchActivity({ status: 'grabbed' });
		expect(result.total).toBe(1);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].status).toBe('grabbed');
	});

	it('filters by the resolved media title, not a raw column (title is joined in, not stored on monitoringHistory)', async () => {
		const movieAId = await seedMovie('Avatar: Seven Havens');
		const movieBId = await seedMovie('Completely Different Title');
		await seedHistoryRow(movieAId);
		await seedHistoryRow(movieBId);

		const service = ActivityService.getInstance();
		const result = await service.fetchSearchActivity({ search: 'seven havens' });
		expect(result.total).toBe(1);
		expect(result.items[0].mediaTitle).toBe('Avatar: Seven Havens');
	});

	it('sorts by releasesFound in the requested direction', async () => {
		// Distinct movies - sorting is only meaningful across different items
		// once same-item attempts are collapsed to one row each.
		await seedHistoryRow(await seedMovie('Sortable Movie A'), { releasesFound: 3 });
		await seedHistoryRow(await seedMovie('Sortable Movie B'), { releasesFound: 1 });
		await seedHistoryRow(await seedMovie('Sortable Movie C'), { releasesFound: 2 });

		const service = ActivityService.getInstance();
		const asc = await service.fetchSearchActivity({ sort: 'releasesFound', order: 'asc' });
		expect(asc.items.map((i) => i.releasesFound)).toEqual([1, 2, 3]);

		const desc = await service.fetchSearchActivity({ sort: 'releasesFound', order: 'desc' });
		expect(desc.items.map((i) => i.releasesFound)).toEqual([3, 2, 1]);
	});

	it('surfaces the movie consecutive failure count, for the Searches tab Failures column', async () => {
		const movieId = await seedMovie('Repeatedly Failing Movie');
		await testDb.db
			.update(movies)
			.set({ consecutiveFailureCount: 3 })
			.where(eq(movies.id, movieId));
		await seedHistoryRow(movieId);

		const service = ActivityService.getInstance();
		const result = await service.fetchSearchActivity({});
		expect(result.items[0].consecutiveFailureCount).toBe(3);
		expect(result.items[0].movieId).toBe(movieId);
	});

	it("resolves the movie's quality/scoring profile name, for the Searches tab Quality Profile column", async () => {
		const profileId = randomUUID();
		await testDb.db.insert(scoringProfiles).values({ id: profileId, name: 'Balanced' });
		const movieId = randomUUID();
		await testDb.db.insert(movies).values({
			id: movieId,
			tmdbId: 500,
			title: 'Profiled Movie',
			path: `/movies/${movieId}`,
			scoringProfileId: profileId
		});
		await seedHistoryRow(movieId);

		const service = ActivityService.getInstance();
		const result = await service.fetchSearchActivity({});
		expect(result.items[0].qualityProfileName).toBe('Balanced');
	});

	it("resolves an episode's quality/scoring profile name from its series, and the task-type label", async () => {
		const profileId = randomUUID();
		await testDb.db.insert(scoringProfiles).values({ id: profileId, name: 'Streamer' });
		const seriesId = randomUUID();
		await testDb.db.insert(series).values({
			id: seriesId,
			tmdbId: 501,
			title: 'Profiled Series',
			path: `/tv/${seriesId}`,
			scoringProfileId: profileId
		});
		const episodeId = randomUUID();
		await testDb.db
			.insert(episodes)
			.values({ id: episodeId, seriesId, seasonNumber: 1, episodeNumber: 1 });
		await testDb.db.insert(monitoringHistory).values({
			taskType: 'missing',
			seriesId,
			episodeId,
			status: 'no_results',
			releasesFound: 0,
			executedAt: new Date().toISOString()
		});

		const service = ActivityService.getInstance();
		const result = await service.fetchSearchActivity({});
		expect(result.items[0].qualityProfileName).toBe('Streamer');
		expect(result.items[0].taskType).toBe('missing');
	});

	it('returns a null quality profile name when none is assigned', async () => {
		const movieId = await seedMovie('Unprofiled Movie');
		await seedHistoryRow(movieId);

		const service = ActivityService.getInstance();
		const result = await service.fetchSearchActivity({});
		expect(result.items[0].qualityProfileName).toBeNull();
	});

	it('filters to only paused items when pausedOnly is set', async () => {
		const pausedId = await seedMovie('Paused Movie');
		const activeId = await seedMovie('Active Movie');
		await testDb.db.update(movies).set({ autoSearchPaused: true }).where(eq(movies.id, pausedId));
		await seedHistoryRow(pausedId);
		await seedHistoryRow(activeId);

		const service = ActivityService.getInstance();
		const result = await service.fetchSearchActivity({ pausedOnly: true });
		expect(result.total).toBe(1);
		expect(result.items[0].movieId).toBe(pausedId);

		const unfiltered = await service.fetchSearchActivity({});
		expect(unfiltered.total).toBe(2);
	});

	it('computes nextAttempt from lastSearchTime and the configured interval', async () => {
		await testDb.db
			.insert(monitoringSettings)
			.values({ key: 'missing_search_interval_hours', value: '2' });

		const movieId = await seedMovie('Scheduled Movie');
		const lastSearch = new Date();
		lastSearch.setHours(lastSearch.getHours() - 1);
		await testDb.db
			.update(movies)
			.set({ lastSearchTime: lastSearch.toISOString() })
			.where(eq(movies.id, movieId));
		await seedHistoryRow(movieId);

		const service = ActivityService.getInstance();
		const result = await service.fetchSearchActivity({});
		expect(result.items[0].nextAttempt).not.toBeNull();
		const expected = new Date(lastSearch.getTime() + 2 * 60 * 60 * 1000);
		expect(new Date(result.items[0].nextAttempt!).getTime()).toBeCloseTo(expected.getTime(), -2);
	});

	it('returns a null nextAttempt for an item that has never been searched', async () => {
		const movieId = await seedMovie('Never Searched Movie');
		await seedHistoryRow(movieId);

		const service = ActivityService.getInstance();
		const result = await service.fetchSearchActivity({});
		expect(result.items[0].nextAttempt).toBeNull();
	});

	it('surfaces isUpgrade/oldScore/newScore for an upgrade search attempt', async () => {
		const movieId = await seedMovie('Upgraded Movie');
		await seedHistoryRow(movieId, {
			taskType: 'upgrade',
			status: 'grabbed',
			releasesFound: 1,
			isUpgrade: true,
			oldScore: 50,
			newScore: 90
		});

		const service = ActivityService.getInstance();
		const result = await service.fetchSearchActivity({});
		expect(result.items[0].isUpgrade).toBe(true);
		expect(result.items[0].oldScore).toBe(50);
		expect(result.items[0].newScore).toBe(90);
	});
});

describe('ActivityService.resetFailureCounts', () => {
	it('clears the counter for the given movies, leaving other movies untouched', async () => {
		const targetId = await seedMovie('Target Movie');
		const otherId = await seedMovie('Other Movie');
		await testDb.db
			.update(movies)
			.set({ consecutiveFailureCount: 4 })
			.where(eq(movies.id, targetId));
		await testDb.db
			.update(movies)
			.set({ consecutiveFailureCount: 4 })
			.where(eq(movies.id, otherId));

		const service = ActivityService.getInstance();
		await service.resetFailureCounts([targetId], []);

		const [target] = await testDb.db.select().from(movies).where(eq(movies.id, targetId));
		const [other] = await testDb.db.select().from(movies).where(eq(movies.id, otherId));
		expect(target.consecutiveFailureCount).toBe(0);
		expect(other.consecutiveFailureCount).toBe(4);
	});

	it('clears the counter for the given episodes', async () => {
		const seriesId = randomUUID();
		await testDb.db
			.insert(series)
			.values({ id: seriesId, tmdbId: 99, title: 'Target Series', path: `/tv/${seriesId}` });

		const targetEpisodeId = randomUUID();
		const otherEpisodeId = randomUUID();
		await testDb.db.insert(episodes).values([
			{
				id: targetEpisodeId,
				seriesId,
				seasonNumber: 1,
				episodeNumber: 1,
				consecutiveFailureCount: 5
			},
			{
				id: otherEpisodeId,
				seriesId,
				seasonNumber: 1,
				episodeNumber: 2,
				consecutiveFailureCount: 5
			}
		]);

		const service = ActivityService.getInstance();
		await service.resetFailureCounts([], [targetEpisodeId]);

		const [target] = await testDb.db
			.select()
			.from(episodes)
			.where(eq(episodes.id, targetEpisodeId));
		const [other] = await testDb.db.select().from(episodes).where(eq(episodes.id, otherEpisodeId));
		expect(target.consecutiveFailureCount).toBe(0);
		expect(other.consecutiveFailureCount).toBe(5);
	});

	it('does nothing when both id lists are empty', async () => {
		const service = ActivityService.getInstance();
		await expect(service.resetFailureCounts([], [])).resolves.toBeUndefined();
	});
});

describe('ActivityService.setAutoSearchPaused', () => {
	it('pauses and resumes a movie without touching other movies', async () => {
		const targetId = await seedMovie('Target Movie');
		const otherId = await seedMovie('Other Movie');

		const service = ActivityService.getInstance();
		await service.setAutoSearchPaused({ movieIds: [targetId] }, true);

		const [target] = await testDb.db.select().from(movies).where(eq(movies.id, targetId));
		const [other] = await testDb.db.select().from(movies).where(eq(movies.id, otherId));
		expect(target.autoSearchPaused).toBe(true);
		expect(other.autoSearchPaused).toBe(false);

		await service.setAutoSearchPaused({ movieIds: [targetId] }, false);
		const [resumed] = await testDb.db.select().from(movies).where(eq(movies.id, targetId));
		expect(resumed.autoSearchPaused).toBe(false);
	});

	it('pauses an episode', async () => {
		const seriesId = randomUUID();
		await testDb.db
			.insert(series)
			.values({ id: seriesId, tmdbId: 99, title: 'Target Series', path: `/tv/${seriesId}` });
		const episodeId = randomUUID();
		await testDb.db
			.insert(episodes)
			.values({ id: episodeId, seriesId, seasonNumber: 1, episodeNumber: 1 });

		const service = ActivityService.getInstance();
		await service.setAutoSearchPaused({ episodeIds: [episodeId] }, true);

		const [episode] = await testDb.db.select().from(episodes).where(eq(episodes.id, episodeId));
		expect(episode.autoSearchPaused).toBe(true);
	});

	it('pauses multiple movies and episodes in one call (bulk pause/resume)', async () => {
		const movieAId = await seedMovie('Bulk Movie A');
		const movieBId = await seedMovie('Bulk Movie B');
		const seriesId = randomUUID();
		await testDb.db
			.insert(series)
			.values({ id: seriesId, tmdbId: 100, title: 'Bulk Series', path: `/tv/${seriesId}` });
		const episodeId = randomUUID();
		await testDb.db
			.insert(episodes)
			.values({ id: episodeId, seriesId, seasonNumber: 1, episodeNumber: 1 });

		const service = ActivityService.getInstance();
		await service.setAutoSearchPaused(
			{ movieIds: [movieAId, movieBId], episodeIds: [episodeId] },
			true
		);

		const [movieA] = await testDb.db.select().from(movies).where(eq(movies.id, movieAId));
		const [movieB] = await testDb.db.select().from(movies).where(eq(movies.id, movieBId));
		const [episode] = await testDb.db.select().from(episodes).where(eq(episodes.id, episodeId));
		expect(movieA.autoSearchPaused).toBe(true);
		expect(movieB.autoSearchPaused).toBe(true);
		expect(episode.autoSearchPaused).toBe(true);

		await service.setAutoSearchPaused(
			{ movieIds: [movieAId, movieBId], episodeIds: [episodeId] },
			false
		);
		const [movieAResumed] = await testDb.db.select().from(movies).where(eq(movies.id, movieAId));
		expect(movieAResumed.autoSearchPaused).toBe(false);
	});
});

describe('ActivityService.fetchSearchItemDetail', () => {
	it('returns null when neither movieId nor episodeId is given', async () => {
		const service = ActivityService.getInstance();
		await expect(service.fetchSearchItemDetail({})).resolves.toBeNull();
	});

	it('returns null for an unknown movie id', async () => {
		const service = ActivityService.getInstance();
		await expect(service.fetchSearchItemDetail({ movieId: randomUUID() })).resolves.toBeNull();
	});

	it('resolves attempts, paused flag, quality profile, and timeline for a movie', async () => {
		const profileId = randomUUID();
		await testDb.db.insert(scoringProfiles).values({ id: profileId, name: 'Balanced' });

		const movieId = randomUUID();
		await testDb.db.insert(movies).values({
			id: movieId,
			tmdbId: 123,
			title: 'Repeatedly Failing Movie',
			path: `/movies/${movieId}`,
			scoringProfileId: profileId,
			consecutiveFailureCount: 3,
			autoSearchPaused: true,
			lastSearchTime: new Date(2026, 0, 1, 0, 0).toISOString()
		});
		await seedHistoryRow(movieId, { executedAt: new Date(2026, 0, 1, 0, 0).toISOString() });
		await seedHistoryRow(movieId, { executedAt: new Date(2026, 0, 2, 0, 0).toISOString() });

		const service = ActivityService.getInstance();
		const detail = await service.fetchSearchItemDetail({ movieId });

		expect(detail).not.toBeNull();
		expect(detail!.mediaType).toBe('movie');
		expect(detail!.mediaTitle).toBe('Repeatedly Failing Movie');
		expect(detail!.qualityProfileName).toBe('Balanced');
		expect(detail!.consecutiveFailureCount).toBe(3);
		expect(detail!.maxConsecutiveFailures).toBeGreaterThan(0);
		expect(detail!.paused).toBe(true);
		expect(detail!.firstAttempt).toBe(new Date(2026, 0, 1, 0, 0).toISOString());
		expect(detail!.lastAttempt).toBe(new Date(2026, 0, 1, 0, 0).toISOString());
		expect(detail!.timeline).toHaveLength(2);
	});

	it('computes nextAttempt from the configured missing_search_interval_hours setting', async () => {
		await testDb.db
			.insert(monitoringSettings)
			.values({ key: 'missing_search_interval_hours', value: '2' });

		const movieId = randomUUID();
		const lastSearch = new Date();
		lastSearch.setHours(lastSearch.getHours() - 1);
		await testDb.db.insert(movies).values({
			id: movieId,
			tmdbId: 456,
			title: 'Recently Searched Movie',
			path: `/movies/${movieId}`,
			lastSearchTime: lastSearch.toISOString()
		});

		const service = ActivityService.getInstance();
		const detail = await service.fetchSearchItemDetail({ movieId });

		expect(detail!.nextAttempt).not.toBeNull();
		const expected = new Date(lastSearch.getTime() + 2 * 60 * 60 * 1000);
		expect(new Date(detail!.nextAttempt!).getTime()).toBeCloseTo(expected.getTime(), -2);
	});

	it('returns a null nextAttempt once the cooldown has already passed', async () => {
		const movieId = randomUUID();
		const lastSearch = new Date();
		lastSearch.setDate(lastSearch.getDate() - 5);
		await testDb.db.insert(movies).values({
			id: movieId,
			tmdbId: 789,
			title: 'Long Ago Movie',
			path: `/movies/${movieId}`,
			lastSearchTime: lastSearch.toISOString()
		});

		const service = ActivityService.getInstance();
		const detail = await service.fetchSearchItemDetail({ movieId });

		expect(detail!.nextAttempt).toBeNull();
	});
});
