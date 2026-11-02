import { createAuthClient } from 'better-auth/svelte';
import { usernameClient, adminClient } from 'better-auth/client/plugins';
import { ac, admin, user } from './access-control.js';
import { AUTH_BASE_PATH } from './config.js';

/**
 * Better Auth client for Svelte
 * Username-based authentication with admin capabilities
 *
 * This is the client-side auth client - import from #lib/auth/client
 * NOT from #lib/server/auth/client
 */
export const authClient = createAuthClient({
	basePath: AUTH_BASE_PATH,
	plugins: [
		usernameClient(),
		adminClient({
			ac,
			roles: {
				admin,
				user
			}
		})
	]
});

// Export types
type AuthClient = typeof authClient;
export type { AuthClient };
