/**
 * Tests for the per-user preferences service and its HTTP surface.
 *
 * The DB is real so scoping, upsert, and defaults-on-corruption are
 * exercised for truth. Proves the security invariants: rows are keyed by
 * the caller's userId, unknown keys are refused at the route, and a
 * corrupt stored value degrades to schema defaults instead of failing.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper';
import { user, userPreferences } from '#lib/server/db/schema.js';
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

const { getUserPreference, setUserPreference, isPreferenceKey } =
	await import('./user-preferences.js');
const { GET, PUT } = await import('../../../routes/api/user/preferences/[key]/+server.js');

let userId: string;
let otherUserId: string;

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(userPreferences).run();
	testDb.db.delete(user).run();
	userId = randomUUID();
	otherUserId = randomUUID();
	testDb.db
		.insert(user)
		.values([
			createTestUser({ id: userId, username: 'prefuser', email: 'pref@test.local' }),
			createTestUser({ id: otherUserId, username: 'otheruser', email: 'other@test.local' })
		])
		.run();
});

describe('user preference service', () => {
	it('returns schema defaults when unset and persists an upsert', async () => {
		const defaults = await getUserPreference(userId, 'calendar');
		expect(defaults).toMatchObject({ contentType: 'all', viewMode: 'grid' });

		await setUserPreference(userId, 'calendar', {
			contentType: 'movies',
			libraryOnly: false,
			upcomingShowNonLibrary: true,
			viewMode: 'list',
			minRating: 7,
			genreIds: [28],
			excludeAdult: true,
			certifications: ['R']
		});
		const saved = await getUserPreference(userId, 'calendar');
		expect(saved).toMatchObject({ contentType: 'movies', viewMode: 'list', minRating: 7 });

		// Upsert, not duplicate.
		expect(testDb.db.select().from(userPreferences).all()).toHaveLength(1);
	});

	it('scopes rows by user: another account sees defaults', async () => {
		await setUserPreference(userId, 'theme', 'cupcake');
		expect(await getUserPreference(otherUserId, 'theme')).toBeNull();
		expect(await getUserPreference(userId, 'theme')).toBe('cupcake');
	});

	it('degrades a corrupt stored value to defaults', async () => {
		testDb.db
			.insert(userPreferences)
			.values({ userId, key: 'theme', value: 'not-a-real-theme' })
			.run();
		expect(await getUserPreference(userId, 'theme')).toBeNull();
	});

	it('restricts keys to the registry', () => {
		expect(isPreferenceKey('calendar')).toBe(true);
		expect(isPreferenceKey('theme')).toBe(true);
		expect(isPreferenceKey('arbitrary')).toBe(false);
	});
});

describe('preferences route contract', () => {
	function makeEvent(
		method: 'GET' | 'PUT',
		key: string,
		body?: unknown,
		userIdOverride?: string | null
	): Parameters<typeof GET>[0] {
		const locals = {
			user: {
				id: userIdOverride ?? userId,
				name: 'Test',
				email: 'pref@test.local',
				emailVerified: false,
				image: null,
				username: 'prefuser',
				displayUsername: 'Test',
				role: 'user',
				language: 'en',
				banned: false,
				banReason: null,
				banExpires: null,
				createdAt: new Date(),
				updatedAt: new Date()
			}
		} as never;
		return {
			locals,
			params: { key },
			request: new Request(`http://localhost/api/user/preferences/${key}`, {
				method,
				headers: { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			})
		} as never;
	}

	it('round-trips a value and rejects unknown keys', async () => {
		const put = await PUT(makeEvent('PUT', 'theme', { value: 'cupcake' }));
		expect(put.status).toBe(200);

		const got = await GET(makeEvent('GET', 'theme'));
		const body = (await got.json()) as { value: string };
		expect(body.value).toBe('cupcake');

		const missing = await GET(makeEvent('GET', 'not-a-key'));
		expect(missing.status).toBe(404);
	});

	it('rejects invalid values with 400', async () => {
		const bad = await PUT(makeEvent('PUT', 'theme', { value: 42 }));
		expect(bad.status).toBe(400);
	});
});
