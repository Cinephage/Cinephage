import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureColumn } from '../migration-helpers.js';

/**
 * Version 162: session.lastActiveAt and user.lastActiveAt.
 *
 * better-auth only touches session.updatedAt once per session.updateAge (a
 * day), so it's too coarse for the profile page's "last active" display.
 * Both columns are written together on a short throttle by touchLastActive
 * in src/lib/server/auth/session-helpers.ts: the session-scoped one powers
 * the per-device list on the profile page, and the user-scoped one survives
 * that session being revoked (revocation hard-deletes the row; see
 * DELETE /api/user/sessions), so the admin users list can still show when
 * an account with no sessions left was last used.
 */
export const migration_v162: MigrationDefinition = {
	version: 162,
	name: 'session_and_user_last_active',
	apply: (sqlite) => {
		ensureColumn(sqlite, 'session', 'lastActiveAt', '"lastActiveAt" date');
		ensureColumn(sqlite, 'user', 'lastActiveAt', '"lastActiveAt" date');
	}
};
