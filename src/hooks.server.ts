import { redirect } from '@sveltejs/kit';
import { sequence, type Handle } from '@sveltejs/kit/hooks';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AUTH_BASE_PATH } from '#lib/auth/config.js';
import { createRequestLogger, runWithLogContext } from '#lib/logging/index.js';
import { isAppError } from '#lib/errors/index.js';
import { paraglideMiddleware } from '#lib/paraglide/server.js';
import { auth, isSetupComplete, repairCurrentUserAdminRole } from '#lib/server/auth/index.js';
import { db } from '#lib/server/db/index.js';
import { user } from '#lib/server/db/schema.js';
import { checkApiRateLimit, applyRateLimitHeaders } from '#lib/server/rate-limit.js';
import { SECURITY_HEADERS, BASE_SECURITY_HEADERS } from '#lib/server/security/headers.js';
import {
	createSupportId,
	setAuthenticatedLocals,
	clearAuthenticatedLocals,
	stripSecureCookiesForLocalHttp,
	rewriteCookieHeaderForLocalHttp
} from '#lib/server/auth/session-helpers.js';
import { ensureServicesInitialized } from '#lib/server/services/initializer.js';
import '#lib/server/services/shutdown.js';
import { handleError } from '#lib/server/hooks/error-handler.js';
import { isTrustedOrigin } from '#lib/server/utils/origin.js';

export { handleError };

// SvelteKit's built-in csrf.trustedOrigins uses Array.includes() (exact match only) so
// wildcard LAN patterns never work. We disable it in svelte.config.js and do the check
// here where we can use proper local-network detection + env-var trusted origins.
const csrfGuard: Handle = ({ event, resolve }) => {
	const { request } = event;

	const method = request.method.toUpperCase();
	if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
		return resolve(event);
	}

	const contentType = request.headers.get('content-type') ?? '';
	const isFormRequest =
		contentType.includes('application/x-www-form-urlencoded') ||
		contentType.includes('multipart/form-data') ||
		contentType.includes('text/plain');

	if (!isFormRequest) {
		return resolve(event);
	}

	const requestOrigin = request.headers.get('origin');
	const serverOrigin = event.url.origin;

	// Same-origin — always allowed.
	if (!requestOrigin || requestOrigin === serverOrigin) {
		return resolve(event);
	}

	if (!isTrustedOrigin(requestOrigin)) {
		return new Response(`Cross-site ${method} form submissions are forbidden`, { status: 403 });
	}

	return resolve(event);
};

const localeHandler: Handle = async ({ event, resolve }) => {
	return paraglideMiddleware(event.request, async ({ request, locale }) => {
		// event.request is readonly in SvelteKit 3; resolve against a copy
		// carrying paraglide's locale-aware request instead.
		return resolve(
			{ ...event, request },
			{
				transformPageChunk: ({ html }) => html.replace('%sveltekit.lang%', locale)
			}
		);
	});
};

