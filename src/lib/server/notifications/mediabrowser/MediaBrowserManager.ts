/**
 * MediaBrowserManager - Manages Jellyfin, Emby, and Plex server configurations.
 * Provides CRUD operations and connection testing.
 */

import { db } from '#lib/server/db/index.js';
import { decryptApiKey } from '#lib/server/crypto/apiKeyCrypto.js';
import {
	decryptCredential,
	encryptCredential,
	isEncryptedCredential
} from '#lib/server/crypto/credentialsCrypto.js';
import {
	mediaBrowserServers,
	mediaServerSyncedItems,
	type MediaBrowserServerRecord
} from '#lib/server/db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
import { randomUUID } from 'node:crypto';
import { MediaBrowserClient } from './MediaBrowserClient';

// Delay before retrying a failed pre-delete (transient Jellyfin 500s during
// scanner races clear within a couple of seconds).
const PRE_DELETE_RETRY_DELAY_MS = 2000;
import type {
	MediaBrowserServerInput,
	MediaBrowserTestConfig,
	MediaBrowserTestResult,
	MediaBrowserServerPublic,
	MediaEventKind
} from './types';
import { MEDIA_EVENT_KIND_TOGGLE } from './types';

/**
 * Convert database record to public info (excludes API key)
 */
function toPublicInfo(record: MediaBrowserServerRecord): MediaBrowserServerPublic {
	return {
		id: record.id,
		name: record.name,
		serverType: record.serverType as MediaBrowserServerPublic['serverType'],
		host: record.host,
		enabled: record.enabled,
		onImport: record.onImport,
		onUpgrade: record.onUpgrade,
		onRename: record.onRename,
		onDelete: record.onDelete,
		pathMappings: record.pathMappings,
		serverName: record.serverName,
		serverVersion: record.serverVersion,
		serverId: record.serverId,
		lastTestedAt: record.lastTestedAt,
		testResult: record.testResult,
		testError: record.testError,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt
	};
}

class MediaBrowserManager {
	private clientCache: Map<string, MediaBrowserClient> = new Map();

	/**
	 * Get or create a client for a server
	 */
	getClient(serverId: string): MediaBrowserClient | null {
		return this.clientCache.get(serverId) ?? null;
	}

	/**
	 * Clear cached client for a server
	 */
	private clearClientCache(serverId: string): void {
		this.clientCache.delete(serverId);
	}

	/**
	 * Legacy `iv:tag:hex` ciphertext from apiKeyCrypto (pre-migration 161).
	 * New values use the versioned `cphg1.` envelope, detected exactly by
	 * isEncryptedCredential; plaintext rows that raced the encrypting
	 * migration remain tolerated.
	 */
	private static looksLegacyEncrypted(value: string): boolean {
		const parts = value.split(':');
		return parts.length === 3 && parts.every((p) => /^[0-9a-f]+$/i.test(p));
	}

	/**
	 * Decrypt the stored key, or null when the row looks like ciphertext but
	 * will not decrypt (rotated master key, corruption). Never returns
	 * the ciphertext itself: sending it to the media server would leak
	 * key material to a third party while masking the misconfiguration.
	 */
	private static decryptStoredKey(serverId: string, value: string): string | null {
		if (isEncryptedCredential(value)) {
			return decryptCredential(
				'media-browser-api-key',
				serverId,
				value,
				`media-browser:${serverId}`
			);
		}
		if (MediaBrowserManager.looksLegacyEncrypted(value)) {
			const plaintext = decryptApiKey(value);
			if (plaintext === null) {
				logger.error(
					{ logDomain: 'notifications', serverId },
					'[MediaBrowser] Stored API key failed to decrypt — the credential is being dropped. ' +
						'If the encryption master key was rotated, re-enter the server API key in settings.'
				);
			}
			return plaintext;
		}
		return value;
	}

	private static encryptStoredKey(serverId: string, value: string): string {
		if (isEncryptedCredential(value)) return value;
		return encryptCredential('media-browser-api-key', serverId, value);
	}

	/**
	 * Create and cache a client for a server record
	 */
	private createClient(record: MediaBrowserServerRecord): MediaBrowserClient {
		const client = new MediaBrowserClient({
			host: record.host,
			apiKey: record.apiKey,
			serverType: record.serverType as MediaBrowserServerPublic['serverType']
		});
		this.clientCache.set(record.id, client);
		return client;
	}

	// ========================================================================
	// CRUD Operations
	// ========================================================================

	/**
	 * Get all servers
	 */
	async getServers(): Promise<MediaBrowserServerPublic[]> {
		const records = await db
			.select()
			.from(mediaBrowserServers)
			.orderBy(asc(mediaBrowserServers.name));
		return records.map(toPublicInfo);
	}

