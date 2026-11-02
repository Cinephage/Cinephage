/**
 * Endpoint tests for per-user request settings: unknown users 404, the
 * update merges partials, null resets back to inherit, and the surface is
 * admin-only.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../../test/db-helper';
import { user, userRequestSettings } from '#lib/server/db/schema.js';
import { createTestUser } from '../../../../../../test/fixtures/auth.js';

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

const ADMIN_ID = 'test-admin-user';
const VIEWER_ID = 'test-user-user';
const URL_BASE = 'http://localhost/api/settings/users';

afterAll(() => destroyTestDb(testDb));

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(userRequestSettings).run();
	testDb.db.delete(user).run();
	testDb.db
		.insert(user)
		.values([
			createTestUser({ id: ADMIN_ID, username: 'admin', email: 'a@test.local', role: 'admin' }),
			createTestUser({ id: VIEWER_ID, username: 'viewer', email: 'v@test.local', role: 'user' })
		])
		.run();
});

async function callJson(
	handler: (event: never) => Response | Promise<Response>,
	method: string,
	body: unknown,
	options: { userId: string; auth?: 'admin' | 'user' | false }
): Promise<{ status: number; data: any }> {
	const { createRequest, createRequestEvent } =
		await import('../../../../../../test/api-helper.js');
	const url = `${URL_BASE}/${options.userId}/request-settings`;
	const request = createRequest(method, body, { url, auth: options.auth ?? 'admin' });
	const event = createRequestEvent(
		request,
		{ userId: options.userId },
		{ url, auth: options.auth ?? 'admin' }
	);
	const response = await handler(event as never);
	const data = await response.json().catch(() => null);
	return { status: response.status, data };
}

describe('/api/settings/users/[userId]/request-settings', () => {
	it('404s an unknown user', async () => {
		const get = await callJson(GET, 'GET', undefined, { userId: 'ghost' });
		expect(get.status).toBe(404);

		const put = await callJson(PUT, 'PUT', { requestsDisabled: true }, { userId: 'ghost' });
		expect(put.status).toBe(404);
	});

	it('returns inherit-everything defaults for a user without overrides', async () => {
		const { status, data } = await callJson(GET, 'GET', undefined, { userId: VIEWER_ID });
		expect(status).toBe(200);
		expect(data.settings).toMatchObject({
			userId: VIEWER_ID,
			requestsDisabled: false,
			autoApprove: null,
			movieQuotaLimit: null,
			tvQuotaDays: null
		});
	});

	it('saves a partial update and merges later ones', async () => {
		const first = await callJson(
			PUT,
			'PUT',
			{ requestsDisabled: true, autoApprove: true },
			{ userId: VIEWER_ID }
		);
		expect(first.status).toBe(200);
		expect(first.data.settings).toMatchObject({ requestsDisabled: true, autoApprove: true });

		const second = await callJson(PUT, 'PUT', { movieQuotaLimit: 2 }, { userId: VIEWER_ID });
		expect(second.status).toBe(200);
		expect(second.data.settings).toMatchObject({
			requestsDisabled: true,
			autoApprove: true,
			movieQuotaLimit: 2
		});
	});

	it('resets a field to inherit with null', async () => {
		await callJson(PUT, 'PUT', { movieQuotaLimit: 2 }, { userId: VIEWER_ID });
		const reset = await callJson(PUT, 'PUT', { movieQuotaLimit: null }, { userId: VIEWER_ID });
		expect(reset.status).toBe(200);
		expect(reset.data.settings.movieQuotaLimit).toBeNull();
	});

	it('rejects invalid values', async () => {
		const bad = await callJson(PUT, 'PUT', { movieQuotaLimit: -1 }, { userId: VIEWER_ID });
		expect([400, 422]).toContain(bad.status);
	});

	it('is admin-only', async () => {
		const viewerGet = await callJson(GET, 'GET', undefined, { userId: VIEWER_ID, auth: 'user' });
		expect(viewerGet.status).toBe(403);
		const viewerPut = await callJson(PUT, 'PUT', {}, { userId: VIEWER_ID, auth: 'user' });
		expect(viewerPut.status).toBe(403);
	});
});
