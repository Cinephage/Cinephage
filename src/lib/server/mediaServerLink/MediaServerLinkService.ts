/**
 * Media server account linking.
 *
 * Links a Cinephage account to its Jellyfin account through Quick Connect
 * pairing (or an admin-mediated assignment as fallback when a server has
 * Quick Connect disabled). The link is an identity mapping only:
 * serverUserId plus a username snapshot. The per-user access token that
 * the Quick Connect exchange returns is read for identity and discarded —
 * no user credentials are ever stored.
 *
 * Pairing secrets stay entirely server-side: the client only ever sees the
 * short-lived numeric code and polls this app, so only the initiating
 * Cinephage session can complete the exchange.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { mediaBrowserServers, userMediaServerLinks } from '#lib/server/db/schema.js';
import { getMediaBrowserManager } from '#lib/server/notifications/mediabrowser/MediaBrowserManager.js';
import { MediaBrowserClient } from '#lib/server/notifications/mediabrowser/MediaBrowserClient.js';
import type { MediaBrowserServerRecord } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'MediaServerLink', logDomain: 'auth' });

/** Quick Connect requests on the Jellyfin side expire after ~10 minutes. */
const PAIRING_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Device identity for pairing calls; distinct from the notifier's device. */
const LINK_DEVICE = 'cinephage-link';

/**
 * Server types whose user directory can be enumerated (and linked against).
 * Jellyfin today; Emby shares the /Users response shape and joins this set
 * once its linking support lands, Plex needs its own roster adapter.
 */
const SERVER_TYPES_WITH_USER_DIRECTORY: ReadonlySet<string> = new Set(['jellyfin']);

export function serverTypeSupportsUserDirectory(serverType: string): boolean {
	return SERVER_TYPES_WITH_USER_DIRECTORY.has(serverType);
}

export type LinkRecord = {
	serverId: string;
	serverName: string;
	serverType: string;
	serverUserId: string;
	serverUsername: string;
	linkedAt: string | null;
};

export type LinkableServer = {
	id: string;
	name: string;
	quickConnectEnabled: boolean;
};

export type ServerUserOption = {
	id: string;
	name: string;
	isAdministrator: boolean;
	isDisabled: boolean;
};

export type PairingInitiateResult =
	| { outcome: 'initiated'; code: string; expiresAt: number }
	| { outcome: 'already-linked'; link: LinkRecord }
	| { outcome: 'quick-connect-disabled' }
	| { outcome: 'no-server' }
	| { outcome: 'server-error'; message: string };

export type PairingStatusResult =
	| { outcome: 'pending' }
	| { outcome: 'linked'; link: LinkRecord }
	| { outcome: 'expired' }
	| { outcome: 'no-pairing' }
	| { outcome: 'conflict'; message: string }
	| { outcome: 'server-error'; message: string };

export type AdminLinkResult =
	| { outcome: 'linked'; link: LinkRecord }
	| { outcome: 'no-server' }
	| { outcome: 'unknown-server-user' }
	| { outcome: 'conflict'; message: string };

type PendingPairing = {
	userId: string;
	serverId: string;
	secret: string;
	code: string;
	expiresAt: number;
};

function authHeaders(server: MediaBrowserServerRecord): Record<string, string> {
	// Reuse the shared header builder, but under the pairing's own device
	// identity so tokens minted by Quick Connect could be attributed and
	// cleaned up separately from the notifier's device.
	const base = MediaBrowserClient.authHeadersFor(server.serverType, server.apiKey);
	if (typeof base.Authorization === 'string') {
		base.Authorization = base.Authorization.replace(
			'DeviceId="cinephage-server"',
			`DeviceId="${LINK_DEVICE}"`
		);
	}
	return base;
}

class MediaServerLinkService {
	/** In-flight pairings keyed by `${userId}:${serverId}`. */
	private readonly pending = new Map<string, PendingPairing>();

	private async getJellyfinServer(serverId: string): Promise<MediaBrowserServerRecord | null> {
		const server = await getMediaBrowserManager().getServerRecord(serverId);
		if (!server || !server.enabled || server.serverType !== 'jellyfin') {
			return null;
		}
		return server;
	}