	/**
	 * Get all enabled servers (with full record for internal use)
	 */
	async getEnabledServers(): Promise<MediaBrowserServerRecord[]> {
		const records = await db
			.select()
			.from(mediaBrowserServers)
			.where(eq(mediaBrowserServers.enabled, true))
			.orderBy(asc(mediaBrowserServers.name));
		return records.map((record) => ({
			...record,
			apiKey: MediaBrowserManager.decryptStoredKey(record.id, record.apiKey) ?? ''
		}));
	}

	/**
	 * Get a single server by ID
	 */
	async getServer(id: string): Promise<MediaBrowserServerPublic | null> {
		const [record] = await db
			.select()
			.from(mediaBrowserServers)
			.where(eq(mediaBrowserServers.id, id))
			.limit(1);

		return record ? toPublicInfo(record) : null;
	}

	/**
	 * Get a single server record (internal use, includes API key)
	 */
	async getServerRecord(id: string): Promise<MediaBrowserServerRecord | null> {
		const [record] = await db
			.select()
			.from(mediaBrowserServers)
			.where(eq(mediaBrowserServers.id, id))
			.limit(1);

		if (!record) return null;
		return {
			...record,
			apiKey: MediaBrowserManager.decryptStoredKey(record.id, record.apiKey) ?? ''
		};
	}

	/**
	 * Create a new server
	 */
	async createServer(input: MediaBrowserServerInput): Promise<MediaBrowserServerPublic> {
		const now = new Date().toISOString();
		const serverId = randomUUID();

		const newServer = {
			id: serverId,
			name: input.name,
			serverType: input.serverType,
			host: input.host.replace(/\/+$/, ''), // Normalize URL
			apiKey: MediaBrowserManager.encryptStoredKey(serverId, input.apiKey),
			enabled: input.enabled ?? true,
			onImport: input.onImport ?? true,
			onUpgrade: input.onUpgrade ?? true,
			onRename: input.onRename ?? true,
			onDelete: input.onDelete ?? true,
			pathMappings: input.pathMappings ?? null,
			createdAt: now,
			updatedAt: now
		};

		const [created] = await db.insert(mediaBrowserServers).values(newServer).returning();
		logger.info({ id: created.id, name: created.name }, '[MediaBrowserManager] Created server');
		return toPublicInfo(created);
	}

	/**
	 * Update a server
	 */
	async updateServer(
		id: string,
		input: Partial<MediaBrowserServerInput>
	): Promise<MediaBrowserServerPublic | null> {
		const existing = await this.getServerRecord(id);
		if (!existing) {
			return null;
		}

		const updates: Partial<MediaBrowserServerRecord> = {
			updatedAt: new Date().toISOString()
		};

		if (input.name !== undefined) updates.name = input.name;
		if (input.serverType !== undefined) updates.serverType = input.serverType;
		if (input.host !== undefined) updates.host = input.host.replace(/\/+$/, '');
		if (input.apiKey !== undefined)
			updates.apiKey = MediaBrowserManager.encryptStoredKey(id, input.apiKey);
		if (input.enabled !== undefined) updates.enabled = input.enabled;
		if (input.onImport !== undefined) updates.onImport = input.onImport;
		if (input.onUpgrade !== undefined) updates.onUpgrade = input.onUpgrade;
		if (input.onRename !== undefined) updates.onRename = input.onRename;
		if (input.onDelete !== undefined) updates.onDelete = input.onDelete;
		if (input.pathMappings !== undefined) updates.pathMappings = input.pathMappings;

		// If host or API key changed, clear the client cache
		if (input.host !== undefined || input.apiKey !== undefined) {
			this.clearClientCache(id);
		}

		const [updated] = await db
			.update(mediaBrowserServers)
			.set(updates)
			.where(eq(mediaBrowserServers.id, id))
			.returning();

		logger.info({ id, name: updated.name }, '[MediaBrowserManager] Updated server');

		// A disabled server's synced data stays in the DB (so re-enabling and
		// re-syncing is cheap) but must stop counting toward Storage
		// Maintenance immediately, not whenever some unrelated scan/import
		// happens to trigger the next reconcile. Lazy-import to avoid a
		// circular dependency (mirrors ReconciliationService's own pattern
		// for subscribing to its event sources).
		if (input.enabled !== undefined && input.enabled !== existing.enabled) {
			import('#lib/server/storage/reconciliation/ReconciliationService.js')
				.then(({ getReconciliationService }) => getReconciliationService().reconcile())
				.catch((e) => {
					logger.warn(
						{ id, error: e instanceof Error ? e.message : String(e) },
						'[MediaBrowserManager] Failed to trigger reconcile after enabled toggle'
					);
				});
		}

		return toPublicInfo(updated);
	}

