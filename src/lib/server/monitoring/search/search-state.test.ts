import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { createTestDb, destroyTestDb } from '../../../../test/db-helper.js';

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

import { movies, searchState } from '#lib/server/db/schema.js';
import {
	SEARCH_POLICY_DEFAULTS,
	attemptBudget,
	delayHoursForAttempt,
	evaluateSearchGate,
	getSearchPolicy,
	getSearchState,
	listSearchStates,
	pauseSearchState,
	recordAttempt,
	recordOutcome,
	resetSearchState,
	resumeSearchState,
	updateSearchPolicy,
	type SearchPolicy,
	type SearchStateRow
} from './search-state.js';

const POLICY: SearchPolicy = { ...SEARCH_POLICY_DEFAULTS };

let nextTmdbId = 500001;

function insertMovie(id: string) {
	testDb.db
		.insert(movies)
		.values({
			id,
			tmdbId: nextTmdbId++,
			title: `Movie ${id}`,
			originalTitle: `Movie ${id}`,
			originalLanguage: 'en',
			path: id,
			languageProfileId: null
		})
		.run();
}

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(() => {
	testDb.db.delete(searchState).run();
	testDb.db.delete(movies).run();
});

describe('retry policy arithmetic', () => {
	it('starts at the minimum delay and backs off, capped', () => {
		expect(delayHoursForAttempt(0, POLICY)).toBe(0);
		expect(delayHoursForAttempt(1, POLICY)).toBe(6);
		expect(delayHoursForAttempt(2, POLICY)).toBe(12);
		expect(delayHoursForAttempt(3, POLICY)).toBe(24);
		expect(delayHoursForAttempt(4, POLICY)).toBe(48);
		expect(delayHoursForAttempt(5, POLICY)).toBe(96);
		// Capped: 6 * 2^5 would be 192.
		expect(delayHoursForAttempt(6, POLICY)).toBe(168);
		expect(delayHoursForAttempt(60, POLICY)).toBe(168);
	});

	it('gives new_episode its own, larger budget', () => {
		expect(attemptBudget('missing', POLICY)).toBe(6);
		expect(attemptBudget('upgrade', POLICY)).toBe(6);
		expect(attemptBudget('new_episode', POLICY)).toBe(48);
	});
});

describe('evaluateSearchGate', () => {
	function row(overrides: Partial<SearchStateRow> = {}): SearchStateRow {
		return {
			ownerType: 'movie',
			ownerId: 'm1',
			searchKind: 'missing',
			status: 'idle',
			attempts: 0,
			firstAttemptAt: null,
			lastAttemptAt: null,
			nextAttemptAt: null,
			lastOutcome: null,
			lastIndexerId: null,
			lastIndexerName: null,
			indexersQueried: 0,
			pausedUntil: null,
			pauseReason: null,
			updatedAt: new Date().toISOString(),
			...overrides
		};
	}

	it('allows an item that has never been tried', () => {
		expect(evaluateSearchGate(undefined, POLICY, 'missing')).toEqual({ allowed: true });
	});

	it('blocks everything while the global pause is on', () => {
		const gate = evaluateSearchGate(undefined, { ...POLICY, paused: true }, 'missing');
		expect(gate.allowed).toBe(false);
		expect(gate.reason).toContain('paused');
	});

	it('blocks once the attempt budget is spent', () => {
		const gate = evaluateSearchGate(row({ attempts: 6 }), POLICY, 'missing');
		expect(gate.allowed).toBe(false);
		expect(gate.reason).toContain('6/6');
	});

	it('does not exhaust new_episode at the missing budget', () => {
		expect(evaluateSearchGate(row({ attempts: 6, searchKind: 'new_episode' }), POLICY, 'new_episode')).toEqual(
			{ allowed: true }
		);
	});

	it('waits for the next allowed attempt', () => {
		const future = new Date(Date.now() + 3_600_000).toISOString();
		const gate = evaluateSearchGate(row({ attempts: 1, nextAttemptAt: future }), POLICY, 'missing');
		expect(gate.allowed).toBe(false);
		expect(gate.nextAttemptAt).toBe(future);
	});

	it('allows once the next allowed attempt has passed', () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		expect(evaluateSearchGate(row({ attempts: 1, nextAttemptAt: past }), POLICY, 'missing')).toEqual({
			allowed: true
		});
	});

	it('blocks an item the user paused', () => {
		const gate = evaluateSearchGate(
			row({ status: 'paused', pauseReason: 'Paused by the user' }),
			POLICY,
			'missing'
		);
		expect(gate.allowed).toBe(false);
		expect(gate.reason).toBe('Paused by the user');
	});
});