	/** Server record for user-directory operations (roster listing, import). */
	private async getUserDirectoryServer(serverId: string): Promise<MediaBrowserServerRecord | null> {
		const server = await getMediaBrowserManager().getServerRecord(serverId);
		if (!server || !server.enabled || !serverTypeSupportsUserDirectory(server.serverType)) {
			return null;
		}
		return server;
	}

	private async jellyfinRequest(
		server: MediaBrowserServerRecord,
		path: string,
		init: RequestInit = {}
	): Promise<Response> {
		return fetch(`${server.host.replace(/\/+$/, '')}${path}`, {
			...init,
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				...authHeaders(server),
				...init.headers
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	}

	private static pairingKey(userId: string, serverId: string): string {
		return `${userId}:${serverId}`;
	}

	async getLinkableServers(): Promise<LinkableServer[]> {
		const manager = getMediaBrowserManager();
		const servers = (await manager.getServers()).filter(
			(server) => server.enabled && server.serverType === 'jellyfin'
		);

		return Promise.all(
			servers.map(async (server) => {
				const record = await manager.getServerRecord(server.id);
				let quickConnectEnabled = false;
				if (record) {
					quickConnectEnabled = await this.isQuickConnectEnabled(record);
				}
				return { id: server.id, name: server.name, quickConnectEnabled };
			})
		);
	}

	async isQuickConnectEnabled(server: MediaBrowserServerRecord): Promise<boolean> {
		try {
			const response = await this.jellyfinRequest(server, '/QuickConnect/Enabled');
			if (!response.ok) return false;
			return (await response.json()) === true;
		} catch {
			return false;
		}
	}

	async getLinks(userId: string): Promise<LinkRecord[]> {
		const rows = await db
			.select({
				serverId: userMediaServerLinks.serverId,
				serverUserId: userMediaServerLinks.serverUserId,
				serverUsername: userMediaServerLinks.serverUsername,
				linkedAt: userMediaServerLinks.linkedAt,
				serverName: mediaBrowserServers.name,
				serverType: mediaBrowserServers.serverType
			})
			.from(userMediaServerLinks)
			.innerJoin(mediaBrowserServers, eq(userMediaServerLinks.serverId, mediaBrowserServers.id))
			.where(eq(userMediaServerLinks.userId, userId));

		return rows.map((row) => ({
			serverId: row.serverId,
			serverName: row.serverName,
			serverType: row.serverType,
			serverUserId: row.serverUserId,
			serverUsername: row.serverUsername,
			linkedAt: row.linkedAt
		}));
	}

	private async insertLink(
		userId: string,
		serverId: string,
		serverUserId: string,
		serverUsername: string
	): Promise<LinkRecord | { conflict: string }> {
		const [existingAccount] = await db
			.select({ userId: userMediaServerLinks.userId })
			.from(userMediaServerLinks)
			.where(
				and(
					eq(userMediaServerLinks.serverId, serverId),
					eq(userMediaServerLinks.serverUserId, serverUserId)
				)
			)
			.limit(1);
		if (existingAccount && existingAccount.userId !== userId) {
			return { conflict: 'server-account-linked-elsewhere' };
		}

		const [existingOwn] = await db
			.select({ serverUserId: userMediaServerLinks.serverUserId })
			.from(userMediaServerLinks)
			.where(
				and(eq(userMediaServerLinks.userId, userId), eq(userMediaServerLinks.serverId, serverId))
			)
			.limit(1);
		if (existingOwn) {
			// Refresh the snapshot in place (re-pairing the same account).
			await db
				.update(userMediaServerLinks)
				.set({ serverUsername, linkedAt: new Date().toISOString() })
				.where(
					and(eq(userMediaServerLinks.userId, userId), eq(userMediaServerLinks.serverId, serverId))
				);
		} else {
			await db.insert(userMediaServerLinks).values({
				userId,
				serverId,
				serverUserId,
				serverUsername
			});
		}

		const links = await this.getLinks(userId);
		return links.find((link) => link.serverId === serverId) ?? { conflict: 'insert-failed' };
	}

	/**
	 * Start a Quick Connect pairing for the given Cinephage user. The secret
	 * never leaves this process; only the numeric code is returned.
	 */
	async initiatePairing(userId: string, serverId: string): Promise<PairingInitiateResult> {
		const server = await this.getJellyfinServer(serverId);
		if (!server) {
			return { outcome: 'no-server' };
		}

		const links = await this.getLinks(userId);
		if (links.some((link) => link.serverId === serverId)) {
			return { outcome: 'already-linked', link: links.find((l) => l.serverId === serverId)! };
		}

		if (!(await this.isQuickConnectEnabled(server))) {
			return { outcome: 'quick-connect-disabled' };
		}

		try {
			const response = await this.jellyfinRequest(server, '/QuickConnect/Initiate', {
				method: 'POST'
			});
			if (!response.ok) {
				const message = `QuickConnect initiate failed with ${response.status}`;
				logger.warn({ serverId, status: response.status }, '[MediaServerLink] ' + message);
				return { outcome: 'server-error', message };
			}

			const result = (await response.json()) as { Secret?: string; Code?: string };
			if (!result.Secret || !result.Code) {
				return { outcome: 'server-error', message: 'Malformed QuickConnect response' };
			}

			const expiresAt = Date.now() + PAIRING_TTL_MS;
			this.pending.set(MediaServerLinkService.pairingKey(userId, serverId), {
				userId,
				serverId,
				secret: result.Secret,
				code: result.Code,
				expiresAt
			});

			return { outcome: 'initiated', code: result.Code, expiresAt };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'QuickConnect initiate failed';
			logger.error({ err: error, serverId }, '[MediaServerLink] initiate error');
			return { outcome: 'server-error', message };
		}
	}

	/**
	 * Poll a pending pairing; when Jellyfin reports the code authorized this
	 * exchanges the secret, reads the Jellyfin identity, DISCARDS the access
	 * token, and writes the link.
	 */
	async checkPairing(userId: string, serverId: string): Promise<PairingStatusResult> {
		const key = MediaServerLinkService.pairingKey(userId, serverId);
		const pending = this.pending.get(key);
		if (!pending || pending.expiresAt < Date.now()) {
			this.pending.delete(key);
			return { outcome: 'no-pairing' };
		}

		const server = await this.getJellyfinServer(serverId);
		if (!server) {
			return { outcome: 'no-pairing' };
		}

		try {
			const response = await this.jellyfinRequest(
				server,
				`/QuickConnect/Connect?secret=${encodeURIComponent(pending.secret)}`
			);
			if (response.status === 404) {
				this.pending.delete(key);
				return { outcome: 'expired' };
			}
			if (!response.ok) {
				return { outcome: 'server-error', message: `QuickConnect status ${response.status}` };
			}

			const status = (await response.json()) as { Authenticated?: boolean };
			if (!status.Authenticated) {
				return { outcome: 'pending' };
			}

			const exchange = await this.jellyfinRequest(server, '/Users/AuthenticateWithQuickConnect', {
				method: 'POST',
				body: JSON.stringify({ Secret: pending.secret })
			});
			if (!exchange.ok) {
				this.pending.delete(key);
				return { outcome: 'server-error', message: `QuickConnect exchange ${exchange.status}` };
			}

			const auth = (await exchange.json()) as {
				User?: { Id?: string; Name?: string };
			};
			if (!auth.User?.Id || !auth.User?.Name) {
				this.pending.delete(key);
				return { outcome: 'server-error', message: 'Malformed QuickConnect exchange' };
			}

			// Identity only: the AccessToken from the exchange is discarded.
			const inserted = await this.insertLink(userId, serverId, auth.User.Id, auth.User.Name);
			this.pending.delete(key);

			if ('conflict' in inserted) {
				return {
					outcome: 'conflict',
					message:
						inserted.conflict === 'server-account-linked-elsewhere'
							? 'This Jellyfin account is already linked to another user.'
							: 'Could not save the link.'
				};
			}

			logger.info(
				{ userId, serverId, serverUserId: auth.User.Id },
				'[MediaServerLink] Linked account via Quick Connect'
			);
			return { outcome: 'linked', link: inserted };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'QuickConnect poll failed';
			logger.error({ err: error, serverId }, '[MediaServerLink] poll error');
			return { outcome: 'server-error', message };
		}
	}

	/** Cancel a pending pairing (user closed the dialog). */
	cancelPairing(userId: string, serverId: string): void {
		this.pending.delete(MediaServerLinkService.pairingKey(userId, serverId));
	}

	/** List a server's users for the admin-mediated picker. */
	async listServerUsers(serverId: string): Promise<ServerUserOption[] | null> {
		const server = await this.getUserDirectoryServer(serverId);
		if (!server) return null;

		try {
			const response = await this.jellyfinRequest(server, '/Users');
			if (!response.ok) return null;
			const users = (await response.json()) as Array<{
				Id?: string;
				Name?: string;
				Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean };
			}>;
			return users
				.filter((user) => user.Id && user.Name)
				.map((user) => ({
					id: user.Id!,
					name: user.Name!,
					isAdministrator: Boolean(user.Policy?.IsAdministrator),
					isDisabled: Boolean(user.Policy?.IsDisabled)
				}));
		} catch (error) {
			logger.error({ err: error, serverId }, '[MediaServerLink] list users failed');
			return null;
		}
	}

	/** Admin-mediated link: assign a known server user to a Cinephage account. */
	async adminLink(
		userId: string,
		serverId: string,
		serverUserId: string
	): Promise<AdminLinkResult> {
		const server = await this.getJellyfinServer(serverId);
		if (!server) {
			return { outcome: 'no-server' };
		}

		const users = await this.listServerUsers(serverId);
		const target = users?.find((user) => user.id === serverUserId);
		if (!target) {
			return { outcome: 'unknown-server-user' };
		}

		const inserted = await this.insertLink(userId, serverId, target.id, target.name);
		if ('conflict' in inserted) {
			return {
				outcome: 'conflict',
				message:
					inserted.conflict === 'server-account-linked-elsewhere'
						? 'This Jellyfin account is already linked to another user.'
						: 'Could not save the link.'
			};
		}

		logger.info(
			{ userId, serverId, serverUserId },
			'[MediaServerLink] Linked account via admin assignment'
		);
		return { outcome: 'linked', link: inserted };
	}

	/**
	 * Link a server user the caller has already validated against a fresh
	 * roster fetch. Bulk import uses this so N links cost one /Users call
	 * instead of N; the insert itself still refuses cross-account
	 * duplicates, so a stale validation cannot steal an existing link.
	 */
	async linkValidatedServerUser(
		userId: string,
		serverId: string,
		serverUserId: string,
		serverUsername: string
	): Promise<LinkRecord | { conflict: string }> {
		return this.insertLink(userId, serverId, serverUserId, serverUsername);
	}

	/** Remove a link; scoped to the given Cinephage user. */
	async unlink(userId: string, serverId: string): Promise<boolean> {
		const deleted = await db
			.delete(userMediaServerLinks)
			.where(
				and(eq(userMediaServerLinks.userId, userId), eq(userMediaServerLinks.serverId, serverId))
			)
			.returning({ id: userMediaServerLinks.id });

		if (deleted.length > 0) {
			this.cancelPairing(userId, serverId);
			logger.info({ userId, serverId }, '[MediaServerLink] Unlinked account');
		}
		return deleted.length > 0;
	}

	/**
	 * Fetch a linked account's avatar image from its media server. Returns
	 * the raw body plus content type, or null when the user has no link on
	 * that server or the server has no image for the account.
	 */
	async fetchAvatar(
		userId: string,
		serverId: string
	): Promise<{ body: ArrayBuffer; contentType: string } | null> {
		const links = await this.getLinks(userId);
		const link = links.find((entry) => entry.serverId === serverId);
		if (!link || link.serverType !== 'jellyfin') {
			return null;
		}

		const server = await this.getJellyfinServer(serverId);
		if (!server) {
			return null;
		}

		try {
			const response = await this.jellyfinRequest(
				server,
				`/Users/${encodeURIComponent(link.serverUserId)}/Images/Primary`
			);
			if (!response.ok) {
				return null;
			}
			return {
				body: await response.arrayBuffer(),
				contentType: response.headers.get('content-type') ?? 'image/png'
			};
		} catch (error) {
			logger.debug({ err: error, serverId }, '[MediaServerLink] Avatar fetch failed');
			return null;
		}
	}
}

export const mediaServerLinkService = new MediaServerLinkService();