	/**
	 * Delete a server
	 */
	async deleteServer(id: string): Promise<boolean> {
		const existing = await this.getServerRecord(id);
		if (!existing) {
			return false;
		}

		await db.delete(mediaBrowserServers).where(eq(mediaBrowserServers.id, id));
		this.clearClientCache(id);

		logger.info({ id, name: existing.name }, '[MediaBrowserManager] Deleted server');
		return true;
	}

	// ========================================================================
	// Testing
	// ========================================================================

	/**
	 * Test server configuration (before saving).
	 *
	 * The running server decides the type: the public product probe wins over
	 * the caller's pick (which is only a fallback when nothing answers), and a
	 * type mismatch that fails auth is retried with the detected type.
	 */
	async testServerConfig(config: MediaBrowserTestConfig): Promise<MediaBrowserTestResult> {
		const host = config.host.replace(/\/+$/, '');
		const detected = await MediaBrowserClient.detectServerType(host, config.apiKey);
		const serverType = detected?.type ?? config.serverType ?? 'jellyfin';

		const client = new MediaBrowserClient({
			host,
			apiKey: config.apiKey,
			serverType
		});

		const result = await client.test();

		if (!result.success && detected && detected.type !== serverType) {
			return new MediaBrowserClient({
				host,
				apiKey: config.apiKey,
				serverType: detected.type
			}).test();
		}

		return result;
	}

	/**
	 * Test a saved server and update its test status
	 */
	async testServer(
		id: string,
		options?: {
			host?: string;
			apiKey?: string;
			serverType?: MediaBrowserServerPublic['serverType'];
			persist?: boolean;
		}
	): Promise<MediaBrowserTestResult> {
		const record = await this.getServerRecord(id);
		if (!record) {
			return { success: false, error: 'Server not found' };
		}

		const hasOverrides =
			options?.host !== undefined ||
			options?.apiKey !== undefined ||
			options?.serverType !== undefined;

		const effectiveHost = options?.host?.trim() ? options.host : record.host;
		const effectiveApiKey = options?.apiKey?.trim() ? options.apiKey : record.apiKey;
		const effectiveServerType = (options?.serverType ??
			record.serverType) as MediaBrowserServerPublic['serverType'];

		const client = hasOverrides
			? new MediaBrowserClient({
					host: effectiveHost,
					apiKey: effectiveApiKey,
					serverType: effectiveServerType
				})
			: this.createClient(record);

		const result = await client.test();

		// For modal/preview tests, allow testing without persisting status on the saved server.
		if (options?.persist === false) {
			return result;
		}

		// Update the server with test results
		const updates: Partial<MediaBrowserServerRecord> = {
			lastTestedAt: new Date().toISOString(),
			testResult: result.success ? 'success' : 'failed',
			testError: result.error ?? null,
			updatedAt: new Date().toISOString()
		};

		if (result.success && result.serverInfo) {
			updates.serverName = result.serverInfo.serverName;
			updates.serverVersion = result.serverInfo.version;
			updates.serverId = result.serverInfo.id;

			// Connect/test is authoritative for which product runs: when the
			// server identifies itself as a different type than the stored one,
			// adopt the detected type (and drop the stale client).
			const detectedType = result.serverInfo.detectedType;
			if (detectedType && detectedType !== record.serverType) {
				updates.serverType = detectedType;
				this.clearClientCache(id);
				logger.info(
					{ id, storedType: record.serverType, detectedType },
					'[MediaBrowserManager] Corrected server type from running server'
				);
			}
		}

		await db.update(mediaBrowserServers).set(updates).where(eq(mediaBrowserServers.id, id));

		return result;
	}

	/**
	 * Persist test result metadata to the DB without re-running the test
	 */
	async recordTestResult(id: string, result: MediaBrowserTestResult): Promise<void> {
		const updates: Partial<MediaBrowserServerRecord> = {
			lastTestedAt: new Date().toISOString(),
			testResult: result.success ? 'success' : 'failed',
			testError: result.error ?? null,
			updatedAt: new Date().toISOString()
		};

		if (result.success && result.serverInfo) {
			updates.serverName = result.serverInfo.serverName;
			updates.serverVersion = result.serverInfo.version;
			updates.serverId = result.serverInfo.id;
		}

		await db.update(mediaBrowserServers).set(updates).where(eq(mediaBrowserServers.id, id));
	}

	// ========================================================================
	// Client Management
	// ========================================================================

