/**
 * Media server user import.
 *
 * Bulk-creates local accounts from a media server's user directory and links
 * each one to its server account, so an admin can stand up Cinephage's user
 * list from an existing Jellyfin or Plex (and later Emby) deployment in one
 * pass.
 *
 * Media servers never expose their users' passwords, so every imported
 * account gets a unique generated temporary password that is returned once
 * to the admin for hand-off; the account owner changes it after signing in.
 * The exception is a Plex server with "Sign in with Plex" on: its users
 * sign in through Plex, so their accounts are created with no password at
 * all and local (username + password) login stays off for them.
 *
 * Nothing here trusts the preview: importUsers re-fetches the roster and
 * re-validates every selected user against fresh local state immediately
 * before creating it.
 */

import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { user, userMediaServerLinks } from '#lib/server/db/schema.js';
import { getMediaBrowserManager } from '#lib/server/notifications/mediabrowser/MediaBrowserManager.js';
import { isHardReservedUsername, isValidUsernameFormat } from '#lib/auth/username-policy.js';
import { createChildLogger } from '#lib/logging/index.js';
import {
	mediaServerLinkService,
	serverTypeSupportsUserDirectory,
	type ServerUserOption
} from './MediaServerLinkService.js';

const logger = createChildLogger({ module: 'MediaServerUserImport', logDomain: 'auth' });

export const MAX_IMPORT_BATCH = 100;

const PASSWORD_LENGTH = 20;
// No l/I/0/O/1: temp passwords are handed out verbally and retyped by hand.
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type ImportCandidateStatus =
	| 'importable'
	/** Email matches an existing, not-yet-linked local account: link it. */
	| 'link-existing'
	/** Email matches an administrator: refused, the owner links it themselves. */
	| 'email-admin'
	| 'linked'
	| 'disabled'
	| 'invalid-username'
	| 'username-taken'
	| 'email-taken';

/** Statuses the admin can select; everything else is blocked. */
export function isSelectableStatus(status: ImportCandidateStatus): boolean {
	return status === 'importable' || status === 'link-existing';
}

export type ImportCandidate = {
	id: string;
	name: string;
	isAdministrator: boolean;
	status: ImportCandidateStatus;
	/**
	 * Local username involved: the account this server account is already
	 * linked to ('linked'), or the account the import would link it to
	 * ('link-existing'). Null otherwise.
	 */
	linkedTo: string | null;
	/**
	 * Email the import would assign: the account's own address when the
	 * server exposes one (Plex), else a placeholder derived from the name.
	 */
	suggestedEmail: string;
};

export type ImportPreviewResult =
	| {
			outcome: 'ok';
			users: ImportCandidate[];
			/** New accounts will be Plex-sign-in only (no password generated). */
			plexSignInOnly: boolean;
	  }
	| { outcome: 'no-server' }
	| { outcome: 'server-error' };

export type ImportRowResult = {
	serverUserId: string;
	serverUsername: string;
	/** 'linked': attached to an existing account - no account was created. */
	status: 'created' | 'linked' | 'failed';
	/** Human-readable failure or link-conflict reason; null on clean rows. */
	error: string | null;
	userId: string | null;
	username: string | null;
	email: string | null;
	tempPassword: string | null;
	linked: boolean;
	/** Created without a password: signs in with Plex only. */
	plexSignInOnly: boolean;
};

export type ImportUsersResult =
	| { outcome: 'ok'; results: ImportRowResult[] }
	| { outcome: 'no-server' }
	| { outcome: 'server-error' };

/**
 * Account-creation seam; the endpoint binds it to auth.api.createUser. No
 * password means no credential account, i.e. no local login.
 */
export type ImportedUserCreator = (input: {
	username: string;
	email: string;
	password?: string;
}) => Promise<{ userId: string }>;

export function placeholderEmail(username: string, serverName: string): string {
	const slug =
		serverName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'server';
	return `${username.toLowerCase()}@${slug}.users.local`;
}

function generateTempPassword(): string {
	const bytes = new Uint32Array(PASSWORD_LENGTH);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]).join('');
}

/** Status message for a candidate blocked from import; null when importable. */
export function importBlockReason(status: ImportCandidateStatus): string | null {
	switch (status) {
		case 'importable':
		case 'link-existing':
			return null;
		case 'linked':
			return 'Already linked to a local account';
		case 'disabled':
			return 'Disabled on the media server';
		case 'invalid-username':
			return 'Name does not meet the username policy';
		case 'username-taken':
			return 'A local account already uses this username';
		case 'email-taken':
			return 'The local account with this email is already linked to another server account';
		case 'email-admin':
			return 'Matches an administrator account - link it from that account, not here';
	}
}

