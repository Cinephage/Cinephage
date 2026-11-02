/**
 * Isolated tests for /api/user/sessions.
 *
 * The endpoint is self-scoped by locals.user.id; these tests prove a user
 * can only ever see and revoke their own sessions, never another account's,
 * and that the current session is exempt from revocation.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper';
import { session, user } from '#lib/server/db/schema.js';
import { createTestSession, createTestUser } from '../../../../test/fixtures/auth.js';
import { callHandler } from '../../../../test/api-helper';

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

const { GET, DELETE } = await import('./+server.js');

// Matches the synthetic viewer the api-helper injects for auth: 'user'.
const VIEWER_ID = 'test-user-user';
const ADMIN_ID = 'test-admin-user';
const OPTIONS = {
	auth: 'user' as const,
	url: 'http://localhost/api/user/sessions'
};

let currentToken: string;
let otherToken: string;
let foreignTokenA: string;
let foreignTokenB: string;

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(() => {
	clearTestDb(testDb);
	// clearTestDb covers media tables; the auth tables are managed here since
	// only this suite seeds them (sessions first: user has cascade children).
	testDb.db.delete(session).run();
	testDb.db.delete(user).run();

	currentToken = randomUUID();
	otherToken = randomUUID();
	foreignTokenA = randomUUID();
	foreignTokenB = randomUUID();

	testDb.db
		.insert(user)
		.values([
			createTestUser({
				id: VIEWER_ID,
				username: 'viewer',
				role: 'user',
				email: 'viewer@test.local'
			}),
			createTestUser({
				id: ADMIN_ID,
				username: 'otheradmin',
				role: 'admin',
				email: 'otheradmin@test.local'
			})
		])
		.run();

	testDb.db
		.insert(session)
		.values([
			createTestSession({ userId: VIEWER_ID, token: currentToken, userAgent: 'Mozilla Chrome' }),
			createTestSession({ userId: VIEWER_ID, token: otherToken, userAgent: 'Firefox' }),
			// Another account's sessions must never be visible or revocable.
			createTestSession({ userId: ADMIN_ID, token: foreignTokenA }),
			createTestSession({ userId: ADMIN_ID, token: foreignTokenB })
		])
		.run();
});

function remainingTokens(): string[] {
	return testDb.db
		.select({ token: session.token })
		.from(session)
		.all()
		.map((row) => row.token);
}

describe('GET /api/user/sessions', () => {
	it('lists only the caller own sessions and marks the current one', async () => {
		const { status, data } = await callHandler<{
			sessions: Array<{ current: boolean; token?: string }>;
		}>(GET, 'GET', undefined, { ...OPTIONS, sessionToken: currentToken });

		expect(status).toBe(200);
		expect(data.sessions).toHaveLength(2);
		expect(data.sessions.filter((row) => row.current)).toHaveLength(1);
		// Tokens never leave the server.
		for (const row of data.sessions) {
			expect(row.token).toBeUndefined();
		}
	});

	it('rejects unauthenticated callers', async () => {
		const { status } = await callHandler(GET, 'GET', undefined, { url: OPTIONS.url });
		expect(status).toBe(401);
	});
});

describe('DELETE /api/user/sessions', () => {
	it('revokes one other own session but keeps the current one', async () => {
		const otherRow = testDb.db
			.select()
			.from(session)
			.all()
			.find((row) => row.token === otherToken)!;

		const { status } = await callHandler(
			DELETE,
			'DELETE',
			{ sessionId: otherRow.id },
			{
				...OPTIONS,
				sessionToken: currentToken
			}
		);
		expect(status).toBe(200);

		const tokens = remainingTokens();
		expect(tokens).toHaveLength(3);
		expect(tokens).toContain(currentToken);
		expect(tokens).not.toContain(otherToken);
	});

	it('cannot revoke another account session even with a known id', async () => {
		const foreignRow = testDb.db
			.select()
			.from(session)
			.all()
			.find((row) => row.token === foreignTokenA)!;

		const { status } = await callHandler(
			DELETE,
			'DELETE',
			{ sessionId: foreignRow.id },
			{
				...OPTIONS,
				sessionToken: currentToken
			}
		);
		expect(status).toBe(404);
		expect(remainingTokens()).toHaveLength(4);
	});

	it('cannot revoke the current session', async () => {
		const currentRow = testDb.db
			.select()
			.from(session)
			.all()
			.find((row) => row.token === currentToken)!;

		const { status } = await callHandler(
			DELETE,
			'DELETE',
			{ sessionId: currentRow.id },
			{
				...OPTIONS,
				sessionToken: currentToken
			}
		);
		expect(status).toBe(404);
		expect(remainingTokens()).toHaveLength(4);
	});

	it('revokes all other own sessions with an empty body', async () => {
		const { status } = await callHandler(
			DELETE,
			'DELETE',
			{},
			{
				...OPTIONS,
				sessionToken: currentToken
			}
		);
		expect(status).toBe(200);

		const tokens = remainingTokens();
		expect(tokens).toHaveLength(3); // current own + both foreign
		expect(tokens).toContain(currentToken);
	});

	it('rejects an invalid body instead of falling back to revoke-all', async () => {
		const { status } = await callHandler(
			DELETE,
			'DELETE',
			{ sessionId: 42 },
			{
				...OPTIONS,
				sessionToken: currentToken
			}
		);
		expect(status).toBe(400);
		expect(remainingTokens()).toHaveLength(4);
	});
});
