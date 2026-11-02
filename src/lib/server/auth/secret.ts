import { getSharedSqliteConnection } from '#lib/server/db/connection.js';

const DEFAULT_BASE_URL = 'http://localhost:5173';
const BUILD_TIME_PLACEHOLDER = 'build-time-placeholder-do-not-use-in-production';

function normalizeUrl(url: string): string {
	return url.trim().replace(/\/+$/, '');
}

function getConfiguredExternalUrl(): string | null {
	// Runs during auth module init, before schema-sync may have created the
	// settings table — guard with sqlite_master and tolerate a missing table.
	try {
		const sqlite = getSharedSqliteConnection();
		const settingsTable = sqlite
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'`)
			.get();

		if (!settingsTable) {
			return null;
		}

		const row = sqlite
			.prepare(`SELECT "value" FROM "settings" WHERE "key" = 'external_url' LIMIT 1`)
			.get() as { value?: string } | undefined;

		if (!row?.value) {
			return null;
		}

		return normalizeUrl(row.value);
	} catch {
		return null;
	}
}

/**
 * Get the Better Auth secret from environment.
 *
 * The secret MUST be provided via the BETTER_AUTH_SECRET environment variable
 * at runtime. Test/build contexts use a fixed placeholder so type-checking and
 * vitest imports do not fail.
 *
 * WARNING: Changing this value will invalidate all active sessions and make
 * encrypted API keys in the database permanently unrecoverable.
 */
export function getAuthSecret(): string {
	// Read process.env directly and stay live: every runtime we ship (dev
	// server, adapter-node behind server.js + dotenv, vitest setup) populates
	// it, and tests/orchestrators rotate it after module init. SvelteKit 3's
	// declared $app/env/private bindings are captured at module load instead.
	const secret = process.env.BETTER_AUTH_SECRET?.trim();
	if (secret) {
		return secret;
	}

	// During vite builds and vitest runs there is no runtime auth flow.
	// SvelteKit 3's post-build route analysis imports server modules (e.g. the
	// better-auth instance below reads this at module scope), so the placeholder
	// must also apply to build workers running under NODE_ENV=production —
	// VITE_SSR_BUILD is only ever set by `npm run build`, never by the built
	// server's runtime (server.js / systemd), which still fails closed here.
	const isBuildOrTestContext =
		process.env.VITE_SSR_BUILD || process.env.VITEST || process.env.NODE_ENV === 'test';
	if (isBuildOrTestContext) {
		return BUILD_TIME_PLACEHOLDER;
	}

	throw new Error(
		'BETTER_AUTH_SECRET is not set. ' +
			'Add it to your .env file or pass it as an environment variable. ' +
			'Generate one with: openssl rand -base64 32 ' +
			"or node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" " +
			'or python3 -c "import secrets,base64; print(base64.b64encode(secrets.token_bytes(32)).decode())"'
	);
}

/**
 * Get the base URL for Better Auth
 * Priority:
 * 1. BETTER_AUTH_URL environment variable
 * 2. ORIGIN environment variable
 * 3. Saved external URL from system settings
 * 4. Local development fallback
 */
export function getBaseURL(): string {
	if (process.env.BETTER_AUTH_URL?.trim()) {
		return normalizeUrl(process.env.BETTER_AUTH_URL);
	}

	if (process.env.ORIGIN?.trim()) {
		return normalizeUrl(process.env.ORIGIN);
	}

	const externalUrl = getConfiguredExternalUrl();
	if (externalUrl) {
		return externalUrl;
	}

	return DEFAULT_BASE_URL;
}