type LocalAccount = { userId: string; username: string; role: string };

type ClassifyContext = {
	serverName: string;
	linkedTo: Map<string, string>;
	takenUsernames: Set<string>;
	usersByEmail: Map<string, LocalAccount>;
	usersLinkedOnServer: Set<string>;
};

class MediaServerUserImportService {
	/**
	 * Roster plus the local state needed to classify it. Shared by preview
	 * and import so both compute statuses identically.
	 */
	private async loadContext(serverId: string): Promise<
		| {
				outcome: 'ok';
				serverName: string;
				plexSignInOnly: boolean;
				roster: ServerUserOption[];
				linkedTo: Map<string, string>;
				takenUsernames: Set<string>;
				usersByEmail: Map<string, LocalAccount>;
				usersLinkedOnServer: Set<string>;
		  }
		| { outcome: 'no-server' }
		| { outcome: 'server-error' }
	> {
		const server = await getMediaBrowserManager().getServerRecord(serverId);
		if (!server || !server.enabled || !serverTypeSupportsUserDirectory(server.serverType)) {
			return { outcome: 'no-server' };
		}

		const roster = await mediaServerLinkService.listServerUsers(serverId);
		if (!roster) {
			return { outcome: 'server-error' };
		}

		const linkRows = await db
			.select({
				serverUserId: userMediaServerLinks.serverUserId,
				userId: userMediaServerLinks.userId,
				username: user.username
			})
			.from(userMediaServerLinks)
			.innerJoin(user, eq(userMediaServerLinks.userId, user.id))
			.where(eq(userMediaServerLinks.serverId, serverId));

		const localUsers = await db
			.select({ id: user.id, username: user.username, email: user.email, role: user.role })
			.from(user);

		return {
			outcome: 'ok',
			serverName: server.name,
			plexSignInOnly: server.serverType === 'plex' && server.plexSignIn === true,
			roster,
			linkedTo: new Map(
				linkRows
					.filter((row) => row.username !== null)
					.map((row) => [row.serverUserId, row.username as string])
			),
			takenUsernames: new Set(
				localUsers
					.map((row) => row.username?.toLowerCase())
					.filter((username): username is string => username !== undefined)
			),
			usersByEmail: new Map(
				localUsers
					.filter((row) => row.email && row.username)
					.map((row) => [
						row.email!.toLowerCase(),
						{ userId: row.id, username: row.username as string, role: row.role }
					])
			),
			usersLinkedOnServer: new Set(linkRows.map((row) => row.userId))
		};
	}

	private classify(
		entry: ServerUserOption,
		context: ClassifyContext,
		actorUserId: string
	): ImportCandidate {
		const candidate: ImportCandidate = {
			id: entry.id,
			name: entry.name,
			isAdministrator: entry.isAdministrator,
			status: 'importable',
			linkedTo: null,
			suggestedEmail: entry.email?.trim() || placeholderEmail(entry.name, context.serverName)
		};

		const linkedTo = context.linkedTo.get(entry.id);
		if (linkedTo) {
			return { ...candidate, status: 'linked', linkedTo };
		}
		if (entry.isDisabled) {
			return { ...candidate, status: 'disabled' };
		}
		// Same email as an existing local account: that is the same person
		// (e.g. the Plex owner and their Cinephage admin), so link rather
		// than create - unless that account is already linked to a
		// different account on this server.
		const sameEmail = context.usersByEmail.get(candidate.suggestedEmail.toLowerCase());
		if (sameEmail) {
			if (context.usersLinkedOnServer.has(sameEmail.userId)) {
				return { ...candidate, status: 'email-taken' };
			}
			// The email is a claim the media server makes about itself, and a
			// link signs in as that account. An administrator account is only
			// linked by the administrator running the import, never by another
			// admin's roster; otherwise link it from the profile page, where
			// the Plex approval proves the account.
			if (sameEmail.role === 'admin' && sameEmail.userId !== actorUserId) {
				return { ...candidate, status: 'email-admin', linkedTo: sameEmail.username };
			}
			return { ...candidate, status: 'link-existing', linkedTo: sameEmail.username };
		}
		if (!isValidUsernameFormat(entry.name) || isHardReservedUsername(entry.name)) {
			return { ...candidate, status: 'invalid-username' };
		}
		// Case-insensitive: a Jellyfin "Bob" colliding with a local "bob"
		// would sign in as the same identity even though SQLite's unique
		// index is case-sensitive.
		if (context.takenUsernames.has(entry.name.toLowerCase())) {
			return { ...candidate, status: 'username-taken' };
		}
		return candidate;
	}

