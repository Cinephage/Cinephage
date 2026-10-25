/**
 * Integration tests for the REAL Better Auth instance.
 *
 * Every other auth test in the suite mocks `auth`; these tests run the actual
 * betterAuth() construction against a throwaway SQLite database so cookie
 * shapes, plugin wiring, the single-admin database hooks, and the managed
 * API-key lifecycle are exercised end to end. They are the safety net for
 * refactors of the auth layer.
 *
 * Test order matters: the database starts empty, the first test creates the
 * sole admin, and later tests rely on that state (single-admin policy, sign-in).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

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

const harness = await import('../../../test/auth-test-harness.js').then((m) =>
	m.createAuthTestHarness({ withHooks: false })
);
const { db } = await import('#lib/server/db/index.js');
const { user, session, authApiKeys, authRateLimits } = await import('#lib/server/db/schema.js');
const { ensureDefaultApiKeysForUser, getRecoverableApiKeyValue } =
	await import('#lib/server/auth/api-keys.js');

const USERNAME = 'testcurator';
const EMAIL = 'curator@test.local';
const PASSWORD = 'correct-horse-battery';

// Shared across the managed-keys block: ensureDefaultApiKeysForUser is
// idempotent, so only the first call returns the plaintext keys.
let mainKey = '';

beforeEach(() => {
	// Better Auth's database-backed limiter counts every auth request across
	// tests (max 5 per 15 min); reset it so each test measures only itself.
	db.delete(authRateLimits).run();
});

afterAll(() => {
	harness.cleanup();
});

describe('real Better Auth instance — setup and single-admin policy', () => {
	it('signs up the first user as the sole admin via /sign-up/email', async () => {
		const response = await harness.authRequest('/sign-up/email', {
			method: 'POST',
			body: JSON.stringify({
				email: EMAIL,
				password: PASSWORD,
				name: 'Test Curator',
				username: USERNAME
			})
		});

		expect(response.status).toBe(200);

		const row = db.select().from(user).all()[0];
		expect(row).toBeDefined();
		expect(row.email).toBe(EMAIL);
		expect(row.username).toBe(USERNAME);
		expect(row.role).toBe('admin');
	});

	it('rejects a second account with FORBIDDEN once setup is complete', async () => {
		const response = await harness.authRequest('/sign-up/email', {
			method: 'POST',
			body: JSON.stringify({
				email: 'second@test.local',
				password: PASSWORD,
				name: 'Second User',
				username: 'secondcurator'
			})
		});

		expect(response.status).toBe(403);
		const body = (await response.json()) as { message?: string };
		expect(body.message).toContain('Only admins can create');
	});

	it('the first-user claim is exclusive until it goes stale', async () => {
		const { claimFirstUserBootstrap, resetFirstUserClaim } = await import('./setup.js');

		// The sign-up above already claimed the bootstrap; a concurrent
		// request in the same window must lose the race and be treated as
		// non-first (admin-creator requirement -> FORBIDDEN), never as a
		// second admin.
		await expect(claimFirstUserBootstrap()).resolves.toBe(false);

		await resetFirstUserClaim();
		await expect(claimFirstUserBootstrap()).resolves.toBe(true);
		await expect(claimFirstUserBootstrap()).resolves.toBe(false);

		// A claim whose holder died before inserting its user row is
		// recoverable after the staleness window.
		const { sql } = await import('drizzle-orm');
		db.run(
			sql`UPDATE settings SET value = ${String(Date.now() - 11 * 60 * 1000)} WHERE key = 'bootstrap_first_user_claimed_at'`
		);
		await expect(claimFirstUserBootstrap()).resolves.toBe(true);
	});
});

describe('real Better Auth instance — username sign-in and sessions', () => {
	it('issues a session cookie on successful username sign-in', async () => {
		const response = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: USERNAME, password: PASSWORD })
		});

		expect(response.status).toBe(200);
		const cookies = harness.extractCookies(response);
		const sessionCookieName = Object.keys(cookies).find((name) => name.includes('session_token'));
		expect(sessionCookieName).toBeDefined();

		const session = await harness.auth.api.getSession({
			headers: new Headers({ cookie: harness.cookieHeader(cookies) })
		});
		expect(session?.user?.email).toBe(EMAIL);
		expect(session?.user?.username).toBe(USERNAME);
		expect(session?.user?.role).toBe('admin');
	});

	it('rejects a wrong password', async () => {
		const response = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: USERNAME, password: 'wrong-password' })
		});

		expect(response.status).toBe(401);
	});
});

describe('real Better Auth instance — managed API keys', () => {
	it('creates main and streaming keys that round-trip through encrypted recovery', async () => {
		const signIn = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: USERNAME, password: PASSWORD })
		});
		expect(signIn.status).toBe(200);
		const sessionHeaders = new Headers({
			cookie: harness.cookieHeader(harness.extractCookies(signIn))
		});
		const session = await harness.auth.api.getSession({ headers: sessionHeaders });
		expect(session?.user?.id).toBeDefined();

		const keys = await ensureDefaultApiKeysForUser(session!.user.id, sessionHeaders);
		expect(keys.mainKey?.key).toMatch(/^cinephage_/);
		expect(keys.streamingKey?.key).toMatch(/^cinephage_/);
		mainKey = keys.mainKey!.key;

		// The encrypted secret must decrypt back to the plaintext the plugin returned.
		await expect(getRecoverableApiKeyValue(keys.mainKey!.id)).resolves.toBe(keys.mainKey!.key);
		await expect(getRecoverableApiKeyValue(keys.streamingKey!.id)).resolves.toBe(
			keys.streamingKey!.key
		);

		// Permission semantics the streaming gate depends on (hooks.server.ts
		// verifies streaming first, then falls back to the main key).
		const mainAsFull = await harness.auth.api.verifyApiKey({
			body: { key: keys.mainKey!.key, permissions: { default: ['*'] } }
		});
		expect(mainAsFull.valid).toBe(true);

		const streamingAsStreaming = await harness.auth.api.verifyApiKey({
			body: { key: keys.streamingKey!.key, permissions: { streaming: ['*'] } }
		});
		expect(streamingAsStreaming.valid).toBe(true);

		const mainAsStreaming = await harness.auth.api.verifyApiKey({
			body: { key: keys.mainKey!.key, permissions: { streaming: ['*'] } }
		});
		expect(mainAsStreaming.valid).toBe(false);

		const garbage = await harness.auth.api.verifyApiKey({
			body: { key: 'cinephage_not_a_real_key', permissions: { default: ['*'] } }
		});
		expect(garbage.valid).toBe(false);
	});

	it('authenticates getSession with an x-api-key header (enableSessionForAPIKeys)', async () => {
		const signIn = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: USERNAME, password: PASSWORD })
		});
		const sessionHeaders = new Headers({
			cookie: harness.cookieHeader(harness.extractCookies(signIn))
		});
		const session = await harness.auth.api.getSession({ headers: sessionHeaders });

		const apiSession = await harness.auth.api.getSession({
			headers: new Headers({ 'x-api-key': mainKey })
		});
		expect(apiSession?.user?.id).toBe(session!.user.id);
	});

	it('revokes the session on sign-out', async () => {
		const signIn = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: USERNAME, password: PASSWORD })
		});
		const cookies = harness.extractCookies(signIn);
		const cookie = harness.cookieHeader(cookies);
		const sessionCookieName = Object.keys(cookies).find((name) => name.includes('session_token'))!;
		// Signed cookie values are `<token>.<signature>`; the DB stores the bare token.
		const token = cookies[sessionCookieName].split('.')[0];

		const signOut = await harness.authRequest('/sign-out', {
			method: 'POST',
			headers: { cookie }
		});
		expect(signOut.ok).toBe(true);

		// Sign-out deletes the session row and clears the cookie. With the
		// cookie cache disabled, a replayed old cookie value resolves to
		// nothing — revocation is immediate.
		const rows = db.select().from(session).where(eq(session.token, token)).all();
		expect(rows).toHaveLength(0);

		const cleared = harness.extractCookies(signOut)[sessionCookieName];
		expect(cleared ?? '').toBe('');
	});
});

describe('real Better Auth instance — multi-user readiness', () => {
	it('admin plugin createUser adds a user-role account once setup is complete', async () => {
		const signIn = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: USERNAME, password: PASSWORD })
		});
		const sessionHeaders = new Headers({
			cookie: harness.cookieHeader(harness.extractCookies(signIn))
		});

		// The admin plugin's createUser reads the request event internally.
		const created = await harness.withStore(
			harness.makeEvent('POST', '/api/auth/admin/create-user').event,
			() =>
				harness.auth.api.createUser({
					body: {
						email: 'viewer@test.local',
						password: 'viewer-password-123',
						name: 'Test Viewer',
						role: 'user',
						data: { username: 'testviewer' }
					},
					headers: sessionHeaders
				})
		);
		expect(created.user?.id).toBeDefined();

		const rows = db.select().from(user).all();
		expect(rows).toHaveLength(2);
		const viewer = rows.find((row) => row.username === 'testviewer');
		expect(viewer?.role).toBe('user');
	});

	it('rejects account creation without a username (un-loginable account guard)', async () => {
		const signIn = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: USERNAME, password: PASSWORD })
		});
		const sessionHeaders = new Headers({
			cookie: harness.cookieHeader(harness.extractCookies(signIn))
		});

		// A createUser call that drops the `data: { username }` wrapper must
		// not silently produce an account that can never sign in.
		await expect(
			harness.withStore(harness.makeEvent('POST', '/api/auth/admin/create-user').event, () =>
				harness.auth.api.createUser({
					body: {
						email: 'nameless@test.local',
						password: 'nameless-password',
						name: 'Nameless',
						role: 'user'
					},
					headers: sessionHeaders
				})
			)
		).rejects.toThrow(/valid username/i);

		expect(
			db
				.select()
				.from(user)
				.all()
				.find((row) => row.email === 'nameless@test.local')
		).toBeUndefined();
	});

	it('the user-role account signs in and is not silently promoted', async () => {
		const response = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: 'testviewer', password: 'viewer-password-123' })
		});
		expect(response.status).toBe(200);

		const session = await harness.auth.api.getSession({
			headers: new Headers({ cookie: harness.cookieHeader(harness.extractCookies(response)) })
		});
		expect(session?.user?.role).toBe('user');
	});

	it('anonymous self-registration stays closed with multiple accounts present', async () => {
		const response = await harness.authRequest('/sign-up/email', {
			method: 'POST',
			body: JSON.stringify({
				email: 'third@test.local',
				password: PASSWORD,
				name: 'Third User',
				username: 'thirdcurator'
			})
		});
		expect(response.status).toBe(403);
	});
});

describe('real Better Auth instance — last-admin guards', () => {
	// The admin plugin's user endpoints read the request event internally.
	function adminCall() {
		return harness.makeEvent('POST', '/api/auth/admin/set-role').event;
	}

	async function adminSessionHeaders(): Promise<Headers> {
		const signIn = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: USERNAME, password: PASSWORD })
		});
		expect(signIn.status).toBe(200);
		return new Headers({ cookie: harness.cookieHeader(harness.extractCookies(signIn)) });
	}

	function userIdByUsername(username: string): string {
		const row = db
			.select()
			.from(user)
			.all()
			.find((row) => row.username === username);
		expect(row).toBeDefined();
		return row!.id;
	}

	it('blocks demoting the last admin even when viewer accounts exist', async () => {
		const headers = await adminSessionHeaders();
		// One admin (testcurator) + one viewer (testviewer) at this point.
		await expect(
			harness.withStore(adminCall(), () =>
				harness.auth.api.setRole({
					body: { userId: userIdByUsername(USERNAME), role: 'user' },
					headers
				})
			)
		).rejects.toThrow(/only admin/);
	});

	it('blocks an admin from removing themselves (plugin guard; the delete.before hook is defense-in-depth)', async () => {
		const headers = await adminSessionHeaders();
		// Self-removal is refused by the admin plugin itself. Deleting the
		// last admin through another session is unreachable by construction
		// (the caller would need admin permission, so the target would not be
		// the last admin); auth.ts additionally guards the delete.before hook.
		await expect(
			harness.withStore(adminCall(), () =>
				harness.auth.api.removeUser({
					body: { userId: userIdByUsername(USERNAME) },
					headers
				})
			)
		).rejects.toThrow(/remove yourself/i);
	});

	it('allows demoting an admin while another admin remains', async () => {
		const headers = await adminSessionHeaders();
		const created = await harness.withStore(adminCall(), () =>
			harness.auth.api.createUser({
				body: {
					email: 'second-admin@test.local',
					password: 'second-admin-password',
					name: 'Second Admin',
					role: 'admin',
					data: { username: 'secondadmin' }
				},
				headers
			})
		);
		expect(created.user?.id).toBeDefined();

		await harness.withStore(adminCall(), () =>
			harness.auth.api.setRole({
				body: { userId: userIdByUsername(USERNAME), role: 'user' },
				headers
			})
		);
		expect(roleOf(USERNAME)).toBe('user');
	});

	it('allows deleting an admin while another admin remains, and promotion is unrestricted', async () => {
		// Sign in as the remaining admin (secondadmin) to drive the calls.
		const signIn = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: 'secondadmin', password: 'second-admin-password' })
		});
		expect(signIn.status).toBe(200);
		const headers = new Headers({ cookie: harness.cookieHeader(harness.extractCookies(signIn)) });

		// Promote the original account back; promotion has no last-admin guard.
		await harness.withStore(adminCall(), () =>
			harness.auth.api.setRole({
				body: { userId: userIdByUsername(USERNAME), role: 'admin' },
				headers
			})
		);
		expect(roleOf(USERNAME)).toBe('admin');

		// Deleting it is fine: secondadmin still holds the admin role.
		await harness.withStore(adminCall(), () =>
			harness.auth.api.removeUser({
				body: { userId: userIdByUsername(USERNAME) },
				headers
			})
		);
		expect(
			db
				.select()
				.from(user)
				.all()
				.find((row) => row.username === USERNAME)
		).toBeUndefined();
	});
});

describe('real Better Auth instance — ban lifecycle', () => {
	it('a banned viewer cannot sign in until unbanned', async () => {
		const signIn = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: 'secondadmin', password: 'second-admin-password' })
		});
		expect(signIn.status).toBe(200);
		const headers = new Headers({ cookie: harness.cookieHeader(harness.extractCookies(signIn)) });

		const viewerId = db
			.select()
			.from(user)
			.all()
			.find((row) => row.username === 'testviewer')!.id;

		await harness.withStore(harness.makeEvent('POST', '/api/auth/admin/ban-user').event, () =>
			harness.auth.api.banUser({
				body: { userId: viewerId, banReason: 'banned by test' },
				headers
			})
		);

		const bannedSignIn = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: 'testviewer', password: 'viewer-password-123' })
		});
		expect(bannedSignIn.status).toBe(403);

		await harness.withStore(harness.makeEvent('POST', '/api/auth/admin/unban-user').event, () =>
			harness.auth.api.unbanUser({
				body: { userId: viewerId },
				headers
			})
		);

		const unbannedSignIn = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: 'testviewer', password: 'viewer-password-123' })
		});
		expect(unbannedSignIn.status).toBe(200);
	});

	it('banning disables the account API keys and unbanning restores them', async () => {
		const signIn = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: 'secondadmin', password: 'second-admin-password' })
		});
		expect(signIn.status).toBe(200);
		const adminHeaders = new Headers({
			cookie: harness.cookieHeader(harness.extractCookies(signIn))
		});

		const viewerId = db
			.select()
			.from(user)
			.all()
			.find((row) => row.username === 'testviewer')!.id;

		const { createRecoverableApiKey } = await import('./api-keys.js');
		const created = await createRecoverableApiKey({
			userId: viewerId,
			name: 'Viewer main key',
			metadata: { type: 'main' },
			permissions: { default: ['*'] }
		});

		const keysFor = () =>
			db
				.select()
				.from(authApiKeys)
				.all()
				.filter((key) => key.referenceId === viewerId);

		expect(keysFor().length).toBeGreaterThan(0);
		expect(keysFor().every((key) => Boolean(key.enabled))).toBe(true);

		await harness.withStore(harness.makeEvent('POST', '/api/auth/admin/ban-user').event, () =>
			harness.auth.api.banUser({
				body: { userId: viewerId, banReason: 'key disable test' },
				headers: adminHeaders
			})
		);
		// The key-disable hook runs post-commit.
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(keysFor().every((key) => !key.enabled)).toBe(true);

		const verifyBanned = await harness.auth.api.verifyApiKey({
			body: { key: created.key, permissions: { default: ['*'] } }
		});
		expect(verifyBanned.valid).toBe(false);

		await harness.withStore(harness.makeEvent('POST', '/api/auth/admin/unban-user').event, () =>
			harness.auth.api.unbanUser({ body: { userId: viewerId }, headers: adminHeaders })
		);
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(keysFor().every((key) => Boolean(key.enabled))).toBe(true);
	});
});

describe('real Better Auth instance — adversarial escalation matrix', () => {
	// Every test here signs in as the viewer and tries to become someone or
	// something they are not. State: secondadmin (admin) + testviewer (viewer).
	let viewerHeaders: Headers;

	async function viewerSignIn(): Promise<Headers> {
		const signIn = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: 'testviewer', password: 'viewer-password-123' })
		});
		expect(signIn.status).toBe(200);
		return new Headers({ cookie: harness.cookieHeader(harness.extractCookies(signIn)) });
	}

	it('rejects self-promotion through the generic update-user route', async () => {
		viewerHeaders = await viewerSignIn();
		const response = await harness.authRequest('/update-user', {
			method: 'POST',
			headers: viewerHeaders,
			body: JSON.stringify({ name: 'Harmless', role: 'admin', banned: true })
		});
		// The admin plugin marks role/banned input:false; parseUserInput
		// rejects truthy attempts outright.
		expect([400, 422]).toContain(response.status);
		expect(roleOf('testviewer')).toBe('user');
		const row = db
			.select()
			.from(user)
			.all()
			.find((row) => row.username === 'testviewer');
		expect(row?.banned ?? 0).toBe(0);
	});

	it('rejects reserved or malformed usernames through update-user', async () => {
		for (const username of ['root', 'has space!']) {
			const response = await harness.authRequest('/update-user', {
				method: 'POST',
				headers: viewerHeaders,
				body: JSON.stringify({ username })
			});
			// 400 from the username plugin's own validation, 422 from the
			// backstop hook in auth.ts — both must leave the row unchanged.
			expect([400, 422], username).toContain(response.status);
		}
		// The viewer's username is unchanged.
		expect(
			db
				.select()
				.from(user)
				.all()
				.find((row) => row.username === 'testviewer')
		).toBeDefined();
	});

	it('rejects every admin plugin operation from a viewer session', async () => {
		const adminId = db
			.select()
			.from(user)
			.all()
			.find((row) => row.username === 'secondadmin')!.id;
		const viewerId = db
			.select()
			.from(user)
			.all()
			.find((row) => row.username === 'testviewer')!.id;

		const attempts: Array<[string, () => Promise<unknown>]> = [
			[
				'setRole',
				() =>
					harness.auth.api.setRole({
						body: { userId: viewerId, role: 'admin' },
						headers: viewerHeaders
					})
			],
			[
				'banUser',
				() =>
					harness.auth.api.banUser({
						body: { userId: adminId, banReason: 'hostile takeover' },
						headers: viewerHeaders
					})
			],
			[
				'impersonateUser',
				() =>
					harness.auth.api.impersonateUser({
						body: { userId: adminId },
						headers: viewerHeaders
					})
			],
			[
				'removeUser',
				() => harness.auth.api.removeUser({ body: { userId: adminId }, headers: viewerHeaders })
			],
			[
				'setUserPassword',
				() =>
					harness.auth.api.setUserPassword({
						body: { userId: adminId, newPassword: 'stolen-password' },
						headers: viewerHeaders
					})
			],
			[
				'createUser',
				() =>
					harness.auth.api.createUser({
						body: {
							email: 'cloned@test.local',
							password: 'cloned-password',
							name: 'Clone',
							role: 'admin'
						},
						headers: viewerHeaders
					})
			],
			['listUsers', () => harness.auth.api.listUsers({ headers: viewerHeaders })]
		];

		for (const [name, attempt] of attempts) {
			await expect(
				harness.withStore(harness.makeEvent('POST', '/api/auth').event, attempt),
				name
			).rejects.toThrow();
		}
		// Nothing changed: admin still admin, viewer still viewer, no clone.
		expect(roleOf('secondadmin')).toBe('admin');
		expect(roleOf('testviewer')).toBe('user');
		expect(
			db
				.select()
				.from(user)
				.all()
				.find((row) => row.email === 'cloned@test.local')
		).toBeUndefined();
	});

	it('does not let a viewer change the admin password without the current one', async () => {
		const response = await harness.authRequest('/change-password', {
			method: 'POST',
			headers: viewerHeaders,
			body: JSON.stringify({ currentPassword: 'wrong-password', newPassword: 'new-password-123' })
		});
		expect(response.status).toBe(400);
	});

	it('keeps self-service email change disabled', async () => {
		const emailChange = await harness.authRequest('/change-email', {
			method: 'POST',
			headers: viewerHeaders,
			body: JSON.stringify({ newEmail: 'hijacked@test.local' })
		});
		expect(emailChange.status).toBe(400);
	});

	it('lets a viewer delete only their own account via self-service deletion', async () => {
		// deleteUser is intentionally enabled (profile page danger zone). The
		// escalation concern here isn't whether it's allowed; it's whether it
		// stays scoped to the caller's own row: better-auth's /delete-user always
		// targets ctx.context.session.user.id, never a body-supplied id, so there
		// is no cross-user path through this endpoint.
		const selfDelete = await harness.authRequest('/delete-user', {
			method: 'POST',
			headers: viewerHeaders,
			body: JSON.stringify({})
		});
		expect(selfDelete.status).toBe(200);

		expect(roleOf('secondadmin')).toBe('admin');
		expect(
			db
				.select()
				.from(user)
				.all()
				.find((row) => row.username === 'testviewer')
		).toBeUndefined();
	});
});

/** Role of a user row by username, straight from the database. */
function roleOf(username: string): string | null {
	return (
		db
			.select()
			.from(user)
			.all()
			.find((row) => row.username === username)?.role ?? null
	);
}
