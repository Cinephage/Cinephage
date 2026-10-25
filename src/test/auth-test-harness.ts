import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';

/**
 * Shared harness for integration tests that exercise the REAL Better Auth
 * instance (and optionally the real hooks chain) against a throwaway SQLite
 * database.
 *
 * Everything else in the auth test suite mocks `auth`; these tests exist to
 * catch behavior only the real instance has (cookie shapes, plugin ordering,
 * schema latch order, single-admin database hooks) so the auth layer can be
 * refactored safely.
 *
 * Must be created before any static import touches `#lib/server/**`: the auth
 * module opens its database connection at import time, so the temp DATA_DIR
 * env vars have to be in place first. Call `createAuthTestHarness()` from a
 * top-level `await` in the test file, after its `vi.mock` calls.
 */

const BASE_URL = 'http://localhost:5173';

interface TracingState {
	tracing: {
		enabled: boolean;
		record_span: (options: {
			name?: string;
			attributes?: Record<string, unknown>;
			fn: (current: unknown) => unknown;
		}) => unknown;
	};
}

function makeTracingState(): TracingState {
	// Minimal stand-in for SvelteKit's telemetry state: sequence() requires
	// state.tracing.record_span to exist, our hooks never read the span itself.
	return {
		tracing: {
			enabled: false,
			record_span: ({ fn }) => fn(null)
		}
	};
}

export interface AuthHarnessEvent {
	event: RequestEvent;
	cookieJar: Record<string, string>;
}

type HandleLike = (input: {
	event: RequestEvent;
	resolve: (event: RequestEvent) => Promise<Response>;
}) => Promise<Response>;

export interface AuthTestHarness {
	tempDir: string;
	auth: any;
	handle: HandleLike | null;
	/** Runs fn inside a fake SvelteKit request store so getRequestEvent() works. */
	withStore: <T>(event: unknown, fn: () => T) => T;
	/** Builds a synthetic RequestEvent with a working cookie jar. */
	makeEvent: (
		method: string,
		path: string,
		options?: {
			headers?: Record<string, string>;
			cookies?: Record<string, string>;
			body?: string;
		}
	) => AuthHarnessEvent;
	/** Calls auth.handler directly (outside the hooks chain) for a /api/auth path. */
	authRequest: (path: string, init?: RequestInit) => Promise<Response>;
	/** Calls the real hooks chain; resolve() simulates the endpoint. */
	callHandle: (event: RequestEvent, endpointResponse?: Response) => Promise<Response>;
	extractCookies: (response: Response) => Record<string, string>;
	cookieHeader: (jar: Record<string, string>) => string;
	cleanup: () => void;
}