	/** Roster with per-user import status for the admin's picker. */
	async previewImport(serverId: string, actorUserId: string): Promise<ImportPreviewResult> {
		const context = await this.loadContext(serverId);
		if (context.outcome !== 'ok') {
			return context;
		}
		return {
			outcome: 'ok',
			users: context.roster.map((entry) => this.classify(entry, context, actorUserId)),
			plexSignInOnly: context.plexSignInOnly
		};
	}

	/**
	 * Create and link the selected server users. Every row is re-validated
	 * against the fresh context loaded here, so a stale preview can never
	 * import a user that was linked, taken, or disabled in the meantime.
	 */
	async importUsers(input: {
		serverId: string;
		serverUserIds: string[];
		createUser: ImportedUserCreator;
		/** The admin running the import; only they may link their own account. */
		actorUserId: string;
	}): Promise<ImportUsersResult> {
		const context = await this.loadContext(input.serverId);
		if (context.outcome !== 'ok') {
			return context;
		}

		const rosterById = new Map(context.roster.map((entry) => [entry.id, entry]));
		const results: ImportRowResult[] = [];

		for (const serverUserId of new Set(input.serverUserIds)) {
			const entry = rosterById.get(serverUserId);
			if (!entry) {
				results.push({
					serverUserId,
					serverUsername: serverUserId,
					status: 'failed',
					error: 'Unknown server user',
					userId: null,
					username: null,
					email: null,
					tempPassword: null,
					linked: false,
					plexSignInOnly: false
				});
				continue;
			}

			const candidate = this.classify(entry, context, input.actorUserId);
			const blockReason = importBlockReason(candidate.status);
			if (blockReason) {
				results.push({
					serverUserId,
					serverUsername: entry.name,
					status: 'failed',
					error: blockReason,
					userId: null,
					username: null,
					email: null,
					tempPassword: null,
					linked: false,
					plexSignInOnly: false
				});
				continue;
			}

			if (candidate.status === 'link-existing') {
				const target = context.usersByEmail.get(candidate.suggestedEmail.toLowerCase())!;
				const link = await mediaServerLinkService.linkValidatedServerUser(
					target.userId,
					input.serverId,
					entry.id,
					entry.name
				);
				const linked = !('conflict' in link);
				results.push({
					serverUserId,
					serverUsername: entry.name,
					status: linked ? 'linked' : 'failed',
					error: linked ? null : 'The existing account could not be linked (link conflict)',
					userId: linked ? target.userId : null,
					username: target.username,
					email: candidate.suggestedEmail,
					tempPassword: null,
					linked,
					plexSignInOnly: false
				});
				if (linked) context.usersLinkedOnServer.add(target.userId);
				continue;
			}

			const tempPassword = context.plexSignInOnly ? null : generateTempPassword();
			try {
				const { userId } = await input.createUser({
					username: candidate.name,
					email: candidate.suggestedEmail,
					...(tempPassword ? { password: tempPassword } : {})
				});

				const link = await mediaServerLinkService.linkValidatedServerUser(
					userId,
					input.serverId,
					entry.id,
					entry.name
				);
				const linked = !('conflict' in link);
				if (!linked) {
					logger.warn(
						{ serverId: input.serverId, serverUserId, userId },
						'[MediaServerUserImport] Account created but linking hit a conflict'
					);
				}

				results.push({
					serverUserId,
					serverUsername: entry.name,
					status: 'created',
					error: linked ? null : 'Account created, but the server link hit a conflict',
					userId,
					username: candidate.name,
					email: candidate.suggestedEmail,
					tempPassword,
					linked,
					plexSignInOnly: context.plexSignInOnly
				});

				// Later rows in the same batch must see earlier creations.
				context.takenUsernames.add(candidate.name.toLowerCase());
				context.usersByEmail.set(candidate.suggestedEmail.toLowerCase(), {
					userId,
					username: candidate.name
				});
				if (linked) context.usersLinkedOnServer.add(userId);
			} catch (error) {
				const message =
					error instanceof Error && error.message ? error.message : 'Account creation failed';
				results.push({
					serverUserId,
					serverUsername: entry.name,
					status: 'failed',
					error: message,
					userId: null,
					username: null,
					email: null,
					tempPassword: null,
					linked: false,
					plexSignInOnly: false
				});
			}
		}

		const created = results.filter((row) => row.status === 'created').length;
		const linkedExisting = results.filter((row) => row.status === 'linked').length;
		logger.info(
			{
				serverId: input.serverId,
				created,
				linkedExisting,
				failed: results.length - created - linkedExisting
			},
			'[MediaServerUserImport] Bulk import finished'
		);
		return { outcome: 'ok', results };
	}
}

export const mediaServerUserImportService = new MediaServerUserImportService();
