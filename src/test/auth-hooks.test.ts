/**
 * Integration tests for the REAL hooks chain with the REAL Better Auth
 * instance (src/hooks.server.ts + src/lib/server/auth).
 *
 * Unlike streaming-auth.test.ts (which mocks auth), these tests run the actual
 * auth construction against a throwaway database and drive requests through
 * `handle` inside a fake SvelteKit request store — the same store machinery
 * production uses — so `sveltekitCookies`/`sequence`/`getRequestEvent` all
 * behave as they do at runtime.
 *
 * Test order matters: fresh-install behavior first, then the sole admin is
 * created through the hook chain, and later tests use that session.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

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

vi.mock('#lib/server/services/initializer.js', () => ({
	ensureServicesInitialized: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/server/services/shutdown.js', () => ({}));

const harness = await import('./auth-test-harness.js').then((m) =>
	m.createAuthTestHarness({ withHooks: true })
);
const { db } = await import('#lib/server/db/index.js');
const { user, authRateLimits } = await import('#lib/server/db/schema.js');
const { ensureDefaultApiKeysForUser } = await import('#lib/server/auth/api-keys.js');

const USERNAME = 'testcurator';
const EMAIL = 'curator@test.local';
const PASSWORD = 'correct-horse-battery';

let sessionCookies: Record<string, string> = {};
let viewerCookies: Record<string, string> = {};
let adminUserId = '';
// Created once by the arr-compat block (ensureDefaultApiKeysForUser is
// idempotent) and reused by the streaming gate block.
let mainKey = '';
let streamingKey = '';

beforeEach(() => {
	// Better Auth's database-backed limiter counts every auth request across
	// tests (max 5 per 15 min); reset it so each test measures only itself.
	db.delete(authRateLimits).run();
});

afterAll(() => {
	harness.cleanup();
});

describe('hooks chain — fresh install', () => {
	it('redirects anonymous page requests to /setup', async () => {
		const { event } = harness.makeEvent('GET', '/');

		await expect(harness.callHandle(event)).rejects.toSatisfy((error: unknown) => {
			expect(isRedirect(error)).toBe(true);
			if (isRedirect(error)) {
				expect(error.status).toBe(302);
				expect(error.location).toBe('/setup');
			}
			return true;
		});
	});

	it('serves /setup and /health without a session', async () => {
		const setupPage = harness.makeEvent('GET', '/setup');
		const setupResponse = await harness.callHandle(setupPage.event);
		expect(setupResponse.status).toBe(200);

		const health = harness.makeEvent('GET', '/health');
		const healthResponse = await harness.callHandle(health.event);
		expect(healthResponse.status).toBe(200);
	});
});

describe('hooks chain — setup via the auth route', () => {
	it('signs the first user up through the full hook chain and issues a session cookie', async () => {
		// JSON requests skip csrfGuard by design; only form posts are checked.
		const { event } = harness.makeEvent('POST', '/api/auth/sign-up/email', {
			headers: {
				'content-type': 'application/json',
				origin: 'http://localhost:5173'
			},
			body: JSON.stringify({
				email: EMAIL,
				password: PASSWORD,
				name: 'Test Curator',
				username: USERNAME
			})
		});

		const response = await harness.callHandle(event);
		expect(response.status).toBe(200);

		const row = db.select().from(user).all()[0];
		expect(row?.role).toBe('admin');
		adminUserId = row!.id;

		const responseCookies = harness.extractCookies(response);
		expect(Object.keys(responseCookies).some((name) => name.includes('session_token'))).toBe(true);
		// NOTE: the sveltekitCookies plugin never fires for handler-driven
		// requests (better-auth returns cookies on the Response itself), so the
		// event cookie jar is intentionally not asserted here.

		// Auth responses now flow through the shared response tail: correlation
		// IDs and security headers apply to /api/auth like every other route.
		expect(response.headers.get('x-correlation-id')).toBeTruthy();
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');

		sessionCookies = responseCookies;
	});
});

describe('hooks chain — authenticated routing', () => {
	it('populates locals.user/session for cookie-authenticated API requests', async () => {
		const { event } = harness.makeEvent('GET', '/api/activity', {
			headers: { cookie: harness.cookieHeader(sessionCookies) }
		});

		const response = await harness.callHandle(event);
		expect(response.status).toBe(200);
		expect(event.locals.user?.id).toBe(adminUserId);
		expect(event.locals.user?.role).toBe('admin');
		expect(event.locals.session?.userId).toBe(adminUserId);
	});

	it('returns 401 JSON for anonymous API requests once setup is complete', async () => {
		const { event } = harness.makeEvent('GET', '/api/activity');

		const response = await harness.callHandle(event);
		expect(response.status).toBe(401);
		const body = (await response.json()) as { code?: string };
		expect(body.code).toBe('UNAUTHORIZED');
	});

	it('keeps /login public once setup is complete', async () => {
		const { event } = harness.makeEvent('GET', '/login');
		const response = await harness.callHandle(event);
		expect(response.status).toBe(200);
	});

	it('redirects authenticated users away from /login', async () => {
		const { event } = harness.makeEvent('GET', '/login', {
			headers: { cookie: harness.cookieHeader(sessionCookies) }
		});

		await expect(harness.callHandle(event)).rejects.toSatisfy((error: unknown) => {
			expect(isRedirect(error)).toBe(true);
			if (isRedirect(error)) {
				expect(error.status).toBe(302);
				expect(error.location).toBe('/');
			}
			return true;
		});
	});
});

describe('hooks chain — API key authentication (arr-compatible)', () => {
	it('creates managed keys for the admin session', async () => {
		const sessionHeaders = new Headers({ cookie: harness.cookieHeader(sessionCookies) });
		const keys = await ensureDefaultApiKeysForUser(adminUserId, sessionHeaders);
		expect(keys.mainKey?.key).toMatch(/^cinephage_/);
		expect(keys.streamingKey?.key).toMatch(/^cinephage_/);
		mainKey = keys.mainKey!.key;
		streamingKey = keys.streamingKey!.key;
	});

	it('authenticates via the x-api-key header', async () => {
		const { event } = harness.makeEvent('GET', '/api/activity', {
			headers: { 'x-api-key': mainKey }
		});

		const response = await harness.callHandle(event);
		expect(response.status).toBe(200);
		expect(event.locals.user?.id).toBe(adminUserId);
		expect(event.locals.apiKey).toBe(mainKey);
	});

	it('authenticates via the ?apikey= query parameter on arr-compat routes (Seerr-style arr clients)', async () => {
		const { event } = harness.makeEvent(
			'GET',
			'/api/radarr/api/v3/system-status?apikey=' + encodeURIComponent(mainKey)
		);

		const response = await harness.callHandle(event);
		expect(response.status).toBe(200);
		expect(event.locals.user?.id).toBe(adminUserId);
	});

	it('rejects ?apikey= outside the arr-compat routes — query-param credentials leak into proxy logs', async () => {
		const { event } = harness.makeEvent(
			'GET',
			'/api/activity?apikey=' + encodeURIComponent(mainKey)
		);

		const response = await harness.callHandle(event);
		expect(response.status).toBe(401);
		expect(event.locals.user).toBeNull();
	});

	it('rejects an invalid API key without falling back to a session', async () => {
		const { event } = harness.makeEvent('GET', '/api/activity', {
			headers: { 'x-api-key': 'cinephage_invalid_key' }
		});

		const response = await harness.callHandle(event);
		expect(response.status).toBe(401);
	});

	it('never bridges a streaming-scoped key to the general API — not even for its owner', async () => {
		// Streaming keys live in .m3u/.strm URLs that proxies and media
		// servers log routinely. If one leaked, it must not grant full API
		// access to the (admin) owner account.
		const { event } = harness.makeEvent('GET', '/api/activity', {
			headers: { 'x-api-key': streamingKey }
		});

		const response = await harness.callHandle(event);
		expect(response.status).toBe(401);
		expect(event.locals.user).toBeNull();
	});
});

describe('hooks chain — streaming API key gate', () => {
	it('accepts a streaming-scoped key', async () => {
		const { event } = harness.makeEvent('GET', '/api/streaming/library/movie/some-file', {
			headers: { 'x-api-key': streamingKey }
		});

		const response = await harness.callHandle(event);
		expect(response.status).toBe(200);
		expect(event.locals.apiKey).toBe(streamingKey);
	});

	it('accepts the main key through the full-access fallback', async () => {
		const { event } = harness.makeEvent('GET', '/api/streaming/library/movie/some-file', {
			headers: { 'x-api-key': mainKey }
		});

		const response = await harness.callHandle(event);
		expect(response.status).toBe(200);
	});

	it('returns 401 for a key without streaming permissions', async () => {
		const { event } = harness.makeEvent('GET', '/api/streaming/library/movie/some-file', {
			headers: { 'x-api-key': 'cinephage_invalid_key' }
		});

		const response = await harness.callHandle(event);
		expect(response.status).toBe(401);
	});

	it('returns 401 API_KEY_REQUIRED when no key is presented', async () => {
		const { event } = harness.makeEvent('GET', '/api/streaming/library/movie/some-file');

		const response = await harness.callHandle(event);
		expect(response.status).toBe(401);
		const body = (await response.json()) as { code?: string };
		expect(body.code).toBe('API_KEY_REQUIRED');
	});
});

describe('hooks chain — multi-user readiness', () => {
	// The admin plugin's user endpoints read the request event internally,
	// so direct auth.api calls need the store wrapper.
	function storeStub() {
		return harness.makeEvent('POST', '/api/auth/admin/set-role').event;
	}

	it('blocks demoting the sole account', async () => {
		const sessionHeaders = new Headers({ cookie: harness.cookieHeader(sessionCookies) });

		await expect(
			harness.withStore(storeStub(), () =>
				harness.auth.api.setRole({
					body: { userId: adminUserId, role: 'user' },
					headers: sessionHeaders
				})
			)
		).rejects.toThrow(/only admin/);
	});

	it('admin-created second account gets a session that is NOT force-promoted', async () => {
		const sessionHeaders = new Headers({ cookie: harness.cookieHeader(sessionCookies) });
		await harness.withStore(storeStub(), () =>
			harness.auth.api.createUser({
				body: {
					email: 'viewer@hooks.test',
					password: 'viewer-password-123',
					name: 'Hook Viewer',
					role: 'user',
					data: { username: 'hookviewer' }
				},
				headers: sessionHeaders
			})
		);
		const rows = db.select().from(user).all();
		expect(rows.find((row) => row.username === 'hookviewer')?.role).toBe('user');

		// The viewer signs in through the full hook chain.
		const signIn = harness.makeEvent('POST', '/api/auth/sign-in/username', {
			headers: {
				'content-type': 'application/json',
				origin: 'http://localhost:5173'
			},
			body: JSON.stringify({ username: 'hookviewer', password: 'viewer-password-123' })
		});
		const signInResponse = await harness.callHandle(signIn.event);
		expect(signInResponse.status).toBe(200);
		viewerCookies = harness.extractCookies(signInResponse);

		// With two accounts, the bootstrap repair must leave the role alone —
		// checked on a viewer-allowlisted path (see the viewer gate describe).
		const apiRequest = harness.makeEvent('GET', '/api/system/status', {
			headers: { cookie: harness.cookieHeader(viewerCookies) }
		});
		const response = await harness.callHandle(apiRequest.event);
		expect(response.status).toBe(200);
		expect(apiRequest.event.locals.user?.username).toBe('hookviewer');
		expect(apiRequest.event.locals.user?.role).toBe('user');
	});
});

describe('hooks chain — viewer API gate', () => {
	it('lets a viewer session read allowlisted surfaces', async () => {
		for (const path of ['/api/system/status', '/api/discover', '/api/library/movies']) {
			const { event } = harness.makeEvent('GET', path, {
				headers: { cookie: harness.cookieHeader(viewerCookies) }
			});
			const response = await harness.callHandle(event);
			expect(response.status, path).toBe(200);
		}
	});

	it('lets a viewer set their own language', async () => {
		const { event } = harness.makeEvent('POST', '/api/user/language', {
			headers: {
				cookie: harness.cookieHeader(viewerCookies),
				'content-type': 'application/json',
				origin: 'http://localhost:5173'
			},
			body: JSON.stringify({ language: 'en' })
		});
		const response = await harness.callHandle(event);
		expect(response.status).toBe(200);
	});

	it('lets a viewer use self-service media-server linking', async () => {
		const read = harness.makeEvent('GET', '/api/user/media-server/link', {
			headers: { cookie: harness.cookieHeader(viewerCookies) }
		});
		expect((await harness.callHandle(read.event)).status).toBe(200);

		// But the admin per-user endpoint stays admin-only.
		const adminRoute = harness.makeEvent('GET', '/api/settings/users/someone/media-server-link', {
			headers: { cookie: harness.cookieHeader(viewerCookies) }
		});
		expect((await harness.callHandle(adminRoute.event)).status).toBe(403);
	});

	it('lets a viewer manage their own sessions', async () => {
		for (const method of ['GET', 'DELETE'] as const) {
			const { event } = harness.makeEvent(method, '/api/user/sessions', {
				headers: {
					cookie: harness.cookieHeader(viewerCookies),
					'content-type': 'application/json'
				},
				body: method === 'GET' ? undefined : JSON.stringify({})
			});
			const response = await harness.callHandle(event);
			expect(response.status, method).toBe(200);
		}
		// But session writes outside the self-service path stay admin-only.
		const adminPath = harness.makeEvent('POST', '/api/auth/admin/list-user-sessions', {
			headers: {
				cookie: harness.cookieHeader(viewerCookies),
				'content-type': 'application/json',
				origin: 'http://localhost:5173'
			},
			body: JSON.stringify({ userId: 'someone-else' })
		});
		const adminResponse = await harness.callHandle(adminPath.event);
		expect(adminResponse.status).toBe(403);
	});

	it('blocks viewer sessions from admin API routes regardless of local guards', async () => {
		// Routes like /api/indexers (GET) and /api/subtitles/auto-search (POST)
		// carry no local role check of their own — the central gate is what
		// keeps them admin-only.
		const cases = [
			['GET', '/api/activity'],
			['GET', '/api/indexers'],
			['POST', '/api/subtitles/auto-search'],
			['POST', '/api/library/movies'],
			['POST', '/api/library/movies/abc/auto-search'],
			['PUT', '/api/settings/calendar-preferences']
		] as const;

		for (const [method, path] of cases) {
			const { event } = harness.makeEvent(method, path, {
				headers: {
					cookie: harness.cookieHeader(viewerCookies),
					'content-type': 'application/json',
					origin: 'http://localhost:5173'
				},
				body: method === 'GET' ? undefined : JSON.stringify({})
			});
			const response = await harness.callHandle(event);
			expect(response.status, `${method} ${path}`).toBe(403);
			const body = (await response.json()) as { code?: string };
			expect(body.code, `${method} ${path}`).toBe('FORBIDDEN');
		}
	});

	it('leaves admin sessions unaffected', async () => {
		const { event } = harness.makeEvent('GET', '/api/activity', {
			headers: { cookie: harness.cookieHeader(sessionCookies) }
		});
		const response = await harness.callHandle(event);
		expect(response.status).toBe(200);
	});
});

describe('hooks chain — viewer gate: requests and notifications', () => {
	it('lets a viewer reach the request list and their notification feed', async () => {
		for (const path of ['/api/requests', '/api/user/notifications']) {
			const { event } = harness.makeEvent('GET', path, {
				headers: { cookie: harness.cookieHeader(viewerCookies) }
			});
			const response = await harness.callHandle(event);
			expect(response.status, path).toBe(200);
		}

		// Mark-read is the one notification write viewers own.
		const markRead = harness.makeEvent('POST', '/api/user/notifications/read', {
			headers: {
				cookie: harness.cookieHeader(viewerCookies),
				'content-type': 'application/json',
				origin: 'http://localhost:5173'
			},
			body: JSON.stringify({ ids: [] })
		});
		expect((await harness.callHandle(markRead.event)).status).toBe(200);
	});

	it('admits viewer request creation and deletion past the gate', async () => {
		// Any non-403 status proves the gate admitted the call; the route
		// contract itself is covered by the request route tests.
		const create = harness.makeEvent('POST', '/api/requests', {
			headers: {
				cookie: harness.cookieHeader(viewerCookies),
				'content-type': 'application/json',
				origin: 'http://localhost:5173'
			},
			body: JSON.stringify({ mediaType: 'movie', tmdbId: 99 })
		});
		const createResponse = await harness.callHandle(create.event);
		expect(createResponse.status).toBe(200);

		const remove = harness.makeEvent('DELETE', '/api/requests/does-not-exist', {
			headers: { cookie: harness.cookieHeader(viewerCookies) }
		});
		expect((await harness.callHandle(remove.event)).status).toBe(200);
	});

	it('keeps admin request mutations and the notifications write path admin-only', async () => {
		// POST under /api/requests/[id]/... falls through the allowlist to the
		// admin gate; the route's own requireAdmin never sees the call.
		const approve = harness.makeEvent('POST', '/api/requests/whatever/approve', {
			headers: {
				cookie: harness.cookieHeader(viewerCookies),
				'content-type': 'application/json',
				origin: 'http://localhost:5173'
			},
			body: JSON.stringify({})
		});
		const approveResponse = await harness.callHandle(approve.event);
		expect(approveResponse.status).toBe(403);
		const approveBody = (await approveResponse.json()) as { code?: string };
		expect(approveBody.code).toBe('FORBIDDEN');

		// POST on the notifications base is not part of the API (mark-read
		// carries the POST) — viewers 403 at the gate.
		const notifyPost = harness.makeEvent('POST', '/api/user/notifications', {
			headers: {
				cookie: harness.cookieHeader(viewerCookies),
				'content-type': 'application/json',
				origin: 'http://localhost:5173'
			},
			body: JSON.stringify({})
		});
		expect((await harness.callHandle(notifyPost.event)).status).toBe(403);
	});
});

describe('hooks chain — viewer gate hardening', () => {
	it('normalizes path tricks before matching the allowlist', async () => {
		const cases = [
			['GET', '//api/activity'],
			['GET', '/api/activity/'],
			['GET', '/api/library/movies%2f..%2f..%2factivity'],
			['GET', '/api/library%2Fmovies/../activity'],
			['POST', '/api/discover'],
			['DELETE', '/api/library/movies/abc'],
			['PUT', '/api/system/status']
		] as const;

		for (const [method, path] of cases) {
			const { event } = harness.makeEvent(method, path, {
				headers: { cookie: harness.cookieHeader(viewerCookies) }
			});
			const response = await harness.callHandle(event);
			expect(response.status, `${method} ${path}`).toBe(403);
		}
	});

	it('allows the trailing-slash form of allowlisted paths', async () => {
		const { event } = harness.makeEvent('GET', '/api/library/movies/', {
			headers: { cookie: harness.cookieHeader(viewerCookies) }
		});
		const response = await harness.callHandle(event);
		expect(response.status).toBe(200);
	});

	it('rejects viewer calls to the admin plugin endpoints through the real auth route', async () => {
		const { event } = harness.makeEvent('POST', '/api/auth/admin/create-user', {
			headers: {
				cookie: harness.cookieHeader(viewerCookies),
				'content-type': 'application/json',
				origin: 'http://localhost:5173'
			},
			body: JSON.stringify({
				email: 'escalation@test.local',
				password: 'escalation-password',
				name: 'Escalation Attempt'
			})
		});
		const response = await harness.callHandle(event);
		expect(response.status).toBe(403);
	});

	it('confines viewer-owned API keys to the viewer allowlist', async () => {
		// Even a viewer's full-access "main" key resolves to the viewer role,
		// so the central gate — not the key's permissions — decides access.
		const viewerId = db
			.select()
			.from(user)
			.all()
			.find((row) => row.username === 'hookviewer')!.id;
		const sessionHeaders = new Headers({ cookie: harness.cookieHeader(viewerCookies) });
		const keys = await ensureDefaultApiKeysForUser(viewerId, sessionHeaders);
		expect(keys.mainKey?.key).toMatch(/^cinephage_/);

		const blocked = harness.makeEvent('GET', '/api/indexers', {
			headers: { 'x-api-key': keys.mainKey!.key }
		});
		const blockedResponse = await harness.callHandle(blocked.event);
		expect(blockedResponse.status).toBe(403);

		const allowed = harness.makeEvent('GET', '/api/system/status', {
			headers: { 'x-api-key': keys.mainKey!.key }
		});
		const allowedResponse = await harness.callHandle(allowed.event);
		expect(allowedResponse.status).toBe(200);
	});

	it('a banned viewer loses their live session immediately', async () => {
		// Runs last: it invalidates the shared viewerCookies jar.
		const adminHeaders = new Headers({ cookie: harness.cookieHeader(sessionCookies) });
		const viewerRow = db
			.select()
			.from(user)
			.all()
			.find((row) => row.username === 'hookviewer')!;
		await harness.withStore(harness.makeEvent('POST', '/api/auth/admin/ban-user').event, () =>
			harness.auth.api.banUser({
				body: { userId: viewerRow.id, banReason: 'hooks ban test' },
				headers: adminHeaders
			})
		);

		// The replayed cookie no longer resolves to a session.
		const replay = harness.makeEvent('GET', '/api/system/status', {
			headers: { cookie: harness.cookieHeader(viewerCookies) }
		});
		const replayResponse = await harness.callHandle(replay.event);
		expect(replayResponse.status).toBe(401);

		// And the banned viewer cannot sign back in.
		const resigned = harness.makeEvent('POST', '/api/auth/sign-in/username', {
			headers: {
				'content-type': 'application/json',
				origin: 'http://localhost:5173'
			},
			body: JSON.stringify({ username: 'hookviewer', password: 'viewer-password-123' })
		});
		const resignedResponse = await harness.callHandle(resigned.event);
		expect(resignedResponse.status).toBe(403);
	});
});