export async function createAuthTestHarness(options: {
	withHooks: boolean;
}): Promise<AuthTestHarness> {
	const tempDir = mkdtempSync(join(tmpdir(), 'cinephage-auth-it-'));
	const previousEnv = {
		DATA_DIR: process.env.DATA_DIR,
		AUTH_DATABASE_URL: process.env.AUTH_DATABASE_URL,
		BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
		ORIGIN: process.env.ORIGIN
	};

	// The auth and app connections must share one file, like production.
	process.env.DATA_DIR = tempDir;
	process.env.AUTH_DATABASE_URL = join(tempDir, 'cinephage.db');
	// Keep the resolved base URL predictable (localhost http) regardless of
	// what the developer's .env contains.
	delete process.env.BETTER_AUTH_URL;
	delete process.env.ORIGIN;

	// Import order mirrors production boot: auth.js creates the Better Auth
	// tables before betterAuth() is constructed, then schema-sync adds the
	// application tables (settings, userApiKeySecrets, ...).
	const { auth } = await import('#lib/server/auth/auth.js');
	const dbModule = await import('#lib/server/db/index.js');
	const { syncSchema } = await import('#lib/server/db/schema-sync.js');
	syncSchema(dbModule.sqlite);

	let handle: AuthTestHarness['handle'] = null;
	let authRouteModule: Record<string, (ctx: { request: Request }) => Promise<Response>> | null =
		null;
	if (options.withHooks) {
		const hooksModule = await import('../hooks.server.js');
		handle = hooksModule.handle as HandleLike;
		// The catch-all route module, so /api/auth requests dispatched through
		// handle() reach the real endpoint instead of the endpoint stub.
		authRouteModule = (await import('../routes/api/auth/[...all]/+server.js')) as unknown as Record<
			string,
			(ctx: { request: Request }) => Promise<Response>
		>;
	}

	const internal = await import('@sveltejs/kit/internal/server');

	function withStore<T>(event: unknown, fn: () => T): T {
		return internal.with_request_store({ event, state: makeTracingState() }, fn);
	}

	function makeEvent(
		method: string,
		path: string,
		eventOptions: {
			headers?: Record<string, string>;
			cookies?: Record<string, string>;
			body?: string;
		} = {}
	): AuthHarnessEvent {
		const url = new URL(`${BASE_URL}${path}`);
		const request = new Request(url, {
			method,
			headers: eventOptions.headers,
			body: eventOptions.body
		});
		const cookieJar: Record<string, string> = { ...eventOptions.cookies };

		const event = {
			request,
			url,
			params: {},
			locals: {},
			platform: undefined,
			cookies: {
				get: (name: string) => cookieJar[name],
				getAll: () => Object.entries(cookieJar).map(([name, value]) => ({ name, value })),
				set: (name: string, value: string) => {
					cookieJar[name] = value;
				},
				delete: (name: string) => {
					delete cookieJar[name];
				},
				serialize: () => ''
			},
			fetch: globalThis.fetch,
			getClientAddress: () => '127.0.0.1',
			setHeaders: () => {},
			isDataRequest: false,
			isSubRequest: false,
			route: { id: null }
		} as unknown as RequestEvent;

		return { event, cookieJar };
	}

	async function authRequest(path: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set('content-type', 'application/json');
		headers.set('origin', BASE_URL);
		const request = new Request(`${BASE_URL}/api/auth${path}`, { ...init, headers });

		// sveltekitCookies calls getRequestEvent(), which throws outside a
		// request store — run the handler inside a minimal fake one.
		const stub = makeEvent(request.method, new URL(request.url).pathname, {});
		return withStore(stub.event, () => auth.handler(request));
	}

	async function callHandle(event: RequestEvent, endpointResponse?: Response): Promise<Response> {
		return withStore(event, () =>
			handle!({
				event,
				resolve: (resolvedEvent) => {
					// Dispatch auth paths to the real catch-all route the way
					// SvelteKit routing would; everything else gets the stub.
					const pathname = resolvedEvent.url.pathname;
					if (authRouteModule && pathname.startsWith('/api/auth')) {
						const method = resolvedEvent.request.method.toUpperCase();
						const routeHandler =
							authRouteModule[method] ?? authRouteModule.POST ?? authRouteModule.GET;
						return routeHandler({ request: resolvedEvent.request });
					}
					return Promise.resolve(endpointResponse ?? new Response('endpoint-ok', { status: 200 }));
				}
			})
		);
	}

	function extractCookies(response: Response): Record<string, string> {
		const jar: Record<string, string> = {};
		for (const setCookie of response.headers.getSetCookie()) {
			const [pair] = setCookie.split(';');
			const eq = pair.indexOf('=');
			if (eq > 0) {
				jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
			}
		}
		return jar;
	}

	function cookieHeader(jar: Record<string, string>): string {
		return Object.entries(jar)
			.map(([name, value]) => `${name}=${value}`)
			.join('; ');
	}

	function cleanup(): void {
		if (previousEnv.DATA_DIR === undefined) {
			delete process.env.DATA_DIR;
		} else {
			process.env.DATA_DIR = previousEnv.DATA_DIR;
		}
		if (previousEnv.AUTH_DATABASE_URL === undefined) {
			delete process.env.AUTH_DATABASE_URL;
		} else {
			process.env.AUTH_DATABASE_URL = previousEnv.AUTH_DATABASE_URL;
		}
		if (previousEnv.BETTER_AUTH_URL === undefined) {
			delete process.env.BETTER_AUTH_URL;
		} else {
			process.env.BETTER_AUTH_URL = previousEnv.BETTER_AUTH_URL;
		}
		if (previousEnv.ORIGIN === undefined) {
			delete process.env.ORIGIN;
		} else {
			process.env.ORIGIN = previousEnv.ORIGIN;
		}
		rmSync(tempDir, { recursive: true, force: true });
	}

	return {
		tempDir,
		auth,
		handle,
		withStore,
		makeEvent,
		authRequest,
		callHandle,
		extractCookies,
		cookieHeader,
		cleanup
	};
}
