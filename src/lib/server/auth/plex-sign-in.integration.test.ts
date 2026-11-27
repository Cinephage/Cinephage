/**
 * End-to-end tests for "Sign in with Plex" against the REAL Better Auth
 * instance (plugin wiring, session cookies, the user.create.before policy
 * hook and the admin plugin's ban check). plex.tv and the Plex server are
 * mocked at the fetch boundary.
 *
 * Test order matters: the first test bootstraps the admin, later tests build
 * on the accounts and links created before them.
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
const { db, sqlite } = await import('#lib/server/db/index.js');
const { user, authRateLimits, mediaBrowserServers, userMediaServerLinks } =
	await import('#lib/server/db/schema.js');
const { getSystemSettingsService } = await import('#lib/server/settings/SystemSettingsService.js');

const PLEX_SERVER_ID = 'plex-server-1';
const MACHINE_ID = 'machine-abc';
const OWNER_TOKEN = 'owner-token';
const FRIEND_TOKEN = 'friend-token';

/** Mutable plex.tv state the fetch mock serves. */
const plex = {
	pinApproved: false,
	friendShared: true
};

function xml(body: string): Response {
	return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
}

const realFetch = globalThis.fetch;
vi.stubGlobal(
	'fetch',
	vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const headers = new Headers(init?.headers);
		const token = headers.get('X-Plex-Token');

		if (url === 'http://plex.test:32400/') {
			return xml(`<MediaContainer machineIdentifier="${MACHINE_ID}" myPlexUsername="owner"/>`);
		}
		if (url === 'https://plex.tv/api/v2/pins?strong=true') {
			return Response.json({ id: 4242, code: 'pin-code-xyz' });
		}
		if (url === 'https://plex.tv/api/v2/pins/4242') {
			return Response.json({ id: 4242, authToken: plex.pinApproved ? FRIEND_TOKEN : null });
		}
		if (url === 'https://plex.tv/api/v2/user') {
			if (token === OWNER_TOKEN) {
				return Response.json({ id: 1, username: 'owner', email: 'owner@example.com' });
			}
			if (token === FRIEND_TOKEN) {
				return Response.json({ id: 200, username: 'friend.one', email: 'friend@example.com' });
			}
			return new Response('', { status: 401 });
		}
		if (url === 'https://plex.tv/api/users') {
			const share = plex.friendShared
				? `<Server machineIdentifier="${MACHINE_ID}" pending="0"/>`
				: `<Server machineIdentifier="someone-else" pending="0"/>`;
			return xml(
				`<MediaContainer><User id="200" title="friend.one" username="friend.one" email="friend@example.com" home="0">${share}</User></MediaContainer>`
			);
		}
		if (url.startsWith('http://localhost')) {
			return realFetch(input, init);
		}
		throw new Error(`unexpected fetch ${url}`);
	})
);

async function startPin(): Promise<{ handle: string; authUrl: string }> {
	const response = await harness.authRequest('/plex/pin', { method: 'POST', body: '{}' });
	expect(response.status).toBe(200);
	return (await response.json()) as { handle: string; authUrl: string };
}

async function pollSignIn(handle: string): Promise<Response> {
	return harness.authRequest('/plex/sign-in', {
		method: 'POST',
		body: JSON.stringify({ handle })
	});
}

function friendRow() {
	return db
		.select()
		.from(user)
		.all()
		.find((row) => row.username === 'friend.one');
}

beforeEach(() => {
	db.delete(authRateLimits).run();
	plex.pinApproved = false;
	plex.friendShared = true;
});

afterAll(() => {
	vi.unstubAllGlobals();
	harness.cleanup();
});

