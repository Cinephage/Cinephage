/**
 * Tests for the request-state annotation helpers used by the TMDB proxy and
 * the discover detail loaders: badge vocabulary collapse, status precedence,
 * and own-request attribution.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper';
import { user, movies, series, episodes, requests } from '#lib/server/db/schema.js';
import { createTestUser } from '../../../test/fixtures/auth.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

const { getRequestStateMap, annotateRequestState } = await import('./status.js');

const VIEWER_ID = 'viewer-1';
const OTHER_ID = 'other-1';

function insertRequest(input: {
	tmdbId: number;
	mediaType: 'movie' | 'series';
	status: string;
	requestedBy: string;
}) {
	testDb.db
		.insert(requests)
		.values({
			mediaType: input.mediaType,
			tmdbId: input.tmdbId,
			title: `Title ${input.tmdbId}`,
			status: input.status,
			requestedBy: input.requestedBy
		})
		.run();
}

afterAll(() => destroyTestDb(testDb));

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(requests).run();
	testDb.db.delete(episodes).run();
	testDb.db.delete(movies).run();
	testDb.db.delete(series).run();
	testDb.db.delete(user).run();
	testDb.db
		.insert(user)
		.values([
			createTestUser({ id: VIEWER_ID, username: 'viewer', email: 'v@test.local', role: 'user' }),
			createTestUser({ id: OTHER_ID, username: 'other', email: 'o@test.local', role: 'user' })
		])
		.run();
});

describe('getRequestStateMap', () => {
	it('returns none for ids without requests', async () => {
		const map = await getRequestStateMap([1, 2], 'movie', VIEWER_ID);
		expect(map[1]).toEqual({ requested: 'none', requestId: null, ownRequestId: null });
		expect(map[2]).toEqual({ requested: 'none', requestId: null, ownRequestId: null });
	});

	it('collapses failed to pending and awaiting_target to approved', async () => {
		insertRequest({ tmdbId: 10, mediaType: 'movie', status: 'failed', requestedBy: VIEWER_ID });
		insertRequest({
			tmdbId: 11,
			mediaType: 'movie',
			status: 'awaiting_target',
			requestedBy: VIEWER_ID
		});

		const map = await getRequestStateMap([10, 11], 'movie', VIEWER_ID);
		expect(map[10].requested).toBe('pending');
		expect(map[11].requested).toBe('approved');
	});

	it('applies precedence so fulfilled wins over earlier pending rows', async () => {
		insertRequest({ tmdbId: 20, mediaType: 'movie', status: 'fulfilled', requestedBy: OTHER_ID });
		insertRequest({ tmdbId: 20, mediaType: 'movie', status: 'pending', requestedBy: OTHER_ID });
		const fulfilled = await getRequestStateMap([20], 'movie', null);
		expect(fulfilled[20].requested).toBe('fulfilled');

		insertRequest({ tmdbId: 21, mediaType: 'movie', status: 'pending', requestedBy: OTHER_ID });
		insertRequest({ tmdbId: 21, mediaType: 'movie', status: 'approved', requestedBy: OTHER_ID });
		const approved = await getRequestStateMap([21], 'movie', null);
		expect(approved[21].requested).toBe('pending');
	});

	it('never annotates declined, expired, or cancelled rows', async () => {
		insertRequest({ tmdbId: 30, mediaType: 'movie', status: 'declined', requestedBy: VIEWER_ID });
		insertRequest({ tmdbId: 31, mediaType: 'movie', status: 'expired', requestedBy: VIEWER_ID });
		insertRequest({ tmdbId: 32, mediaType: 'movie', status: 'cancelled', requestedBy: VIEWER_ID });

		const map = await getRequestStateMap([30, 31, 32], 'movie', VIEWER_ID);
		for (const id of [30, 31, 32]) {
			expect(map[id]).toEqual({ requested: 'none', requestId: null, ownRequestId: null });
		}
	});

	it('attributes ownRequestId to the viewing user only', async () => {
		insertRequest({ tmdbId: 40, mediaType: 'movie', status: 'pending', requestedBy: VIEWER_ID });
		insertRequest({ tmdbId: 41, mediaType: 'movie', status: 'pending', requestedBy: OTHER_ID });

		const own = await getRequestStateMap([40, 41], 'movie', VIEWER_ID);
		expect(own[40].ownRequestId).not.toBeNull();
		expect(own[41].ownRequestId).toBeNull();
		// Someone else's active request still badges the title.
		expect(own[41].requested).toBe('pending');

		const anonymous = await getRequestStateMap([40], 'movie', null);
		expect(anonymous[40].ownRequestId).toBeNull();
	});

	it('filters by media type, mapping the tv alias to series rows', async () => {
		insertRequest({ tmdbId: 50, mediaType: 'series', status: 'pending', requestedBy: VIEWER_ID });
		insertRequest({ tmdbId: 50, mediaType: 'movie', status: 'pending', requestedBy: OTHER_ID });

		const tv = await getRequestStateMap([50], 'tv', VIEWER_ID);
		expect(tv[50].requested).toBe('pending');
		expect(tv[50].ownRequestId).not.toBeNull();

		const movie = await getRequestStateMap([50], 'movie', null);
		expect(movie[50].requested).toBe('pending');
	});
});

describe('annotateRequestState', () => {
	it('annotates items with their request state', async () => {
		insertRequest({ tmdbId: 60, mediaType: 'movie', status: 'pending', requestedBy: VIEWER_ID });

		const items = [
			{ id: 60, title: 'Requested' },
			{ id: 61, title: 'Plain' }
		];
		const annotated = await annotateRequestState(items, 'movie', VIEWER_ID);
		expect(annotated[0]).toMatchObject({
			id: 60,
			title: 'Requested',
			requested: 'pending',
			ownRequestId: expect.any(String)
		});
		expect(annotated[1]).toMatchObject({ id: 61, requested: 'none', requestId: null });
	});

	it('returns an empty array untouched', async () => {
		expect(await annotateRequestState([], 'movie', VIEWER_ID)).toEqual([]);
	});
});
