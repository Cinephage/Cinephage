/**
 * Endpoint tests for the global request settings: the shape degrades to
 * defaults when nothing is stored, saves round-trip, and the surface is
 * admin-only.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper';
import { settings, user } from '#lib/server/db/schema.js';
import { createTestUser } from '../../../../test/fixtures/auth.js';

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

const { GET, PUT } = await import('./+server.js');
const { getRequestSettingsService } =
	await import('#lib/server/requests/RequestSettingsService.js');

const ADMIN_ID = 'test-admin-user';

afterAll(() => destroyTestDb(testDb));

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(settings).run();
	testDb.db.delete(user).run();
	testDb.db
		.insert(user)
		.values([
			createTestUser({ id: ADMIN_ID, username: 'admin', email: 'a@test.local', role: 'admin' }),
			createTestUser({
				id: 'test-user-user',
				username: 'viewer',
				email: 'v@test.local',
				role: 'user'
			})
		])
		.run();
	getRequestSettingsService().invalidateCache();
});

async function callJson(
	handler: (event: never) => Response | Promise<Response>,
	method: string,
	body: unknown,
	options: { url?: string; auth?: 'admin' | 'user' | false }
): Promise<{ status: number; data: any }> {
	const { callHandlerRaw } = await import('../../../../test/api-helper.js');
	const { status, response } = await callHandlerRaw(handler as never, method, body, {
		auth: options.auth ?? 'admin',
		url: options.url
	});
	const data = await response.json().catch(() => null);
	return { status, data };
}

describe('/api/settings/request-settings', () => {
	it('returns defaults when nothing is stored', async () => {
		const { status, data } = await callJson(GET, 'GET', undefined, { auth: 'admin' });
		expect(status).toBe(200);
		expect(data.settings).toMatchObject({
			requestsEnabled: true,
			tvQuotaUnit: 'episodes',
			pendingTtlDays: 30,
			reRequestCooldownDays: 7
		});
	});

	it('round-trips a save', async () => {
		const saved = await callJson(
			PUT,
			'PUT',
			{
				defaultQuotas: { movie: { limit: 5, days: 30 }, tv: { limit: null, days: null } },
				pendingTtlDays: 14
			},
			{ auth: 'admin' }
		);
		expect(saved.status).toBe(200);
		expect(saved.data.settings.defaultQuotas.movie).toMatchObject({ limit: 5, days: 30 });
		expect(saved.data.settings.pendingTtlDays).toBe(14);

		getRequestSettingsService().invalidateCache();
		const read = await callJson(GET, 'GET', undefined, { auth: 'admin' });
		expect(read.data.settings.defaultQuotas.movie).toMatchObject({ limit: 5, days: 30 });
	});

	it('rejects invalid values', async () => {
		const bad = await callJson(PUT, 'PUT', { pendingTtlDays: -5 }, { auth: 'admin' });
		expect([400, 422]).toContain(bad.status);
	});

	it('is admin-only', async () => {
		const viewerGet = await callJson(GET, 'GET', undefined, { auth: 'user' });
		expect(viewerGet.status).toBe(403);
		const viewerPut = await callJson(PUT, 'PUT', {}, { auth: 'user' });
		expect(viewerPut.status).toBe(403);
		const anon = await callJson(GET, 'GET', undefined, { auth: false });
		expect([401, 403]).toContain(anon.status);
	});
});