const customHandler: Handle = async ({ event, resolve }) => {
	ensureServicesInitialized();

	const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const clientId = event.request.headers.get('x-correlation-id');
	const correlationId = clientId && UUID_REGEX.test(clientId) ? clientId : randomUUID();
	const supportId = createSupportId();
	const requestLogger = createRequestLogger({
		requestId: correlationId,
		correlationId,
		supportId,
		logDomain: 'http',
		method: event.request.method,
		path: event.url.pathname
	});

	event.locals.correlationId = correlationId;
	event.locals.requestId = correlationId;
	event.locals.supportId = supportId;
	event.locals.logger = requestLogger;
	const pathname = event.url.pathname;
	// Route checks run on a normalized path: duplicate slashes collapsed and
	// the trailing slash dropped, so "//api/..." or "/api/x/" variants cannot
	// sidestep a prefix check. Raw pathname stays in the logs.
	const routePath = pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';

	return runWithLogContext(
		{
			requestId: correlationId,
			correlationId,
			supportId,
			logDomain: 'http',
			method: event.request.method,
			path: pathname
		},
		async () => {
			function requiresStreamingApiKey(path: string): boolean {
				if (path === '/api/livetv/playlist.m3u' || path.startsWith('/api/livetv/playlist.m3u/')) {
					return true;
				}
				if (path === '/api/livetv/epg.xml' || path.startsWith('/api/livetv/epg.xml/')) {
					return true;
				}
				if (path.startsWith('/api/livetv/stream/')) {
					return true;
				}
				if (path.startsWith('/api/streaming/session/')) {
					return true;
				}
				if (path.startsWith('/api/streaming/usenet/')) {
					return true;
				}
				if (path.startsWith('/api/streaming/library/')) {
					return true;
				}
				return false;
			}

			const isStreamingApiRoute = requiresStreamingApiKey(routePath);

			function isHealthRoute(path: string): boolean {
				if (path === '/health' || path.startsWith('/health/')) {
					return true;
				}
				if (path === '/api/health' || path.startsWith('/api/health/')) {
					return true;
				}
				if (path === '/api/ready' || path.startsWith('/api/ready/')) {
					return true;
				}
				// Radarr/Sonarr's own /ping is unauthenticated.
				if (path === '/api/radarr/ping' || path === '/api/sonarr/ping') {
					return true;
				}
				return false;
			}

			/**
			 * Viewer (non-admin) API allowlist. Most routes carry no local role
			 * check, so this central gate is the enforcement layer: a viewer
			 * session may read the shared library/discover/calendar surfaces and
			 * manage its own language and sessions; everything else under /api/
			 * is admin territory. GET-only by design — the write paths those
			 * pages offer (auto-search, subtitles, edits) are admin operations.
			 */
			function isViewerAllowedApiPath(path: string, method: string): boolean {
				if (path === '/api/user/language') {
					return method === 'POST' || method === 'PUT';
				}
				// Self-scoped session management (own rows only, server-side).
				if (path === '/api/user/sessions') {
					return method === 'GET' || method === 'DELETE';
				}
				// Self-scoped media-server account linking (Quick Connect).
				if (path === '/api/user/media-server/link') {
					return method === 'GET' || method === 'POST' || method === 'PUT' || method === 'DELETE';
				}
				// Self-scoped per-account preferences (registry-validated keys).
				if (path === '/api/user/preferences' || path.startsWith('/api/user/preferences/')) {
					return method === 'GET' || method === 'PUT';
				}
				// Own linked media-server avatar (image proxy, self only).
				if (path.startsWith('/api/user/media-server/avatar/')) {
					return method === 'GET';
				}
				// Self-uploaded avatar: upload/remove own (self-scoped server-side),
				// read any account's (renders in shared UI, same as the proxy above).
				if (path === '/api/user/avatar') {
					return method === 'POST' || method === 'DELETE';
				}
				if (path.startsWith('/api/user/avatar/')) {
					return method === 'GET';
				}
				// Media requests: creation + own-pending cancellation + reads.
				// Self-scope is enforced server-side in the routes; admin
				// mutations (approve/decline/retry/fulfill/bulk under
				// /api/requests/...) only allow GET/DELETE here, so their POSTs
				// fall through to the admin gate below.
				if (path === '/api/requests') {
					return method === 'GET' || method === 'POST';
				}
				if (path.startsWith('/api/requests/')) {
					return method === 'GET' || method === 'DELETE';
				}
				// Own in-app notification feed (GET) + mark-read (POST on /read).
				if (path === '/api/user/notifications') {
					return method === 'GET';
				}
				if (path === '/api/user/notifications/read') {
					return method === 'POST';
				}
				// Client crash reports are public (they fire from /login before a
				// session exists) and same-origin gated in the endpoint itself, so
				// a signed-in viewer must be able to file one too.
				if (path === '/api/settings/logs/client-report') {
					return method === 'POST';
				}
				if (method !== 'GET' && method !== 'HEAD') {
					return false;
				}
				if (path === '/api/discover' || path.startsWith('/api/discover/')) {
					return true;
				}
				if (path === '/api/tmdb' || path.startsWith('/api/tmdb/')) {
					return true;
				}
				if (path === '/api/calendar' || path.startsWith('/api/calendar/')) {
					return true;
				}
				if (path === '/api/library/movies' || path.startsWith('/api/library/movies/')) {
					return true;
				}
				if (path === '/api/library/series' || path.startsWith('/api/library/series/')) {
					return true;
				}
				if (path === '/api/system/status') {
					return true;
				}
				return false;
			}

			// /api/auth is served by the catch-all route (api/auth/[[...all]]).
			// Auth requests flow through to the shared response tail — security
			// headers, correlation IDs, logging — but skip session resolution,
			// setup/login redirects, and rate limiting here: Better Auth owns its
			// own origin checks and database-backed rate limiter for those paths.
			const isAuthRoute =
				routePath === AUTH_BASE_PATH || routePath.startsWith(`${AUTH_BASE_PATH}/`);

			/**
			 * Session resolution, API-key gates, setup/login redirects, rate
			 * limiting, and legacy URL redirects for everything EXCEPT /api/auth.
			 * Returns a Response when the request must not reach the endpoint,
			 * null to continue to the shared response tail.
			 */
			const applyRequestGates = async (): Promise<Response | null> => {
				let session = null;
				let apiKey = null;

				if (!isStreamingApiRoute) {
					// Real Radarr/Sonarr accept the API key as either the X-Api-Key
					// header or an `apikey` query parameter (see the real openapi.json
					// securitySchemes) - arr clients like Jellyseerr/Overseerr (Seerr) use the
					// query parameter for their Radarr/Sonarr connections, so the
					// arr-compat routes need it accepted there too, not just the header.
					// Query-param credentials anywhere else would leak into proxy access
					// logs, browser history, and Referer headers, so they stay
					// arr-compat-only; the header works on every route.
					const isArrCompatRoute =
						routePath.startsWith('/api/radarr/') || routePath.startsWith('/api/sonarr/');
					const apiKeyHeader =
						event.request.headers.get('x-api-key') ||
						(isArrCompatRoute
							? event.url.searchParams.get('apikey') || event.url.searchParams.get('api_key')
							: null);
					if (apiKeyHeader) {
						// Only full-access (main) keys may bridge to an owner session
						// here. Streaming-scoped keys are playback-only credentials
						// designed to live in .m3u/.strm URLs where proxies and media
						// servers routinely log them — they must never authenticate the
						// general API surface, not even for their owner.
						const fullAccessKey = await auth.api
							.verifyApiKey({
								body: {
									key: apiKeyHeader,
									permissions: {
										default: ['*']
									}
								}
							})
							.then((verify) => verify.valid)
							.catch(() => false);
						if (fullAccessKey) {
							try {
								session = await auth.api.getSession({
									headers: new Headers({ 'x-api-key': apiKeyHeader })
								});
								apiKey = apiKeyHeader;
							} catch {
								// Invalid API key, continue to cookie auth
							}
						}
					}

					if (!session) {
						try {
							// Cookie-session resolution only. The raw request
							// headers still carry x-api-key, and the api-key
							// plugin's enableSessionForAPIKeys before-hook would
							// bridge ANY valid key — streaming-scoped included —
							// into a full owner session here, bypassing the
							// full-access gate above.
							const cookieOnlyHeaders = rewriteCookieHeaderForLocalHttp(
								event,
								new Headers(event.request.headers)
							);
							cookieOnlyHeaders.delete('x-api-key');
							session = await auth.api.getSession({
								headers: cookieOnlyHeaders
							});
						} catch {
							// getSession throws (instead of returning null) when the request
							// carries an invalid x-api-key header — treat it as anonymous so the
							// request 401s instead of erroring.
						}
					}

					if (session) {
						// Bootstrap repair: a non-admin session is promoted only
						// while exactly one account exists; with multiple
						// accounts a user-role session passes through un-promoted.
						if (
							session.user?.id &&
							session.user.role !== 'admin' &&
							(await repairCurrentUserAdminRole(session.user.id))
						) {
							session = { ...session, user: { ...session.user, role: 'admin' } };
						}

						setAuthenticatedLocals(event, session, apiKey);
					} else {
						clearAuthenticatedLocals(event);
					}
				} else {
					clearAuthenticatedLocals(event);
				}

				const setupComplete = await isSetupComplete();

				function isPublicRoute(path: string): boolean {
					if (path === '/login' || path.startsWith('/login/')) {
						return true;
					}
					if (isHealthRoute(path)) {
						return true;
					}
					// Client error reports must be receivable pre-auth — crashes on
					// /login happen before a session exists. The endpoint itself
					// enforces same-origin + payload validation.
					if (path === '/api/settings/logs/client-report') {
						return true;
					}
					return false;
				}

				if (isStreamingApiRoute) {
					const url = new URL(event.request.url);
					const apiKeyFromQuery = url.searchParams.get('api_key');
					const apiKeyFromHeader = event.request.headers.get('x-api-key');
					const apiKey = apiKeyFromQuery || apiKeyFromHeader;

					if (!apiKey) {
						return Response.json(
							{
								success: false,
								error: 'API key required',
								code: 'API_KEY_REQUIRED'
							},
							{
								status: 401,
								headers: {
									'x-correlation-id': correlationId,
									'x-support-id': supportId,
									...BASE_SECURITY_HEADERS
								}
							}
						);
					}

					try {
						// Accept either a streaming-scoped key or a full-access (main) key
						let verifyResult = await auth.api.verifyApiKey({
							body: {
								key: apiKey,
								permissions: {
									streaming: ['*']
								}
							}
						});

						if (!verifyResult.valid) {
							// Fall back to main API key check. Main keys are created with
							// { default: ['*'] }.
							verifyResult = await auth.api.verifyApiKey({
								body: {
									key: apiKey,
									permissions: {
										default: ['*']
									}
								}
							});
						}

						if (!verifyResult.valid) {
							requestLogger.warn(
								{
									logDomain: 'auth',
									endpoint: pathname,
									error: verifyResult.error?.message || 'Invalid permissions'
								},
								'[Auth] API key does not have streaming or full-access permissions'
							);

							return Response.json(
								{
									success: false,
									error: 'Unauthorized',
									code: 'UNAUTHORIZED'
								},
								{
									status: 401,
									headers: {
										'x-correlation-id': correlationId,
										'x-support-id': supportId,
										...BASE_SECURITY_HEADERS
									}
								}
							);
						}

						// Bans must reach streaming too: verifyApiKey only inspects
						// the key row, so a banned owner's key would otherwise keep
						// playing until the key-disable side of the ban flow lands.
						// (user.update.after in auth.ts is the durable side of this.)
						const keyOwnerId =
							typeof verifyResult.key?.referenceId === 'string'
								? verifyResult.key.referenceId
								: null;
						if (keyOwnerId) {
							const owner = db
								.select({ banned: user.banned })
								.from(user)
								.where(eq(user.id, keyOwnerId))
								.get();
							if (owner?.banned) {
								requestLogger.warn(
									{ logDomain: 'auth', endpoint: pathname },
									'[Auth] Rejected streaming key for banned owner'
								);
								return Response.json(
									{
										success: false,
										error: 'Unauthorized',
										code: 'UNAUTHORIZED'
									},
									{
										status: 401,
										headers: {
											'x-correlation-id': correlationId,
											'x-support-id': supportId,
											...BASE_SECURITY_HEADERS
										}
									}
								);
							}
						}

						event.locals.apiKey = apiKey;
						event.locals.apiKeyPermissions = verifyResult.key?.permissions || null;
					} catch (error) {
						requestLogger.error(
							{
								err: error,
								logDomain: 'auth',
								endpoint: pathname
							},
							'[Auth] API key validation error'
						);

						return Response.json(
							{
								success: false,
								error: 'API key validation failed',
								code: 'INVALID_API_KEY'
							},
							{
								status: 401,
								headers: {
									'x-correlation-id': correlationId,
									...BASE_SECURITY_HEADERS
								}
							}
						);
					}
				} else {
					if (!setupComplete) {
						if (isHealthRoute(routePath)) {
							return resolve(event);
						}
						if (!routePath.startsWith('/setup')) {
							throw redirect(302, '/setup');
						}
					} else {
						if (!event.locals.user && !isPublicRoute(routePath)) {
							if (routePath.startsWith('/api/')) {
								return Response.json(
									{
										success: false,
										error: 'Unauthorized',
										code: 'UNAUTHORIZED'
									},
									{
										status: 401,
										headers: {
											'x-correlation-id': correlationId,
											'x-support-id': supportId,
											...SECURITY_HEADERS
										}
									}
								);
							}

							throw redirect(302, '/login');
						}
					}
				}

				// Viewer API gate: once authenticated, non-admin sessions are
				// confined to the read-only surfaces. Streaming routes never
				// resolve a session here (locals.user stays null), so they are
				// unaffected; admins and admin-owned API keys pass through.
				// A banned flag also fails closed for every role — banning
				// deletes sessions, so this only catches races and replays.
				// Percent-encoded slashes fail closed: no allowlisted prefix
				// legitimately contains %2f, and a router that decoded one into
				// a separator would turn "/api/library/movies%2f..%2f" into an
				// arbitrary path.
				if (
					routePath.startsWith('/api/') &&
					event.locals.user &&
					(event.locals.user.role !== 'admin' || event.locals.user.banned)
				) {
					const method = event.request.method.toUpperCase();
					const hasEncodedSlash = /%2f/i.test(routePath);
					if (hasEncodedSlash || !isViewerAllowedApiPath(routePath, method)) {
						return Response.json(
							{
								success: false,
								error: 'Forbidden. Admin access required.',
								code: 'FORBIDDEN'
							},
							{
								status: 403,
								headers: {
									'x-correlation-id': correlationId,
									'x-support-id': supportId,
									...SECURITY_HEADERS
								}
							}
						);
					}
				}

				if (routePath.startsWith('/api/')) {
					const rateLimitResponse = checkApiRateLimit(event);
					if (rateLimitResponse) {
						return rateLimitResponse;
					}
				}

				if (setupComplete && event.locals.user) {
					if (routePath === '/setup' || routePath === '/login' || routePath.startsWith('/login/')) {
						throw redirect(302, '/');
					}
				}

				if (routePath === '/movies' || routePath === '/library/movie') {
					throw redirect(308, '/library/movies');
				}
				if (routePath === '/tv') {
					throw redirect(308, '/library/tv');
				}
				if (
					routePath === '/movie' ||
					routePath === '/discover/movie' ||
					routePath === '/discover/tv' ||
					routePath === '/discover/person' ||
					routePath === '/person'
				) {
					throw redirect(308, '/discover');
				}
				if (routePath.startsWith('/movie/')) {
					throw redirect(308, `/discover/movie/${routePath.slice('/movie/'.length)}`);
				}
				if (routePath.startsWith('/tv/')) {
					throw redirect(308, `/discover/tv/${routePath.slice('/tv/'.length)}`);
				}
				if (routePath.startsWith('/person/')) {
					throw redirect(308, `/discover/person/${routePath.slice('/person/'.length)}`);
				}

				return null;
			};

			if (!isAuthRoute) {
				const gateResponse = await applyRequestGates();
				if (gateResponse) {
					return gateResponse;
				}
			}

			const isStreamingRoute = routePath.startsWith('/api/streaming/');

			requestLogger.debug('Incoming request');

			const startTime = performance.now();

			try {
				const response = await resolve(event, {
					preload: ({ type }) => type !== 'js'
				});

				response.headers.set('x-correlation-id', correlationId);

				if (pathname.startsWith('/api/')) {
					const responseWithRateLimit = applyRateLimitHeaders(event, response);
					responseWithRateLimit.headers.forEach((value, key) => {
						if (key.startsWith('x-ratelimit')) {
							response.headers.set(key, value);
						}
					});
				}

				if (isStreamingRoute) {
					for (const [header, value] of Object.entries(BASE_SECURITY_HEADERS)) {
						response.headers.set(header, value);
					}
					response.headers.set('Access-Control-Allow-Origin', '*');
					response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
					response.headers.set('Access-Control-Allow-Headers', 'Range, Content-Type');
				} else {
					for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
						// SvelteKit's per-page CSP carries the hashes for its inline
						// bootstrap (kit.csp hash mode); overwriting it with the static
						// fallback would block client-side JS. API responses never get a
						// page CSP, so they keep the static header.
						if (header === 'Content-Security-Policy' && response.headers.has(header)) {
							continue;
						}
						response.headers.set(header, value);
					}
				}

				const duration = Math.round(performance.now() - startTime);
				requestLogger.debug({ status: response.status, durationMs: duration }, 'Request completed');

				// See stripSecureCookiesForLocalHttp's doc comment in `src/lib/server/auth/session-helpers.ts` (issue #596):
				// an https:// External URL makes every cookie Secure globally, which
				// silently breaks login over plain-http LAN access. This un-sets it
				// per-request, only for confidently-direct plain-HTTP LAN connections.
				return stripSecureCookiesForLocalHttp(event, response);
			} catch (error) {
				if (isStreamingRoute) {
					requestLogger.error({ err: error, logDomain: 'streams' }, 'Streaming route error');
					const message = error instanceof Error ? error.message : 'Stream error';
					return new Response(message, {
						status: 500,
						headers: {
							'Content-Type': 'text/plain',
							'x-correlation-id': correlationId,
							'x-support-id': supportId,
							...BASE_SECURITY_HEADERS
						}
					});
				}

				requestLogger.error({ err: error }, 'Unhandled error in request');

				if (isAppError(error)) {
					const response = Response.json(
						{
							success: false,
							...error.toJSON()
						},
						{
							status: error.statusCode,
							headers: {
								'x-correlation-id': correlationId,
								'x-support-id': supportId,
								...SECURITY_HEADERS
							}
						}
					);
					return response;
				}

				const response = Response.json(
					{
						success: false,
						error: 'Internal Server Error',
						code: 'INTERNAL_ERROR'
					},
					{
						status: 500,
						headers: {
							'x-correlation-id': correlationId,
							'x-support-id': supportId,
							...SECURITY_HEADERS
						}
					}
				);
				return response;
			}
		}
	);
};

export const handle = sequence(csrfGuard, localeHandler, customHandler);
