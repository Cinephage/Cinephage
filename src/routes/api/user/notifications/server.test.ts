/**
 * Endpoint tests for the request notification feed: viewers see only their
 * own rows, the unread count matches, and mark-read honors the explicit
 * no-op contract (empty ids never wipes the badge).
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper';
import { user, requestNotifications } from '#lib/server/db/schema.js';
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

const { GET } = await import('./+server.js');
const { POST: POST_READ } = await import('./read/+server.js');

// api-helper synthesizes these exact ids for auth:'user' / auth:'admin'.
const VIEWER_ID = 'test-user-user';
const OTHER_ID = 'test-admin-user';

afterAll(() => destroyTestDb(testDb));

beforeEach(() => {
	clearTestDb(testDb);
	testDb.db.delete(requestNotifications).run();
	testDb.db.delete(user).run();
	testDb.db
		.insert(user)
		.values([
			createTestUser({ id: VIEWER_ID, username: 'viewer', email: 'v@test.local', role: 'user' }),
			createTestUser({ id: OTHER_ID, username: 'other', email: 'o@test.local', role: 'admin' })
		])
		.run();
});

function insertNotification(userId: string, event: string, read = false) {
	testDb.db
		.insert(requestNotifications)
		.values({
			userId,
			requestId: null,
			event,
			payload: { title: 'Test' },
			readAt: read ? new Date().toISOString() : null
		})
		.run();
}

async function callJson(
	handler: (event: never) => Response | Promise<Response>,
	method: string,
	body: unknown,
	options: { url?: string; auth?: 'admin' | 'user' | false }
): Promise<{ status: number; data: any }> {
	const { callHandlerRaw } = await import('../../../../test/api-helper.js');
	const { status, response } = await callHandlerRaw(handler as never, method, body, {
		auth: options.auth ?? 'user',
		url: options.url
	});
	const data = await response.json().catch(() => null);
	return { status, data };
}

describe('GET /api/user/notifications', () => {
	it('401s unauthenticated', async () => {
		const { status } = await callJson(GET, 'GET', undefined, { auth: false });
		expect(status).toBe(401);
	});

	it("returns only the caller's rows with an accurate unread count", async () => {
		insertNotification(VIEWER_ID, 'request_approved');
		insertNotification(VIEWER_ID, 'request_declined', true);
		insertNotification(OTHER_ID, 'request_pending');

		const { status, data } = await callJson(GET, 'GET', undefined, { auth: 'user' });
		expect(status).toBe(200);
		expect(data.notifications).toHaveLength(2);
		expect(data.notifications.every((n: { userId: string }) => n.userId === VIEWER_ID)).toBe(true);
		expect(data.unreadCount).toBe(1);
	});

	it('honors the unread filter', async () => {
		insertNotification(VIEWER_ID, 'request_approved');
		insertNotification(VIEWER_ID, 'request_declined', true);

		const { data } = await callJson(GET, 'GET', undefined, {
			url: 'http://localhost/api/user/notifications?unread=true'
		});
		expect(data.notifications).toHaveLength(1);
		expect(data.unreadCount).toBe(1);
	});
});

describe('POST /api/user/notifications/read', () => {
	it('marks only the given ids read', async () => {
		insertNotification(VIEWER_ID, 'request_approved');
		const second = testDb.db
			.select()
			.from(requestNotifications)
			.all()
			.find((n) => n.userId === VIEWER_ID)!;
		insertNotification(VIEWER_ID, 'request_declined');
		const all = testDb.db.select().from(requestNotifications).all();
		const target = all.find((n) => n.id !== second.id)!;

		const { status } = await callJson(
			POST_READ,
			'POST',
			{ ids: [target.id] },
			{ url: 'http://localhost/api/user/notifications/read' }
		);
		expect(status).toBe(200);
		const after = testDb.db.select().from(requestNotifications).all();
		expect(after.find((n) => n.id === target.id)?.readAt).not.toBeNull();
		expect(after.find((n) => n.id === second.id)?.readAt).toBeNull();
	});

	it('marks everything when ids is omitted', async () => {
		insertNotification(VIEWER_ID, 'request_approved');
		insertNotification(VIEWER_ID, 'request_declined');

		const { status } = await callJson(
			POST_READ,
			'POST',
			{},
			{ url: 'http://localhost/api/user/notifications/read' }
		);
		expect(status).toBe(200);
		const after = testDb.db.select().from(requestNotifications).all();
		expect(after.every((n) => n.readAt !== null)).toBe(true);
	});

	it('treats an explicit empty selection as a no-op', async () => {
		insertNotification(VIEWER_ID, 'request_approved');

		const { status } = await callJson(
			POST_READ,
			'POST',
			{ ids: [] },
			{ url: 'http://localhost/api/user/notifications/read' }
		);
		expect(status).toBe(200);
		const after = testDb.db.select().from(requestNotifications).all();
		expect(after.every((n) => n.readAt === null)).toBe(true);
	});
});
