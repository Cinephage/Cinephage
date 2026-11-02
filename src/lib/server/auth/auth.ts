import { betterAuth } from 'better-auth';
import { username, admin } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { APIError } from 'better-auth/api';
import { logger } from '#lib/logging/index.js';
import { getAuthSecret, getBaseURL } from './secret.js';
import { getSharedSqliteConnection } from '#lib/server/db/connection.js';
import {
	createBetterAuthTables,
	createBetterAuthIndexes,
	convergeApikeySchemaToV15
} from '#lib/server/db/migration-helpers.js';
import { getSystemSettingsService } from '#lib/server/settings/SystemSettingsService.js';
import { ac, admin as adminRole, user as userRole } from '#lib/auth/access-control.js';
import { isHardReservedUsername, isValidUsernameFormat } from '#lib/auth/username-policy.js';
import { ensureSoleUserIsAdminRecord, getAdminCount, getUserRoleById } from './admin-bootstrap.js';
import { isSetupComplete, resetSetupCompleteCache, claimFirstUserBootstrap } from './setup.js';
import { isLocalNetworkOrigin } from '#lib/server/utils/origin.js';

function getFirstForwardedHeaderValue(value: string | null): string | null {
	if (!value) {
		return null;
	}

	const first = value
		.split(',')
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	return first ?? null;
}

function getForwardedOrigin(request: Request): string | null {
	const forwardedHost = getFirstForwardedHeaderValue(request.headers.get('x-forwarded-host'));
	if (!forwardedHost) {
		return null;
	}

	const protoCandidate = getFirstForwardedHeaderValue(request.headers.get('x-forwarded-proto'));
	const forwardedProto =
		protoCandidate === 'http' || protoCandidate === 'https' ? protoCandidate : 'https';

	try {
		return new URL(`${forwardedProto}://${forwardedHost}`).origin;
	} catch {
		return null;
	}
}

/**
 * Username validator - checks shared format rules and hard-reserved namespaces
 */
function validateUsername(username: string): boolean {
	if (!isValidUsernameFormat(username)) {
		return false;
	}

	if (isHardReservedUsername(username)) {
		return false;
	}

	return true;
}

/**
 * Generate display username from username
 * e.g., "john_doe" -> "John Doe"
 */
function generateDisplayUsername(username: string): string {
	return username
		.split('_')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(' ');
}

// Better Auth 1.7 validates the database schema on first access and caches a
// mismatch permanently (only its own migrate clears the cache). The tables
// normally come from schema-sync at startup, but a request can reach auth
// before that runs on a fresh install — so create them here, idempotently,
// before betterAuth() is ever constructed. Databases created before apikey
// v1.5 additionally need their legacy userId column converged here, or the
// same first-access validation would latch a mismatch before migrations run.
const authDb = getSharedSqliteConnection();
createBetterAuthTables(authDb);
convergeApikeySchemaToV15(authDb);
createBetterAuthIndexes(authDb);

const disableSecureCookies = process.env.BETTER_AUTH_DISABLE_SECURE_COOKIES === 'true';
const useSecureCookies = !disableSecureCookies && getBaseURL().startsWith('https://');

/**
 * better-auth's `advanced.cookiePrefix` below, exported so the LAN-HTTP
 * cookie rewriting in session-helpers.ts can build/match the exact cookie
 * names better-auth generates (`${cookiePrefix}.session_token`, etc.)
 * without hardcoding the literal string in a second place.
 */
export const AUTH_COOKIE_PREFIX = 'cinephage';

/**
 * Better Auth configuration for Cinephage
 * Username-based authentication with no email required
 */
