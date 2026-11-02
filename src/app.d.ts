// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

declare global {
	namespace App {
		interface Error {
			message: string;
			code?: string;
			supportId?: string;
		}
		interface Locals {
			/** Unique identifier for request tracing */
			correlationId: string;
			/** Canonical request identifier for structured logs */
			requestId: string;
			/** Safe user-facing identifier for support/debugging */
			supportId: string;
			/** Request-scoped logger */
			logger: import('#lib/logging/index.js').AppLogger;
			/** Current authenticated user, typed by Better Auth inference (null if not logged in) */
			user: import('#lib/server/auth/auth.js').AuthSessionUser | null;
			/** Current session, typed by Better Auth inference (null if not logged in) */
			session: import('#lib/server/auth/auth.js').AuthSessionRecord | null;
			/** API key used for authentication (null if not using API key) */
			apiKey: string | null;
			/** API key permissions if authenticated via API key (null otherwise) */
			apiKeyPermissions: Record<string, string[]> | null;
		}
		// interface PageData {}
		interface PageState {
			supportId?: string;
		}
		// interface Platform {}
	}
}

export {};