describe('recordAttempt / recordOutcome', () => {
	it('creates the row, stamps the cooldown, and arms the next attempt', async () => {
		insertMovie('m1');

		const attempts = await recordAttempt('movie', 'm1', 'missing', { policy: POLICY });
		expect(attempts).toBe(1);

		const state = await getSearchState('movie', 'm1', 'missing');
		expect(state?.attempts).toBe(1);
		expect(state?.status).toBe('searching');

		const next = Date.parse(state!.nextAttemptAt!);
		const expected = Date.now() + 6 * 3_600_000;
		expect(Math.abs(next - expected)).toBeLessThan(10_000);

		const movie = testDb.db.select().from(movies).all()[0];
		expect(movie.lastSearchTime).toBeTruthy();
	});

	it('increments on the second attempt and widens the delay', async () => {
		insertMovie('m2');
		await recordAttempt('movie', 'm2', 'missing', { policy: POLICY });
		const attempts = await recordAttempt('movie', 'm2', 'missing', { policy: POLICY });

		expect(attempts).toBe(2);
		const state = await getSearchState('movie', 'm2', 'missing');
		const next = Date.parse(state!.nextAttemptAt!);
		expect(Math.abs(next - (Date.now() + 12 * 3_600_000))).toBeLessThan(10_000);
	});

	it('resets the counter on a grab', async () => {
		insertMovie('m3');
		await recordAttempt('movie', 'm3', 'missing', { policy: POLICY });
		await recordAttempt('movie', 'm3', 'missing', { policy: POLICY });

		await recordOutcome('movie', 'm3', 'missing', {
			outcome: 'grabbed',
			policy: POLICY,
			indexerId: 'idx-1',
			indexerName: 'Tracker',
			indexersQueried: 3
		});

		const state = await getSearchState('movie', 'm3', 'missing');
		expect(state?.attempts).toBe(0);
		expect(state?.status).toBe('idle');
		expect(state?.nextAttemptAt).toBeNull();
		expect(state?.lastOutcome).toBe('grabbed');
		expect(state?.lastIndexerName).toBe('Tracker');
	});

	it('marks the item exhausted when the last allowed attempt fails', async () => {
		insertMovie('m4');
		for (let i = 0; i < 6; i++) {
			await recordAttempt('movie', 'm4', 'missing', { policy: POLICY });
		}
		await recordOutcome('movie', 'm4', 'missing', { outcome: 'no_results', policy: POLICY });

		const state = await getSearchState('movie', 'm4', 'missing');
		expect(state?.status).toBe('exhausted');
		expect(state?.attempts).toBe(6);
		expect(evaluateSearchGate(state, POLICY, 'missing').allowed).toBe(false);
	});
});

describe('pause / resume / reset', () => {
	it('pauses an item, then resumes it', async () => {
		insertMovie('m5');
		await recordAttempt('movie', 'm5', 'missing', { policy: POLICY });

		await pauseSearchState('movie', 'm5', 'missing', { reason: 'user asked' });
		let state = await getSearchState('movie', 'm5', 'missing');
		expect(state?.status).toBe('paused');
		expect(evaluateSearchGate(state, POLICY, 'missing').allowed).toBe(false);

		await resumeSearchState('movie', 'm5', 'missing');
		state = await getSearchState('movie', 'm5', 'missing');
		expect(state?.status).toBe('idle');
		expect(state?.nextAttemptAt).toBeNull();
		expect(evaluateSearchGate(state, POLICY, 'missing').allowed).toBe(true);
	});

	it('clears the retry state so the next search is immediate', async () => {
		insertMovie('m6');
		for (let i = 0; i < 6; i++) await recordAttempt('movie', 'm6', 'missing', { policy: POLICY });
		await recordOutcome('movie', 'm6', 'missing', { outcome: 'no_results', policy: POLICY });

		await resetSearchState('movie', 'm6');

		const state = await getSearchState('movie', 'm6', 'missing');
		expect(state?.attempts).toBe(0);
		expect(state?.status).toBe('idle');
		expect(state?.nextAttemptAt).toBeNull();
	});
});

describe('policy persistence', () => {
	it('round-trips through monitoring_settings', async () => {
		const before = await getSearchPolicy();
		expect(before.maxAttempts).toBe(SEARCH_POLICY_DEFAULTS.maxAttempts);
		expect(before.paused).toBe(false);

		await updateSearchPolicy({ maxAttempts: 3, paused: true, minDelayHours: 2 });
		const after = await getSearchPolicy();
		expect(after.maxAttempts).toBe(3);
		expect(after.minDelayHours).toBe(2);
		expect(after.paused).toBe(true);
		// Untouched keys keep their defaults.
		expect(after.maxDelayHours).toBe(SEARCH_POLICY_DEFAULTS.maxDelayHours);

		await updateSearchPolicy({ maxAttempts: SEARCH_POLICY_DEFAULTS.maxAttempts, paused: false, minDelayHours: SEARCH_POLICY_DEFAULTS.minDelayHours });
	});

	it('lists tracked items newest attempt first', async () => {
		insertMovie('m7');
		insertMovie('m8');
		await recordAttempt('movie', 'm7', 'missing', { policy: POLICY, now: new Date('2026-01-01T00:00:00Z') });
		await recordAttempt('movie', 'm8', 'missing', { policy: POLICY, now: new Date('2026-01-02T00:00:00Z') });

		const rows = await listSearchStates();
		expect(rows.map((r) => r.ownerId)).toEqual(['m8', 'm7']);
	});
});
