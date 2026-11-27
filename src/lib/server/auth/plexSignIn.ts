/**
 * Plex sign-in decision.
 *
 * Given the plex.tv account behind a freshly approved PIN, decide which
 * local account (if any) it signs in as. Pure decision logic - the
 * better-auth plugin (plex-plugin.ts) owns sessions and account creation.
 *
 * Rules:
 *   - The account must currently have access to an enabled Plex server
 *     configured here (re-read from plex.tv every time, so a revoked share
 *     stops working at once).
 *   - It signs in as the local account linked to it on one of those
 *     servers. Links on servers it can no longer reach don't count.
 *   - With no link, an account is provisioned only when the admin turned
 *     on "create accounts for new Plex users"; otherwise it's refused.
 */

import { eq, or, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { user } from '#lib/server/db/schema.js';
import { getSystemSettingsService } from '#lib/server/settings/SystemSettingsService.js';
import { isHardReservedUsername, isValidUsernameFormat } from '#lib/auth/username-policy.js';
import {
	mediaServerLinkService,
	type PlexServerAccess
} from '#lib/server/mediaServerLink/MediaServerLinkService.js';
import { placeholderEmail } from '#lib/server/mediaServerLink/MediaServerUserImportService.js';
import type { PlexAccount } from '#lib/server/mediaServerLink/plexTv.js';

export type PlexSignInDecision =
	| { outcome: 'existing'; userId: string }
	| {
			outcome: 'provision';
			username: string;
			email: string;
			servers: PlexServerAccess[];
	  }
	/** No configured Plex server is shared with this account. */
	| { outcome: 'no-access' }
	/** Has access, but no linked account and new-user sign-in is off. */
	| { outcome: 'not-linked' }
	/** Would provision, but the Plex name or email can't become an account. */
	| { outcome: 'account-unavailable' }
	/** Linked to different local accounts on different servers. */
	| { outcome: 'ambiguous' }
	| { outcome: 'server-error' };

async function isUsernameOrEmailTaken(username: string, email: string): Promise<boolean> {
	const [hit] = await db
		.select({ id: user.id })
		.from(user)
		.where(
			or(
				eq(sql`lower(${user.username})`, username.toLowerCase()),
				eq(sql`lower(${user.email})`, email.toLowerCase())
			)
		)
		.limit(1);
	return hit !== undefined;
}

export async function resolvePlexSignIn(account: PlexAccount): Promise<PlexSignInDecision> {
	const access = await mediaServerLinkService.findPlexAccess(account.id);
	if (access.outcome !== 'ok') return { outcome: 'server-error' };
	if (access.servers.length === 0) return { outcome: 'no-access' };

	const linkedUserIds = await mediaServerLinkService.findUsersLinkedToServerAccount(
		access.servers.map((server) => server.serverId),
		account.id
	);
	if (linkedUserIds.length === 1) {
		return { outcome: 'existing', userId: linkedUserIds[0]! };
	}
	if (linkedUserIds.length > 1) {
		return { outcome: 'ambiguous' };
	}

	if (!(await getSystemSettingsService().getPlexNewUserSignIn())) {
		return { outcome: 'not-linked' };
	}

	// The roster name is the Plex username (or a managed user's title).
	const username = access.servers[0]!.serverUsername;
	if (!isValidUsernameFormat(username) || isHardReservedUsername(username)) {
		return { outcome: 'account-unavailable' };
	}
	const email = account.email ?? placeholderEmail(username, access.servers[0]!.serverName);
	if (await isUsernameOrEmailTaken(username, email)) {
		return { outcome: 'account-unavailable' };
	}

	return { outcome: 'provision', username, email, servers: access.servers };
}
