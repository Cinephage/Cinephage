import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper';
import { subtitleSearchState } from '#lib/server/db/schema.js';

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

vi.mock('#lib/logging/index.js', () => {
	const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	return { createChildLogger: vi.fn(() => logger) };
});

const {
	isSearchActive,
	getSearchStates,
	filterSearchEligible,
	recordSearchFailure,
	resetSearchFailure,
	ADAPTIVE_SEARCH_DELAY_DAYS,
	ADAPTIVE_SEARCH_DELTA_DAYS
} = await import('./subtitle-search-state.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const KEY_A = 'en|regular|any';
const KEY_B = 'en|forced|any';

beforeEach(() => {
	testDb.db.delete(subtitleSearchState).run();
});

afterAll(() => destroyTestDb(testDb));

describe('isSearchActive policy', () => {
	it('is active with no state or no failures', () => {
		expect(isSearchActive(null, NOW)).toBe(true);
		expect(isSearchActive(undefined, NOW)).toBe(true);
		expect(
			isSearchActive(
				{
					failedAttempts: 0,
					firstSearchAt: new Date(NOW - 90 * DAY).toISOString(),
					lastSearchAt: null
				},
				NOW
			)
		).toBe(true);
	});

	it('is active during the 21-day grace window from the first attempt', () => {
		expect(
			isSearchActive(
				{
					failedAttempts: 5,
					firstSearchAt: new Date(NOW - (ADAPTIVE_SEARCH_DELAY_DAYS - 1) * DAY).toISOString(),
					lastSearchAt: new Date(NOW - 1 * DAY).toISOString()
				},
				NOW
			)
		).toBe(true);
	});

	it('throttles to once per 7 days after the grace window', () => {
		const firstSearchAt = new Date(NOW - 30 * DAY).toISOString();
		expect(
			isSearchActive(
				{
					failedAttempts: 10,
					firstSearchAt,
					lastSearchAt: new Date(NOW - (ADAPTIVE_SEARCH_DELTA_DAYS - 1) * DAY).toISOString()
				},
				NOW
			)
		).toBe(false);
		expect(
			isSearchActive(
				{
					failedAttempts: 10,
					firstSearchAt,
					lastSearchAt: new Date(NOW - (ADAPTIVE_SEARCH_DELTA_DAYS + 1) * DAY).toISOString()
				},
				NOW
			)
		).toBe(true);
	});

	it('allows search when timestamps are unparseable', () => {
		expect(
			isSearchActive({ failedAttempts: 3, firstSearchAt: 'not-a-date', lastSearchAt: null }, NOW)
		).toBe(true);
		expect(
			isSearchActive(
				{
					failedAttempts: 3,
					firstSearchAt: new Date(NOW - 30 * DAY).toISOString(),
					lastSearchAt: 'nope'
				},
				NOW
			)
		).toBe(true);
	});
});

describe('per-requirement DB state', () => {
	it('keeps one requirement from gating another', async () => {
		const firstAttempt = new Date(NOW - 2 * DAY);
		await recordSearchFailure('movie', 'movie-1', KEY_A, firstAttempt);
		await recordSearchFailure('movie', 'movie-1', KEY_A, firstAttempt);
		// KEY_B is untouched: no state means active.
		await recordSearchFailure('movie', 'movie-1', KEY_B, firstAttempt);

		const states = await getSearchStates('movie', 'movie-1');
		expect(states.get(KEY_A)?.failedAttempts).toBe(2);
		expect(states.get(KEY_B)?.failedAttempts).toBe(1);
	});

	it('resets only the successful requirement', async () => {
		await recordSearchFailure('episode', 'ep-1', KEY_A);
		await recordSearchFailure('episode', 'ep-1', KEY_B);

		await resetSearchFailure('episode', 'ep-1', KEY_A);

		const states = await getSearchStates('episode', 'ep-1');
		expect(states.get(KEY_A)).toEqual({
			failedAttempts: 0,
			firstSearchAt: null,
			lastSearchAt: expect.any(String)
		});
		expect(states.get(KEY_B)?.failedAttempts).toBe(1);
	});

	it('stamps firstSearchAt once and refreshes lastSearchAt', async () => {
		const first = new Date('2026-08-01T00:00:00.000Z');
		const second = new Date('2026-08-02T00:00:00.000Z');
		await recordSearchFailure('movie', 'movie-2', KEY_A, first);
		await recordSearchFailure('movie', 'movie-2', KEY_A, second);

		expect((await getSearchStates('movie', 'movie-2')).get(KEY_A)).toEqual({
			failedAttempts: 2,
			firstSearchAt: first.toISOString(),
			lastSearchAt: second.toISOString()
		});
	});

	it('scopes states per owner', async () => {
		await recordSearchFailure('movie', 'movie-3', KEY_A);
		await recordSearchFailure('episode', 'movie-3', KEY_A);

		expect((await getSearchStates('movie', 'movie-3')).size).toBe(1);
		expect((await getSearchStates('episode', 'movie-3')).size).toBe(1);
		expect((await getSearchStates('episode', 'unknown')).size).toBe(0);
	});
});

describe('filterSearchEligible', () => {
	const REQ_A = { tag: 'en', variant: 'regular' as const, accessibility: 'any' as const };
	const REQ_B = { tag: 'en', variant: 'forced' as const, accessibility: 'any' as const };

	it('passes through requirements with no recorded state', async () => {
		const eligible = await filterSearchEligible('movie', 'movie-x', [REQ_A, REQ_B]);
		expect(eligible).toEqual([REQ_A, REQ_B]);
	});

	it('drops requirements whose extended backoff window is closed', async () => {
		const old = new Date(NOW - (ADAPTIVE_SEARCH_DELAY_DAYS + 30) * DAY);
		const recent = new Date(NOW - 1 * DAY);
		// REQ_A: long-failing and searched recently → window closed.
		await recordSearchFailure('movie', 'movie-y', KEY_A, old);
		await recordSearchFailure('movie', 'movie-y', KEY_A, recent);
		// REQ_B: failing but still inside the grace window → active.
		await recordSearchFailure('movie', 'movie-y', KEY_B, new Date(NOW - 2 * DAY));

		const eligible = await filterSearchEligible('movie', 'movie-y', [REQ_A, REQ_B]);
		expect(eligible).toEqual([REQ_B]);
	});

	it('keeps requirements reset by a successful download', async () => {
		const old = new Date(NOW - (ADAPTIVE_SEARCH_DELAY_DAYS + 30) * DAY);
		await recordSearchFailure('episode', 'ep-z', KEY_A, old);
		await recordSearchFailure('episode', 'ep-z', KEY_A, old);
		await resetSearchFailure('episode', 'ep-z', KEY_A);

		const eligible = await filterSearchEligible('episode', 'ep-z', [REQ_A]);
		expect(eligible).toEqual([REQ_A]);
	});
});
