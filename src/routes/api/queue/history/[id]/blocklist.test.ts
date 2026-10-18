/**
 * POST /api/queue/history/[id]/blocklist - blocklists a release directly from
 * a download history record, without needing a live queue row. This is the
 * path a failed item in Activity > History actually uses once its queue row
 * is gone.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { api } from '../../../../../test/api-helper';
import { createTestDb, destroyTestDb, clearTestDb } from '../../../../../test/db-helper';
import { downloadHistory, blocklist } from '#lib/server/db/schema.js';

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

const { POST } = await import('./blocklist/+server');

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(() => {
	clearTestDb(testDb);
});

async function insertHistoryRow(overrides: Partial<typeof downloadHistory.$inferInsert> = {}) {
	const id = overrides.id ?? 'history-item-1';
	await testDb.db.insert(downloadHistory).values({
		id,
		title: 'Some.History.Release.2024',
		protocol: 'usenet',
		status: 'failed',
		...overrides
	});
	return id;
}

describe('POST /api/queue/history/[id]/blocklist', () => {
	it('blocklists the release behind a history record with no live queue row', async () => {
		const id = await insertHistoryRow({ movieId: null });

		const { status, data } = await api.post<{ success: boolean; blocklistId: string }>(
			POST,
			undefined,
			{ params: { id } }
		);

		expect(status).toBe(200);
		expect(data.success).toBe(true);

		const entries = await testDb.db
			.select()
			.from(blocklist)
			.where(eq(blocklist.title, 'Some.History.Release.2024'));
		expect(entries).toHaveLength(1);
		expect(entries[0].reason).toBe('manual');
	});

	it('404s for a history id that does not exist', async () => {
		// `error(404, ...)` from @sveltejs/kit throws rather than returning a
		// Response - the api-helper only converts #lib/errors AppErrors, so
		// this (like the route's own production behavior) surfaces as a thrown
		// HttpError-shaped object instead of a normal handler response.
		await expect(
			api.post(POST, undefined, { params: { id: 'does-not-exist' } })
		).rejects.toMatchObject({ status: 404 });
	});
});
