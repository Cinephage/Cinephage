/**
 * Media server user import.
 *
 * Bulk-creates local accounts from a media server's user directory and links
 * each one to its server account, so an admin can stand up Cinephage's user
 * list from an existing Jellyfin (and later Emby/Plex) deployment in one
 * pass.
 *
 * Media servers never expose their users' passwords, so every imported
 * account gets a unique generated temporary password that is returned once
 * to the admin for hand-off; the account owner changes it after signing in.
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
	'importable' | 'linked' | 'disabled' | 'invalid-username' | 'username-taken' | 'email-taken';

export type ImportCandidate = {
	id: string;
	name: string;
	isAdministrator: boolean;
	status: ImportCandidateStatus;
	/** Local username this server account is already linked to ('linked' only). */
	linkedTo: string | null;
	/** Placeholder email the import would assign; servers carry no email. */
	suggestedEmail: string;
};

export type ImportPreviewResult =
	| { outcome: 'ok'; users: ImportCandidate[] }
	| { outcome: 'no-server' }
	| { outcome: 'server-error' };

export type ImportRowResult = {
	serverUserId: string;
	serverUsername: string;
	status: 'created' | 'failed';
	/** Human-readable failure or link-conflict reason; null on clean rows. */
	error: string | null;
	userId: string | null;
	username: string | null;
	email: string | null;
	tempPassword: string | null;
	linked: boolean;
};

export type ImportUsersResult =
	| { outcome: 'ok'; results: ImportRowResult[] }
	| { outcome: 'no-server' }
	| { outcome: 'server-error' };

/** Account-creation seam; the endpoint binds it to auth.api.createUser. */
export type ImportedUserCreator = (input: {
	username: string;
	email: string;
	password: string;
}) => Promise<{ userId: string }>;

function placeholderEmail(username: string, serverName: string): string {
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
			return 'A local account already uses the placeholder email';
	}
}

class MediaServerUserImportService {
	/**
	 * Roster plus the local state needed to classify it. Shared by preview
	 * and import so both compute statuses identically.
	 */
	private async loadContext(serverId: string): Promise<
		| {
				outcome: 'ok';
				serverName: string;
				roster: ServerUserOption[];
				linkedTo: Map<string, string>;
				takenUsernames: Set<string>;
				takenEmails: Set<string>;
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
				username: user.username
			})
			.from(userMediaServerLinks)
			.innerJoin(user, eq(userMediaServerLinks.userId, user.id))
			.where(eq(userMediaServerLinks.serverId, serverId));

		const localUsers = await db.select({ username: user.username, email: user.email }).from(user);

		return {
			outcome: 'ok',
			serverName: server.name,
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
			takenEmails: new Set(
				localUsers
					.map((row) => row.email?.toLowerCase())
					.filter((email): email is string => email !== undefined)
			)
		};
	}

	private classify(
		entry: ServerUserOption,
		context: {
			serverName: string;
			linkedTo: Map<string, string>;
			takenUsernames: Set<string>;
			takenEmails: Set<string>;
		}
	): ImportCandidate {
		const candidate: ImportCandidate = {
			id: entry.id,
			name: entry.name,
			isAdministrator: entry.isAdministrator,
			status: 'importable',
			linkedTo: null,
			suggestedEmail: placeholderEmail(entry.name, context.serverName)
		};

		const linkedTo = context.linkedTo.get(entry.id);
		if (linkedTo) {
			return { ...candidate, status: 'linked', linkedTo };
		}
		if (entry.isDisabled) {
			return { ...candidate, status: 'disabled' };
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
		if (context.takenEmails.has(candidate.suggestedEmail.toLowerCase())) {
			return { ...candidate, status: 'email-taken' };
		}
		return candidate;
	}

	/** Roster with per-user import status for the admin's picker. */
	async previewImport(serverId: string): Promise<ImportPreviewResult> {
		const context = await this.loadContext(serverId);
		if (context.outcome !== 'ok') {
			return context;
		}
		return {
			outcome: 'ok',
			users: context.roster.map((entry) => this.classify(entry, context))
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
					linked: false
				});
				continue;
			}

			const candidate = this.classify(entry, context);
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
					linked: false
				});
				continue;
			}

			const tempPassword = generateTempPassword();
			try {
				const { userId } = await input.createUser({
					username: candidate.name,
					email: candidate.suggestedEmail,
					password: tempPassword
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
					linked
				});

				// Later rows in the same batch must see earlier creations.
				context.takenUsernames.add(candidate.name.toLowerCase());
				context.takenEmails.add(candidate.suggestedEmail.toLowerCase());
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
					linked: false
				});
			}
		}

		const created = results.filter((row) => row.status === 'created').length;
		logger.info(
			{ serverId: input.serverId, created, failed: results.length - created },
			'[MediaServerUserImport] Bulk import finished'
		);
		return { outcome: 'ok', results };
	}
}

export const mediaServerUserImportService = new MediaServerUserImportService();