export const auth = betterAuth({
	// Get or auto-generate secret (works for Docker and bare-metal)
	// Better Auth requires a stable base URL for redirects/callbacks.
	// We prefer env, then saved external URL, then localhost for dev/LAN bootstrap.
	secret: getAuthSecret(),
	baseURL: getBaseURL(),

	// Allow Better Auth to infer the effective host when deployed behind a reverse proxy.
	trustedProxyHeaders: true,

	// Function form is required (not a static array) so origins can be resolved per-request
	// from env vars, the database external URL, and forwarded proxy headers.
	// better-auth calls this at init time with request=undefined to seed ctx.context.trustedOrigins,
	// and again per-request inside validateOrigin. We return [origin] when the origin is trusted
	// so matchesOriginPattern(origin, origin) trivially succeeds without depending on normalization.
	trustedOrigins: async (request) => {
		const trusted = new Set<string>();

		const addOrigin = (value: string) => {
			try {
				trusted.add(new URL(value).origin);
			} catch {
				// ignore malformed entries
			}
		};

		// Static dev origins
		for (const o of [
			'http://localhost:3000',
			'http://127.0.0.1:3000',
			'http://localhost:5173',
			'http://127.0.0.1:5173',
			'https://localhost:3000',
			'https://127.0.0.1:3000',
			'https://localhost:5173',
			'https://127.0.0.1:5173'
		]) {
			addOrigin(o);
		}

		// Request-specific origins — only available on per-request calls, not at init time
		if (request) {
			addOrigin(request.url);
			// X-Forwarded-Host is a browser-settable header, so a directly
			// exposed instance would let any web page nominate its own origin
			// as trusted. Deployments NOT behind a reverse proxy should set
			// BETTER_AUTH_TRUST_FORWARDED_ORIGINS=false.
			if (process.env.BETTER_AUTH_TRUST_FORWARDED_ORIGINS !== 'false') {
				const forwardedOrigin = getForwardedOrigin(request);
				if (forwardedOrigin) addOrigin(forwardedOrigin);
			}
		}

		// External URL from settings UI
		try {
			const settingsService = getSystemSettingsService();
			const externalUrl = await settingsService.getExternalUrl();
			if (externalUrl) addOrigin(externalUrl);
		} catch {
			// Database not ready yet; skip
		}

		if (process.env.BETTER_AUTH_URL) addOrigin(process.env.BETTER_AUTH_URL);
		if (process.env.ORIGIN) addOrigin(process.env.ORIGIN);

		if (process.env.BETTER_AUTH_TRUSTED_ORIGINS) {
			for (const o of process.env.BETTER_AUTH_TRUSTED_ORIGINS.split(',')) {
				addOrigin(o.trim());
			}
		}

		// Per-request bypass: if the Origin header is explicitly trusted (or is a local
		// network address), return [origin] as the sole pattern entry so better-auth's
		// matchesOriginPattern(origin, origin) trivially succeeds without normalization.
		if (request) {
			const origin = request.headers.get('origin');
			if (origin && (isLocalNetworkOrigin(origin) || trusted.has(origin))) {
				return [origin];
			}
		}

		return [...trusted];
	},

	// Use native SQLite adapter instead of Drizzle to avoid boolean binding issues
	database: authDb,

	// Declare the custom user column so $Infer session types cover it
	// (the column itself is owned by BETTER_AUTH_TABLE_DEFINITIONS).
	user: {
		additionalFields: {
			language: {
				type: 'string',
				required: false,
				input: false
			}
		},
		// Self-service account deletion from the profile page. No
		// sendDeleteAccountVerification: this is a self-hosted/trusted-admin app
		// (same trust model changePassword already relies on), so a correct
		// current password is enough. The existing databaseHooks.user.delete.before
		// guard below (last-admin check) still fires: it runs at internalAdapter.deleteUser, which this endpoint calls.
		deleteUser: {
			enabled: true
		}
	},

	// Enable email/password (required for username plugin)
	// The username plugin extends email/password auth
	emailAndPassword: {
		enabled: true,
		requireEmailVerification: false, // No email verification needed
		minPasswordLength: 8,
		maxPasswordLength: 128
	},

	// Enable username plugin
	plugins: [
		username({
			minUsernameLength: 3,
			maxUsernameLength: 32,
			usernameValidator: validateUsername
		}),
		apiKey({
			enableSessionForAPIKeys: true,
			apiKeyHeaders: ['x-api-key'],
			defaultPrefix: 'cinephage_',
			defaultKeyLength: 64,
			rateLimit: {
				enabled: true,
				timeWindow: 1000 * 60 * 60, // 1 hour
				maxRequests: 10000 // 10000 requests per hour per key
			},
			enableMetadata: true
		}),
		admin({
			ac,
			roles: {
				admin: adminRole,
				user: userRole
			}
		}),
		sveltekitCookies(getRequestEvent) // Must be last plugin for proper cookie handling
	],

	// Session configuration - 7 days
	session: {
		expiresIn: 60 * 60 * 24 * 7, // 7 days in seconds
		updateAge: 60 * 60 * 24, // Refresh every day
		storeSessionInDatabase: true,
		// No cookie cache: every request revalidates against the database
		// so bans, demotions, sign-outs, and password resets take effect
		// immediately. One indexed SQLite read per request is negligible
		// here; a cached cookie would leave a revocation replay window.
		cookieCache: {
			enabled: false
		}
	},

	// Rate limiting - 5 attempts per 15 minutes
	rateLimit: {
		enabled: true,
		window: 900, // 15 minutes
		max: 5, // 5 attempts
		storage: 'database'
	},

	// Database hooks for user management. Written for multi-user readiness:
	// single-account bootstrap behavior keys off the account count instead of
	// being unconditional, so enabling multiple accounts later is a policy
	// change, not auth-layer surgery.
	databaseHooks: {
		user: {
			create: {
				before: async (user, ctx) => {
					// Username policy on every creation path — the setup
					// wizard validates client-side, but the raw endpoints
					// (sign-up, admin createUser) don't run the plugin's
					// validator, so the invariant lives here. Cinephage signs
					// in by username, so an account without one could never
					// log in — require it outright (e.g. a createUser call
					// that forgot the `data: { username }` wrapper).
					if (typeof user.username !== 'string' || !validateUsername(user.username)) {
						throw new APIError('UNPROCESSABLE_ENTITY', {
							message: 'A valid username is required.'
						});
					}

					// Bootstrap: the very first account is always the admin.
					// The claim row is the mutex — a cached "no users yet" read
					// alone would let two parallel sign-ups both become admin.
					if (!(await isSetupComplete())) {
						// The insert hasn't happened yet — invalidate rather than
						// assume, so a failed insert can still be retried.
						resetSetupCompleteCache();

						if (await claimFirstUserBootstrap()) {
							return {
								data: {
									...user,
									role: 'admin'
								}
							};
						}

						// Another request claimed the bootstrap moments ago and
						// its user row is not visible yet — fall through to the
						// admin-creator requirement below instead of minting a
						// second admin.
					}

					// After bootstrap, public self-registration stays closed.
					// An admin session may still create accounts through the
					// admin plugin (auth.api.createUser) — that is the path the
					// user management surface uses.
					const creatorIsAdmin = ctx?.context?.session?.user?.role === 'admin';
					if (!creatorIsAdmin) {
						throw new APIError('FORBIDDEN', {
							message: 'User registration is disabled. Only admins can create accounts.'
						});
					}

					return {
						data: {
							...user,
							role: user.role ?? 'user'
						}
					};
				}
			},
			update: {
				before: async (data, ctx) => {
					// Usernames changed through the generic self-service
					// /update-user route bypass the username plugin's
					// validator (it only runs at sign-in and availability
					// checks). Enforce the shared policy here so no
					// authenticated account can claim a reserved or malformed
					// username.
					if (data.username !== undefined) {
						if (typeof data.username !== 'string' || !validateUsername(data.username)) {
							throw new APIError('UNPROCESSABLE_ENTITY', {
								message: 'Username does not meet the policy.'
							});
						}
					}

					// The instance must always keep at least one admin. When a
					// role change demotes an admin to user, count the remaining
					// admins and refuse if this is the last one.
					if (data.role === 'user' && ctx?.context?.session?.user?.role === 'admin') {
						// The admin-plugin routes carry the target in the body;
						// a self-update targets the session user.
						const targetId =
							(ctx?.context as { body?: { userId?: string } } | undefined)?.body?.userId ??
							ctx?.context?.session?.user?.id;
						if (targetId && (await getUserRoleById(targetId)) === 'admin') {
							if ((await getAdminCount()) <= 1) {
								throw new APIError('FORBIDDEN', {
									message: 'Cannot demote the only admin account.'
								});
							}
						}
					}
					return { data };
				},
				after: async (updated) => {
					// Bans must neutralize the account's API keys too: the
					// admin plugin revokes sessions, but keys would otherwise
					// keep authenticating (and streaming) for the banned
					// account. Unbanning re-enables them. Runs post-commit, so
					// a failed update never strands keys in the wrong state —
					// and the check is idempotent for unrelated user updates.
					const userId = typeof updated?.id === 'string' ? updated.id : null;
					if (userId) {
						try {
							const { setManagedApiKeysEnabled } = await import('./api-keys.js');
							await setManagedApiKeysEnabled(userId, !updated.banned);
						} catch (error) {
							logger.error(
								{ err: error, userId, logDomain: 'auth' },
								'[Auth] Failed to sync API key state with ban status'
							);
						}
					}
				}
			},
			delete: {
				before: async (deletedUser) => {
					// Same invariant on deletion: the admin plugin's removeUser
					// flows through here before the row goes away.
					if (deletedUser.role === 'admin') {
						if ((await getAdminCount()) <= 1) {
							throw new APIError('FORBIDDEN', {
								message: 'Cannot delete the only admin account.'
							});
						}
					}
					return true;
				}
			}
		},
		account: {
			update: {
				after: async (account, ctx) => {
					// A credential-provider password change performed by someone
					// OTHER than the account owner (admin reset via setUserPassword —
					// the plugin itself does not revoke sessions) kills every
					// session of the target, server-side, so the raw admin API
					// cannot leave stale authenticated sessions behind. Self-service
					// password changes (actor === owner) keep their sessions.
					//
					// The after-hook is shared with updateMany paths, where the
					// adapter resolves the affected rows to a COUNT rather than a
					// row object. `internalAdapter.updatePassword` uses
					// updateManyWithHooks, so `account` is a number there and
					// `account.userId` is undefined — the old guard silently skipped
					// revocation for exactly the admin-reset case it was written for.
					// Recover the target from the endpoint body instead.
					const bodyUserId =
						typeof (ctx as { body?: { userId?: unknown } } | undefined)?.body?.userId === 'string'
							? (ctx as { body: { userId: string } }).body.userId
							: null;
					const affected = account as unknown;
					const rowUserId =
						typeof affected === 'object' && affected !== null && 'userId' in affected
							? (affected as { userId?: unknown }).userId
							: undefined;
					const targetUserId =
						typeof rowUserId === 'string' ? rowUserId : (bodyUserId ?? undefined);

					const actor = ctx?.context?.session?.user;
					if (targetUserId && (!actor || actor.id !== targetUserId)) {
						try {
							const sqlite = getSharedSqliteConnection();
							const result = sqlite
								.prepare(`DELETE FROM session WHERE "userId" = ?`)
								.run(targetUserId);
							if (result.changes > 0) {
								logger.info(
									{ userId: targetUserId, revoked: result.changes, logDomain: 'auth' },
									'[Auth] Admin password reset revoked target sessions'
								);
							}
						} catch (error) {
							logger.error(
								{ err: error, userId: targetUserId, logDomain: 'auth' },
								'[Auth] Failed to revoke sessions after admin password reset'
							);
						}
					}
				}
			}
		}
	},

	advanced: {
		// X-Forwarded-For parsing for the DB-backed rate limiter. Without
		// trustedProxies, better-auth accepts any single-value XFF at face
		// value, so a directly-exposed instance lets brute-forcers rotate
		// their rate-limit bucket by sending a fresh fake XFF per request.
		// Restricting the walk to private ranges makes a proxy-appended socket
		// address the authoritative "last untrusted hop" behind a reverse
		// proxy, while direct spoofs resolve to the spoofed value only when
		// the request genuinely bypassed a proxy — the best available without
		// socket access inside better-auth.
		ipAddress: {
			trustedProxies: [
				'127.0.0.1/32',
				'::1/128',
				'10.0.0.0/8',
				'172.16.0.0/12',
				'192.168.0.0/16',
				'169.254.0.0/16',
				'fc00::/7',
				'fe80::/10'
			]
		},

		// Constant prefix: deriving it from the resolved base URL scheme meant a
		// scheme change (or saving an https external URL + restart) renamed the
		// cookies and silently logged everyone out. The Secure ATTRIBUTE below
		// still adapts per scheme; only the name is now stable. Existing https
		// deployments are logged out once by this rename.
		cookiePrefix: AUTH_COOKIE_PREFIX,

		useSecureCookies: useSecureCookies,

		defaultCookieAttributes: {
			httpOnly: true,
			secure: useSecureCookies,
			sameSite: 'lax'
		}
	}
});

export async function repairCurrentUserAdminRole(userId: string): Promise<boolean> {
	return ensureSoleUserIsAdminRecord(userId);
}

// Export helper functions
export { validateUsername, generateDisplayUsername };

// Inferred session shapes — the single source of truth for what
// App.Locals.user / App.Locals.session carry (see session-helpers.ts).
export type AuthSessionUser = typeof auth.$Infer.Session.user;
export type AuthSessionRecord = typeof auth.$Infer.Session.session;