describe('Sign in with Plex (real Better Auth instance)', () => {
	it('is unavailable until setup is complete and a Plex server exists', async () => {
		const response = await harness.authRequest('/plex/pin', { method: 'POST', body: '{}' });
		expect(response.status).toBe(403);
		expect(((await response.json()) as { code?: string }).code).toBe('PLEX_SIGN_IN_UNAVAILABLE');

		// Bootstrap the admin, then configure the Plex server.
		const signUp = await harness.authRequest('/sign-up/email', {
			method: 'POST',
			body: JSON.stringify({
				email: 'admin@test.local',
				password: 'correct-horse-battery',
				name: 'Admin',
				username: 'admin'
			})
		});
		expect(signUp.status).toBe(200);
		db.insert(mediaBrowserServers)
			.values({
				id: PLEX_SERVER_ID,
				name: 'Home Plex',
				serverType: 'plex',
				host: 'http://plex.test:32400',
				apiKey: OWNER_TOKEN,
				enabled: true
			})
			.run();

		// A Plex server alone does not enable Plex sign-in: it is opt-in.
		const stillOff = await harness.authRequest('/plex/pin', { method: 'POST', body: '{}' });
		expect(stillOff.status).toBe(403);
		expect(((await stillOff.json()) as { code?: string }).code).toBe('PLEX_SIGN_IN_UNAVAILABLE');

		db.update(mediaBrowserServers)
			.set({ plexSignIn: true })
			.where(eq(mediaBrowserServers.id, PLEX_SERVER_ID))
			.run();
	});

	it('hands out an opaque handle and a Plex approval URL, then reports pending', async () => {
		const { handle, authUrl } = await startPin();
		expect(handle.length).toBeGreaterThanOrEqual(40);
		expect(authUrl.startsWith('https://app.plex.tv/auth#?')).toBe(true);
		expect(authUrl).toContain('code=pin-code-xyz');
		// The plex.tv PIN id is never exposed.
		expect(handle).not.toContain('4242');

		const response = await pollSignIn(handle);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: 'pending' });
	});

	it('rejects unknown handles as expired', async () => {
		const response = await pollSignIn('not-a-real-handle');
		expect(await response.json()).toEqual({ status: 'expired' });
	});

	it('refuses an unlinked Plex account while new-user sign-in is off', async () => {
		const { handle } = await startPin();
		plex.pinApproved = true;
		const response = await pollSignIn(handle);
		expect(response.status).toBe(403);
		expect(((await response.json()) as { code?: string }).code).toBe('PLEX_NOT_LINKED');
		expect(friendRow()).toBeUndefined();

		// The approved PIN was consumed: replaying the handle does nothing.
		const replay = await pollSignIn(handle);
		expect(await replay.json()).toEqual({ status: 'expired' });
	});

	it('creates a user-role account and signs in when new-user sign-in is on', async () => {
		await getSystemSettingsService().setPlexNewUserSignIn(true);
		const { handle } = await startPin();
		plex.pinApproved = true;

		const response = await pollSignIn(handle);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: 'signed-in' });
		const cookies = harness.extractCookies(response);
		expect(Object.keys(cookies).some((name) => name.includes('session_token'))).toBe(true);

		const created = friendRow();
		expect(created).toMatchObject({ role: 'user', email: 'friend@example.com' });
		const links = db
			.select()
			.from(userMediaServerLinks)
			.where(eq(userMediaServerLinks.userId, created!.id))
			.all();
		expect(links).toMatchObject([{ serverId: PLEX_SERVER_ID, serverUserId: '200' }]);
	});

	it('gives the auto-created account no password, so password login is refused', async () => {
		const { hasLocalPassword } = await import('#lib/server/auth/local-login.js');
		expect(await hasLocalPassword(friendRow()!.id)).toBe(false);

		const response = await harness.authRequest('/sign-in/username', {
			method: 'POST',
			body: JSON.stringify({ username: 'friend.one', password: 'any-password-at-all' })
		});
		expect(response.status).toBe(401);
	});

	it('signs a linked account back in without creating another one', async () => {
		await getSystemSettingsService().setPlexNewUserSignIn(false);
		const before = db.select().from(user).all().length;
		const { handle } = await startPin();
		plex.pinApproved = true;

		const response = await pollSignIn(handle);
		expect(await response.json()).toEqual({ status: 'signed-in' });
		expect(db.select().from(user).all().length).toBe(before);
	});

	it('refuses a linked account once the Plex share is revoked', async () => {
		plex.friendShared = false;
		const { handle } = await startPin();
		plex.pinApproved = true;

		const response = await pollSignIn(handle);
		expect(response.status).toBe(403);
		expect(((await response.json()) as { code?: string }).code).toBe('PLEX_NO_ACCESS');
	});

	it('refuses a banned account', async () => {
		// Raw SQL: the auth tables store booleans as integers.
		sqlite.prepare(`UPDATE "user" SET banned = 1 WHERE username = ?`).run('friend.one');
		const { handle } = await startPin();
		plex.pinApproved = true;

		const response = await pollSignIn(handle);
		expect(response.status).toBe(403);
		expect(((await response.json()) as { code?: string }).code).toBe('BANNED_USER');
	});

	it('keeps public sign-up closed (the provisioning bypass does not leak)', async () => {
		const response = await harness.authRequest('/sign-up/email', {
			method: 'POST',
			body: JSON.stringify({
				email: 'intruder@test.local',
				password: 'correct-horse-battery',
				name: 'Intruder',
				username: 'intruder'
			})
		});
		expect(response.status).toBe(403);
	});
});
