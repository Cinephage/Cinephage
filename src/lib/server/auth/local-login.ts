/**
 * Local (username + password) login availability.
 *
 * An account has local login exactly when it has a credential account row
 * with a password. Plex-only accounts (imported from, or provisioned by, a
 * Plex server with "Sign in with Plex" on) are created without one, so the
 * password sign-in route rejects them as invalid credentials. An admin
 * password reset (admin/set-user-password) creates the row, which is the
 * deliberate way to turn local login on for such an account.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { account } from '#lib/server/db/schema.js';

export async function hasLocalPassword(userId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: account.id })
		.from(account)
		.where(
			and(
				eq(account.userId, userId),
				eq(account.providerId, 'credential'),
				isNotNull(account.password)
			)
		)
		.limit(1);
	return row !== undefined;
}