	/**
	 * Get clients for all enabled servers
	 */
	async getEnabledClients(): Promise<
		Array<{ server: MediaBrowserServerRecord; client: MediaBrowserClient }>
	> {
		const servers = await this.getEnabledServers();
		return servers.map((server) => ({
			server,
			client: this.clientCache.get(server.id) ?? this.createClient(server)
		}));
	}

	/**
	 * Delete a media item (series or movie) from all enabled Jellyfin/Emby servers
	 * by its TMDB ID. DESTRUCTIVE on Jellyfin/Emby: their item-delete API also
	 * deletes the item's file location, so callers MUST only invoke this after
	 * the file/folder has already been moved locally (post-rename) — the stale
	 * stored path then makes the file deletion a no-op and the call only clears
	 * the old library entry (jellyfin#16883). Plex is skipped entirely.
	 *
	 * Best-effort: failures from unreachable servers or stale item IDs are logged
	 * but do not block the caller. A failed delete is retried once after a short
	 * delay (live-observed: Jellyfin can return a transient HTTP 500 while its own
	 * scanner races the delete); a second failure is warn-logged and skipped —
	 * never thrown. Returns the count of servers the item was successfully
	 * deleted from.
	 *
	 * @param options.eventKind - When given, servers whose matching event toggle
	 *   (e.g. onRename for 'rename') is disabled are skipped. Omit to target all
	 *   enabled servers (legacy behavior).
	 * @param options.retryDelayMs - Delay before the single retry (default 2s;
	 *   overridable for tests).
	 */
	async deleteMediaItemByTmdb(
		tmdbId: number,
		itemType: 'movie' | 'series',
		options?: { eventKind?: MediaEventKind; retryDelayMs?: number }
	): Promise<number> {
		if (!tmdbId) return 0;

		const retryDelayMs = options?.retryDelayMs ?? PRE_DELETE_RETRY_DELAY_MS;
		const servers = await this.getEnabledServers();
		let deleted = 0;

		for (const server of servers) {
			try {
				// Plex has no per-item delete API (deleteItem always returns false),
				// so attempting one just burns the retry delay and logs a misleading
				// warning. Plex reconciles renames via path-based section refreshes.
				if (server.serverType === 'plex') {
					continue;
				}

				if (options?.eventKind) {
					const toggle = server[MEDIA_EVENT_KIND_TOGGLE[options.eventKind]];
					if (toggle === false) {
						logger.debug(
							{
								serverId: server.id,
								serverName: server.name,
								eventKind: options.eventKind,
								tmdbId,
								itemType
							},
							'[MediaBrowserManager] Skipping pre-delete — server event toggle disabled'
						);
						continue;
					}
				}

				const synced = await db
					.select({ serverItemId: mediaServerSyncedItems.serverItemId })
					.from(mediaServerSyncedItems)
					.where(
						and(
							eq(mediaServerSyncedItems.serverId, server.id),
							eq(mediaServerSyncedItems.tmdbId, tmdbId),
							eq(mediaServerSyncedItems.itemType, itemType)
						)
					)
					.limit(1);

				if (synced.length === 0) continue;

				const client = this.clientCache.get(server.id) ?? this.createClient(server);
				const itemId = synced[0].serverItemId;

				let ok = await client.deleteItem(itemId);
				if (!ok) {
					// One retry after a short delay: Jellyfin has been observed to
					// fail with a transient 500 while its scanner is mid-pass over
					// the very item being deleted.
					await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
					ok = await client.deleteItem(itemId);
				}

				if (ok) {
					deleted++;
				} else {
					logger.warn(
						{
							serverId: server.id,
							serverName: server.name,
							tmdbId,
							itemType,
							itemId
						},
						'[MediaBrowserManager] Failed to delete media item from server after retry'
					);
				}
			} catch (error) {
				logger.warn(
					{
						serverId: server.id,
						serverName: server.name,
						tmdbId,
						itemType,
						error: error instanceof Error ? error.message : String(error)
					},
					'[MediaBrowserManager] Failed to delete media item from server'
				);
			}
		}

		if (deleted > 0) {
			logger.info(
				{ tmdbId, itemType, deleted },
				'[MediaBrowserManager] Deleted media item from servers before folder rename'
			);
		}

		return deleted;
	}
}

// Singleton instance
let managerInstance: MediaBrowserManager | null = null;

/**
 * Get the MediaBrowserManager singleton
 */
export function getMediaBrowserManager(): MediaBrowserManager {
	if (!managerInstance) {
		managerInstance = new MediaBrowserManager();
	}
	return managerInstance;
}

export { MediaBrowserManager };
