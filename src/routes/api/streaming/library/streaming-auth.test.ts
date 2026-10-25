/**
 * Auth integration tests for /api/streaming/library/* endpoints.
 *
 * These tests exercise the full authentication path:
 *   hooks.server.ts (API-key validation -> locals population) -> route handler
 *
 * They complement the isolated route tests (server.test.ts) which bypass auth
 * by injecting admin locals directly. Here we verify that:
 *   - A valid Media Streaming key (streaming: ['*']) is accepted
 *   - A valid Main API key (default: ['*']) is accepted via the fallback check
 *   - A missing key returns 401
 *   - An invalid / wrong-permission key returns 401
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper';
import { rootFolders, movies, movieFiles } from '#lib/server/db/schema.js';

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

vi.mock('#lib/server/filesystem/path-guard.js', () => ({
	isPathInsideManagedRoot: vi.fn().mockResolvedValue(true)
}));

const STREAMING_KEY = 'cinephage_streaming_key';
const MAIN_KEY = 'cinephage_main_key';
const BAD_KEY = 'cinephage_bad_key';

const verifyApiKeyMock = vi.fn();

vi.mock('#lib/server/auth/index.js', () => ({
	auth: {
		api: {
			verifyApiKey: verifyApiKeyMock
		}
	},
	isSetupComplete: vi.fn().mockResolvedValue(true),
	repairCurrentUserAdminRole: vi.fn()
}));

vi.mock('#lib/server/auth/session-helpers.js', () => ({
	createSupportId: vi.fn(() => 'test-support-id'),
	setAuthenticatedLocals: vi.fn(),
	clearAuthenticatedLocals: vi.fn(),
	// hooks.server.ts calls this unconditionally on every response (issue
	// #596's local-HTTP Secure-cookie strip); these tests never set cookies,
	// so a pass-through is the correct fake.
	stripSecureCookiesForLocalHttp: vi.fn((_event: unknown, response: Response) => response)
}));

vi.mock('#lib/server/services/initializer.js', () => ({
	ensureServicesInitialized: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/server/services/shutdown.js', () => ({}));

vi.mock('#lib/server/rate-limit.js', () => ({
	// Must return null/undefined to signal "not rate limited"; a truthy value
	// is treated as a rate-limit Response and returned early.
	checkApiRateLimit: vi.fn().mockReturnValue(null),
	applyRateLimitHeaders: vi.fn((_, response) => response)
}));

vi.mock('#lib/server/security/headers.js', () => ({
	SECURITY_HEADERS: {},
	BASE_SECURITY_HEADERS: {}
}));

vi.mock('#lib/server/utils/origin.js', () => ({
	isTrustedOrigin: vi.fn().mockReturnValue(true)
}));

vi.mock('#lib/server/hooks/error-handler.js', () => ({
	handleError: vi.fn()
}));

vi.mock('#lib/paraglide/server.js', () => ({
	paraglideMiddleware: vi.fn(
		(request: Request, resolve: (args: { request: Request; locale: string }) => unknown) =>
			resolve({ request, locale: 'en' })
	)
}));

vi.mock('$app/env', () => ({ building: false }));

vi.mock('#lib/auth/config.js', () => ({ AUTH_BASE_PATH: '/api/auth' }));

// sequence() normally requires the SvelteKit server async-local request store.
// Replace it with a simple sequential compose so handle() works outside the
// SvelteKit runtime.

type HandleFn = (input: {
	event: any;
	resolve: (e: any) => Promise<Response>;
}) => Promise<Response>;
vi.mock('@sveltejs/kit/hooks', () => ({
	sequence:
		(...handlers: HandleFn[]) =>
		(input: { event: any; resolve: (e: any) => Promise<Response> }) => {
			const run = (i: number, event: any): Promise<Response> => {
				if (i >= handlers.length) return input.resolve(event);
				return handlers[i]({ event, resolve: (e) => run(i + 1, e) });
			};
			return run(0, input.event);
		}
}));

const { handle } = await import('../../../../hooks.server');
const { GET, HEAD } = await import('./movie/[fileId]/+server');

const TEST_DIR = join(tmpdir(), `cinephage-auth-integration-test-${process.pid}`);
const TEST_FILE = 'auth-test.mkv';
const TEST_CONTENT = Buffer.from('auth integration test file content');
const FILE_ID = 'auth-mf-test-1';

beforeAll(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	writeFileSync(join(TEST_DIR, TEST_FILE), TEST_CONTENT);
});

afterAll(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	destroyTestDb(testDb);
});

beforeEach(async () => {
	clearTestDb(testDb);
	vi.clearAllMocks();

	// Default: streaming key valid, main key valid, bad key invalid
	verifyApiKeyMock.mockImplementation(
		({ body }: { body: { key: string; permissions: object } }) => {
			const { key, permissions } = body;
			const wantsStreaming = 'streaming' in permissions;
			const wantsFull = 'default' in permissions;

			if (key === STREAMING_KEY && wantsStreaming) {
				return Promise.resolve({
					valid: true,
					key: { permissions: { streaming: ['*'] } }
				});
			}
			if (key === MAIN_KEY && wantsFull) {
				return Promise.resolve({
					valid: true,
					key: { permissions: { default: ['*'] } }
				});
			}
			// Main key fails streaming check: it uses { default: ['*'] }, not { streaming: ['*'] }
			if (key === MAIN_KEY && wantsStreaming) {
				return Promise.resolve({ valid: false, error: { message: 'KEY_NOT_FOUND' } });
			}
			return Promise.resolve({ valid: false, error: { message: 'invalid key' } });
		}
	);

	await testDb.db.insert(rootFolders).values({
		id: 'auth-rf-1',
		name: 'Movies',
		path: TEST_DIR,
		mediaType: 'movie'
	});
	await testDb.db.insert(movies).values({
		id: 'auth-movie-1',
		tmdbId: 99999,
		title: 'Auth Test Movie',
		path: '',
		rootFolderId: 'auth-rf-1'
	});
	await testDb.db.insert(movieFiles).values({
		id: FILE_ID,
		movieId: 'auth-movie-1',
		relativePath: TEST_FILE,
		size: TEST_CONTENT.length
	});
});

function makeEvent(method: string, apiKey: string | null): Parameters<typeof handle>[0]['event'] {
	const headers = new Headers();
	if (apiKey) headers.set('x-api-key', apiKey);

	const request = new Request(`http://localhost/api/streaming/library/movie/${FILE_ID}`, {
		method,
		headers
	});

	return {
		request,
		url: new URL(request.url),
		params: { fileId: FILE_ID },
		locals: {} as App.Locals,
		platform: undefined,
		cookies: {
			get: () => undefined,
			getAll: () => [],
			set: () => {},
			delete: () => {},
			serialize: () => ''
		},
		fetch: globalThis.fetch,
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false,
		route: { id: '/api/streaming/library/movie/[fileId]' }
	} as any;
}

async function callViaHooks(method: string, apiKey: string | null): Promise<Response> {
	const event = makeEvent(method, apiKey);
	const handler = method === 'HEAD' ? HEAD : GET;

	return handle({
		event,
		resolve: async (evt) => handler(evt as any)
	});
}

describe('streaming library auth — Media Streaming API Key', () => {
	it('GET: accepts a valid streaming key and returns 200', async () => {
		const res = await callViaHooks('GET', STREAMING_KEY);
		expect(res.status).toBe(200);
		expect(res.headers.get('Accept-Ranges')).toBe('bytes');
	});

	it('HEAD: accepts a valid streaming key and returns 200', async () => {
		const res = await callViaHooks('HEAD', STREAMING_KEY);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Length')).toBe(String(TEST_CONTENT.length));
	});
});

describe('streaming library auth — Main API Key', () => {
	it('GET: accepts the main key (full-access fallback) and returns 200', async () => {
		const res = await callViaHooks('GET', MAIN_KEY);
		expect(res.status).toBe(200);
	});

	it('HEAD: accepts the main key (full-access fallback) and returns 200', async () => {
		const res = await callViaHooks('HEAD', MAIN_KEY);
		expect(res.status).toBe(200);
	});

	it('verifyApiKey is called twice for the main key — streaming check then full-access fallback', async () => {
		await callViaHooks('GET', MAIN_KEY);
		expect(verifyApiKeyMock).toHaveBeenCalledTimes(2);
		const [first, second] = verifyApiKeyMock.mock.calls;
		expect(first[0].body.permissions).toHaveProperty('streaming');
		expect(second[0].body.permissions).toHaveProperty('default');
	});
});

describe('streaming library auth — rejected requests', () => {
	it('GET: returns 401 when no API key is provided', async () => {
		const res = await callViaHooks('GET', null);
		expect(res.status).toBe(401);
	});

	it('HEAD: returns 401 when no API key is provided', async () => {
		const res = await callViaHooks('HEAD', null);
		expect(res.status).toBe(401);
	});

	it('GET: returns 401 for an invalid key', async () => {
		const res = await callViaHooks('GET', BAD_KEY);
		expect(res.status).toBe(401);
	});
});
