/**
 * DownloadClientManager - Central service for managing download clients.
 * Handles client configuration, testing, and download operations.
 */

import { db } from '#lib/server/db/index.js';
import { downloadClients as downloadClientsTable } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '#lib/logging/index.js';
import { decryptDebridToken } from '#lib/server/crypto/debridTokenCrypto.js';
import {
	decryptCredential,
	encryptCredential,
	isEncryptedCredential
} from '#lib/server/crypto/credentialsCrypto.js';

const logger = createChildLogger({ logDomain: 'imports' as const });

/** AAD purposes for the two credential columns this manager owns. */
const DL_PASSWORD_PURPOSE = 'dl-client-password';
const DEBRID_TOKEN_PURPOSE = 'debrid-token';

function encryptStoredPassword(clientId: string, password: string): string {
	return encryptCredential(DL_PASSWORD_PURPOSE, clientId, password);
}

function decryptStoredPassword(clientId: string, stored: string | null | undefined): string | null {
	if (!stored) return null;
	if (isEncryptedCredential(stored)) {
		return decryptCredential(DL_PASSWORD_PURPOSE, clientId, stored, `download-client:${clientId}`);
	}
	return stored; // plaintext tolerance for rows that raced the migration
}

function encryptStoredDebridToken(clientId: string, token: string): string {
	return encryptCredential(DEBRID_TOKEN_PURPOSE, clientId, token);
}

function decryptStoredDebridToken(
	clientId: string,
	stored: string | null | undefined
): string | null {
	if (!stored) return null;
	if (isEncryptedCredential(stored)) {
		return decryptCredential(DEBRID_TOKEN_PURPOSE, clientId, stored, `download-client:${clientId}`);
	}
	// Legacy `iv:tag:ct` blobs from debridTokenCrypto (pre-migration 161).
	return decryptDebridToken(stored);
}

import type { IDownloadClient, DownloadClientConfig } from './core/interfaces';
import type {
	DownloadClient,
	DownloadClientInput,
	ConnectionTestResult,
	DownloadClientImplementation,
	DownloadClientHealth
} from '#lib/types/downloadClient.js';
import { QBittorrentClient } from './qbittorrent/QBittorrentClient';
import { TransmissionClient } from './transmission/TransmissionClient';
import { DelugeClient } from './deluge/DelugeClient';
import { RTorrentClient } from './rtorrent/RTorrentClient';
import { Aria2Client } from './aria2/Aria2Client';
import { SABnzbdClient, type SABnzbdConfig } from './sabnzbd';
import { NZBGetClient } from './nzbget';
import {
	createDebridAdapter,
	isDebridError,
	type DebridAdapter,
	type DebridProvider
} from './debrid/debrid-adapter';

/**
 * Protocol type for download clients.
 */
export type DownloadClientProtocol = 'torrent' | 'usenet' | 'debrid';

/**
 * Map implementation to protocol.
 */
const IMPLEMENTATION_PROTOCOL_MAP: Record<string, DownloadClientProtocol> = {
	qbittorrent: 'torrent',
	transmission: 'torrent',
	deluge: 'torrent',
	rtorrent: 'torrent',
	aria2: 'torrent',
	sabnzbd: 'usenet',
	nzbget: 'usenet',
	realdebrid: 'debrid',
	torbox: 'debrid'
};

/**
 * Debrid implementations that use an API token instead of host/port connection.
 */
const DEBRID_IMPLEMENTATIONS = new Set(['realdebrid', 'torbox']);

/**
 * Canonical host/port values for debrid implementations (satisfy NOT NULL constraints).
 */
const DEBRID_CANONICAL_ENDPOINTS: Record<string, { host: string; port: number }> = {
	realdebrid: { host: 'api.real-debrid.com', port: 443 },
	torbox: { host: 'api.torbox.app', port: 443 }
};

type StoredDebridTokenResult =
	{ success: true; apiToken: string } | { success: false; error: string };

function parsePositiveIntEnv(name: string, fallback: number): number {
	const value = process.env[name];
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.round(parsed);
}

const DOWNLOAD_CLIENT_FAILURES_BEFORE_FAILING = parsePositiveIntEnv(
	'DOWNLOAD_CLIENT_FAILURES_BEFORE_FAILING',
	3
);
const DOWNLOAD_CLIENT_FAILURE_INCREMENT_INTERVAL_MS = parsePositiveIntEnv(
	'DOWNLOAD_CLIENT_FAILURE_INCREMENT_INTERVAL_MS',
	30_000
);

const LEGACY_DOWNLOAD_CLIENT_SELECT = {
	id: downloadClientsTable.id,
	name: downloadClientsTable.name,
	implementation: downloadClientsTable.implementation,
	enabled: downloadClientsTable.enabled,
	host: downloadClientsTable.host,
	port: downloadClientsTable.port,
	useSsl: downloadClientsTable.useSsl,
	username: downloadClientsTable.username,
	password: downloadClientsTable.password,
	urlBase: downloadClientsTable.urlBase,
	mountMode: downloadClientsTable.mountMode,
	apiToken: downloadClientsTable.apiToken,
	removeAfterImport: downloadClientsTable.removeAfterImport,
	movieCategory: downloadClientsTable.movieCategory,
	tvCategory: downloadClientsTable.tvCategory,
	recentPriority: downloadClientsTable.recentPriority,
	olderPriority: downloadClientsTable.olderPriority,
	initialState: downloadClientsTable.initialState,
	seedRatioLimit: downloadClientsTable.seedRatioLimit,
	seedTimeLimit: downloadClientsTable.seedTimeLimit,
	sequentialDownload: downloadClientsTable.sequentialDownload,
	downloadPathLocal: downloadClientsTable.downloadPathLocal,
	downloadPathRemote: downloadClientsTable.downloadPathRemote,
	tempPathLocal: downloadClientsTable.tempPathLocal,
	tempPathRemote: downloadClientsTable.tempPathRemote,
	priority: downloadClientsTable.priority,
	createdAt: downloadClientsTable.createdAt,
	updatedAt: downloadClientsTable.updatedAt
};

/**
 * Central service for managing download clients.
 */
export class DownloadClientManager {
	private clientInstances: Map<string, IDownloadClient> = new Map();
	private downloadClientHealthColumnsAvailable = true;

	private normalizeImplementation(
		implementation: string | undefined
	): DownloadClientImplementation {
		return (
			implementation === 'nzb-mount' ? 'sabnzbd' : (implementation ?? 'qbittorrent')
		) as DownloadClientImplementation;
	}

	private normalizeMountMode(mountMode: string | null | undefined): 'nzbdav' | null {
		return mountMode === 'nzbdav' || mountMode === 'altmount' ? 'nzbdav' : null;
	}

	private isMissingDownloadClientHealthColumnsError(error: unknown): boolean {
		const message = this.toErrorMessage(error).toLowerCase();
		if (!message.includes('no such column')) return false;
		return (
			message.includes('health') ||
			message.includes('consecutive_failures') ||
			message.includes('last_success') ||
			message.includes('last_failure') ||
			message.includes('last_failure_message') ||
			message.includes('last_checked_at')
		);
	}

	private async selectClientRows(): Promise<Array<typeof downloadClientsTable.$inferSelect>> {
		if (this.downloadClientHealthColumnsAvailable) {
			try {
				return await db.select().from(downloadClientsTable);
			} catch (error) {
				if (!this.isMissingDownloadClientHealthColumnsError(error)) {
					throw error;
				}
				this.downloadClientHealthColumnsAvailable = false;
				logger.warn(
					'[DownloadClientManager] Missing download client health columns; using legacy row mapping'
				);
			}
		}

		const rows = await db.select(LEGACY_DOWNLOAD_CLIENT_SELECT).from(downloadClientsTable);
		return rows as Array<typeof downloadClientsTable.$inferSelect>;
	}

	private async selectClientRowsById(
		id: string
	): Promise<Array<typeof downloadClientsTable.$inferSelect>> {
		if (this.downloadClientHealthColumnsAvailable) {
			try {
				return await db.select().from(downloadClientsTable).where(eq(downloadClientsTable.id, id));
			} catch (error) {
				if (!this.isMissingDownloadClientHealthColumnsError(error)) {
					throw error;
				}
				this.downloadClientHealthColumnsAvailable = false;
				logger.warn(
					'[DownloadClientManager] Missing download client health columns; using legacy row mapping'
				);
			}
		}

		const rows = await db
			.select(LEGACY_DOWNLOAD_CLIENT_SELECT)
			.from(downloadClientsTable)
			.where(eq(downloadClientsTable.id, id));
		return rows as Array<typeof downloadClientsTable.$inferSelect>;
	}

	/**
	 * Get all configured download clients from database.
	 * Passwords are not returned for security.
	 */
	async getClients(): Promise<DownloadClient[]> {
		const rows = await this.selectClientRows();
		return rows.map((row) => this.rowToClient(row));
	}

	/**
	 * Get a specific client config by ID.
	 */
	async getClient(id: string): Promise<DownloadClient | undefined> {
		const rows = await this.selectClientRowsById(id);
		return rows[0] ? this.rowToClient(rows[0]) : undefined;
	}

	/**
	 * Get a client config with password (for internal use only).
	 */
	private async getClientWithPassword(
		id: string
	): Promise<(DownloadClient & { password?: string | null }) | undefined> {
		const rows = await this.selectClientRowsById(id);
		if (!rows[0]) return undefined;

		const client = this.rowToClient(rows[0]);
		return {
			...client,
			password: decryptStoredPassword(id, rows[0].password)
		};
	}

	private async loadStoredDebridToken(id: string): Promise<StoredDebridTokenResult> {
		const rows = await this.selectClientRowsById(id);
		const encryptedToken = rows[0]?.apiToken;
		const apiToken = decryptStoredDebridToken(id, encryptedToken);

		return apiToken
			? { success: true, apiToken }
			: {
					success: false,
					error: 'Stored API token is unavailable. Re-enter the token and try again.'
				};
	}

	/**
	 * Create a new download client configuration.
	 */
	async createClient(input: DownloadClientInput): Promise<DownloadClient> {
		const id = randomUUID();
		const now = new Date().toISOString();

		const implementation = this.normalizeImplementation(input.implementation);
		const isDebrid = DEBRID_IMPLEMENTATIONS.has(implementation);

		if (!isDebrid) {
			if (!input.host || input.host.length === 0) {
				throw new Error('Host is required');
			}
			if (input.port === undefined || input.port === null) {
				throw new Error('Port is required');
			}
		}

		// For debrid implementations, fill canonical host/port to satisfy NOT NULL
		// constraints. The user does not provide host/port for debrid clients.
		let host: string;
		let port: number;
		if (isDebrid) {
			host = DEBRID_CANONICAL_ENDPOINTS[implementation]?.host ?? 'api.real-debrid.com';
			port = DEBRID_CANONICAL_ENDPOINTS[implementation]?.port ?? 443;
		} else {
			if (!input.host || input.port === undefined || input.port === null) {
				throw new Error('Host and port are required');
			}
			host = input.host;
			port = input.port;
		}

		// Encrypt the debrid API token before storing.
		const apiToken =
			isDebrid && input.apiToken ? encryptStoredDebridToken(id, input.apiToken) : null;

		await db.insert(downloadClientsTable).values({
			id,
			name: input.name,
			implementation,
			enabled: input.enabled ?? true,
			host,
			port,
			useSsl: isDebrid ? false : (input.useSsl ?? false),
			urlBase: isDebrid ? null : (input.urlBase ?? null),
			mountMode: isDebrid ? null : this.normalizeMountMode(input.mountMode),
			username: isDebrid ? null : input.username,
			password: isDebrid || !input.password ? null : encryptStoredPassword(id, input.password),
			apiToken,
			removeAfterImport: input.removeAfterImport ?? false,
			allowMovies: isDebrid ? (input.allowMovies ?? true) : true,
			allowTv: isDebrid ? (input.allowTv ?? true) : true,
			movieCategory: isDebrid ? 'movies' : (input.movieCategory ?? 'movies'),
			tvCategory: isDebrid ? 'tv' : (input.tvCategory ?? 'tv'),
			recentPriority: isDebrid ? 'normal' : (input.recentPriority ?? 'normal'),
			olderPriority: isDebrid ? 'normal' : (input.olderPriority ?? 'normal'),
			initialState: isDebrid ? 'start' : (input.initialState ?? 'start'),
			seedRatioLimit: isDebrid ? null : input.seedRatioLimit,
			seedTimeLimit: isDebrid ? null : input.seedTimeLimit,
			sequentialDownload:
				implementation === 'qbittorrent' ? (input.sequentialDownload ?? false) : false,
			downloadPathLocal: isDebrid ? null : input.downloadPathLocal,
			downloadPathRemote: isDebrid ? null : input.downloadPathRemote,
			tempPathLocal: isDebrid ? null : input.tempPathLocal,
			tempPathRemote: isDebrid ? null : input.tempPathRemote,
			priority: input.priority ?? 1,
			createdAt: now,
			updatedAt: now
		});

		logger.info({ id, name: input.name }, 'Download client created');

		const created = await this.getClient(id);
		if (!created) {
			throw new Error('Failed to create download client');
		}

		return created;
	}

	/**
	 * Update a download client configuration.
	 */
	async updateClient(id: string, updates: Partial<DownloadClientInput>): Promise<DownloadClient> {
		const existing = await this.getClient(id);
		if (!existing) {
			throw new Error(`Download client not found: ${id}`);
		}

		// Resolve against the stored values too, not just this request's payload -
		// a request that only turns off allowTv while allowMovies is already false
		// in the DB would otherwise slip past the schema's same-request check.
		const nextAllowMovies = updates.allowMovies ?? existing.allowMovies;
		const nextAllowTv = updates.allowTv ?? existing.allowTv;
		if (nextAllowMovies === false && nextAllowTv === false) {
			throw new Error('At least one content type (Movies or TV Shows) must be enabled');
		}

		const updateData: Record<string, unknown> = {
			updatedAt: new Date().toISOString()
		};

		if (updates.name !== undefined) updateData.name = updates.name;
		if (updates.implementation !== undefined) {
			updateData.implementation = this.normalizeImplementation(updates.implementation);
		}
		if (updates.enabled !== undefined) updateData.enabled = updates.enabled;
		if (updates.host !== undefined) updateData.host = updates.host;
		if (updates.port !== undefined) updateData.port = updates.port;
		if (updates.useSsl !== undefined) updateData.useSsl = updates.useSsl;
		if (updates.urlBase !== undefined) updateData.urlBase = updates.urlBase;
		if (updates.mountMode !== undefined) {
			updateData.mountMode = this.normalizeMountMode(updates.mountMode);
		}
		if (updates.username !== undefined) updateData.username = updates.username;
		// Only update password if explicitly provided with a non-empty value
		// (null or empty string means "keep existing password")
		if (updates.password !== undefined && updates.password !== null && updates.password !== '') {
			updateData.password = encryptStoredPassword(id, updates.password);
		}
		// Only update apiToken if explicitly provided with a non-empty value.
		// If apiToken is not provided (undefined/null/empty), preserve the existing
		// encrypted token — same pattern as password.
		if (updates.apiToken !== undefined && updates.apiToken !== null && updates.apiToken !== '') {
			updateData.apiToken = encryptStoredDebridToken(id, updates.apiToken);
		}
		if (updates.removeAfterImport !== undefined) {
			updateData.removeAfterImport = updates.removeAfterImport;
		}
		if (updates.allowMovies !== undefined) updateData.allowMovies = updates.allowMovies;
		if (updates.allowTv !== undefined) updateData.allowTv = updates.allowTv;
		if (updates.movieCategory !== undefined) updateData.movieCategory = updates.movieCategory;
		if (updates.tvCategory !== undefined) updateData.tvCategory = updates.tvCategory;
		if (updates.recentPriority !== undefined) updateData.recentPriority = updates.recentPriority;
		if (updates.olderPriority !== undefined) updateData.olderPriority = updates.olderPriority;
		if (updates.initialState !== undefined) updateData.initialState = updates.initialState;
		if (updates.seedRatioLimit !== undefined) updateData.seedRatioLimit = updates.seedRatioLimit;
		if (updates.seedTimeLimit !== undefined) updateData.seedTimeLimit = updates.seedTimeLimit;
		if (updates.sequentialDownload !== undefined && existing.implementation === 'qbittorrent') {
			updateData.sequentialDownload = updates.sequentialDownload;
		}
		if (updates.downloadPathLocal !== undefined)
			updateData.downloadPathLocal = updates.downloadPathLocal;
		if (updates.downloadPathRemote !== undefined)
			updateData.downloadPathRemote = updates.downloadPathRemote;
		if (updates.tempPathLocal !== undefined) updateData.tempPathLocal = updates.tempPathLocal;
		if (updates.tempPathRemote !== undefined) updateData.tempPathRemote = updates.tempPathRemote;
		if (updates.priority !== undefined) updateData.priority = updates.priority;

		await db.update(downloadClientsTable).set(updateData).where(eq(downloadClientsTable.id, id));

		// Clear cached instance so it gets recreated with new config
		// For SABnzbd, also clear its internal config cache
		const existingInstance = this.clientInstances.get(id);
		if (existingInstance && 'clearConfigCache' in existingInstance) {
			(existingInstance as { clearConfigCache: () => void }).clearConfigCache();
		}
		this.clientInstances.delete(id);

		logger.info({ id }, 'Download client updated');

		const updated = await this.getClient(id);
		if (!updated) {
			throw new Error('Failed to update download client');
		}

		return updated;
	}

	/**
	 * Delete a download client.
	 */
	async deleteClient(id: string): Promise<void> {
		await db.delete(downloadClientsTable).where(eq(downloadClientsTable.id, id));
		this.clientInstances.delete(id);
		logger.info({ id }, 'Download client deleted');
	}

	/**
	 * Test a download client's connectivity.
	 * Can test either an existing client by ID or test config before saving.
	 */
	async testClient(config: DownloadClientConfig): Promise<ConnectionTestResult> {
		const implementation = this.normalizeImplementation(
			(config as { implementation?: string }).implementation
		);

		// Debrid clients use their dedicated provider adapter.
		if (DEBRID_IMPLEMENTATIONS.has(implementation)) {
			const apiToken = (config as { apiToken?: string | null }).apiToken ?? null;
			return this.testDebridClient('test-config', implementation, async () => apiToken, false);
		}

		const client = this.createClientInstance(config);
		if (!client) {
			return {
				success: false,
				error: `Unsupported implementation: ${(config as { implementation?: string }).implementation ?? 'unknown'}`
			};
		}

		return client.test();
	}

	/**
	 * Test a debrid client via its provider adapter.
	 *
	 * 429 (throttled) is health-neutral (decision 10): it does not disable the
	 * client or mark credentials invalid. Only non-throttled failures record
	 * a health failure when recordHealth is true.
	 */
	private async testDebridClient(
		storedClientId: string,
		implementation: string,
		tokenLoader: () => Promise<string | null>,
		recordHealth: boolean
	): Promise<ConnectionTestResult> {
		try {
			const adapter = createDebridAdapter(implementation as DebridProvider, {
				storedClientId,
				tokenLoader
			});
			const credential = await adapter.testCredentials();
			if (recordHealth) {
				await this.recordHealthSuccess(storedClientId);
			}
			return {
				success: true,
				accountId: credential.accountId,
				...(credential.accountLabel ? { accountLabel: credential.accountLabel } : {})
			};
		} catch (err) {
			if (isDebridError(err)) {
				// 429 is health-neutral: do not record a failure.
				if (err.kind !== 'throttled' && recordHealth) {
					await this.recordHealthFailure(storedClientId, err.redactedMessage);
				}
				return {
					success: false,
					error: `${implementation}: ${err.redactedMessage}`
				};
			}
			const fallback = 'Connection test failed';
			if (recordHealth) {
				await this.recordHealthFailure(storedClientId, fallback);
			}
			return { success: false, error: `${implementation}: ${fallback}` };
		}
	}

	/**
	 * Test an existing client by ID.
	 */
	async testClientById(id: string): Promise<ConnectionTestResult> {
		const clientConfig = await this.getClientWithPassword(id);
		if (!clientConfig) {
			return {
				success: false,
				error: `Download client not found: ${id}`
			};
		}

		const implementation = this.normalizeImplementation(clientConfig.implementation);

		// Debrid clients use the provider adapter with the stored-token loader.
		if (DEBRID_IMPLEMENTATIONS.has(implementation)) {
			const tokenLoader = async (): Promise<string | null> => {
				const stored = await this.loadStoredDebridToken(id);
				return stored.success ? stored.apiToken : null;
			};
			return this.testDebridClient(id, implementation, tokenLoader, true);
		}

		const result = await this.testClient({
			host: clientConfig.host,
			port: clientConfig.port,
			useSsl: clientConfig.useSsl,
			urlBase: clientConfig.urlBase ?? null,
			mountMode: clientConfig.mountMode ?? null,
			username: clientConfig.username,
			password: clientConfig.password,
			implementation: clientConfig.implementation,
			apiKey: clientConfig.implementation === 'sabnzbd' ? clientConfig.password : undefined
		});

		if (result.success) {
			await this.recordHealthSuccess(id);
		} else {
			await this.recordHealthFailure(id, result.error ?? 'Connection test failed');
		}

		return result;
	}

	/**
	 * Test using updated config values while falling back to stored credentials when password/api key is omitted.
	 */
	async testClientWithCredentialFallback(
		id: string,
		overrides: Partial<DownloadClientConfig>
	): Promise<ConnectionTestResult> {
		const clientConfig = await this.getClientWithPassword(id);
		if (!clientConfig) {
			return {
				success: false,
				error: `Download client not found: ${id}`
			};
		}

		const hasPasswordOverride =
			typeof overrides.password === 'string' && overrides.password.trim().length > 0;
		const effectivePassword = hasPasswordOverride ? overrides.password : clientConfig.password;
		const implementation = this.normalizeImplementation(
			overrides.implementation ?? clientConfig.implementation
		);
		const hasApiTokenOverride =
			typeof overrides.apiToken === 'string' && overrides.apiToken.trim().length > 0;
		let effectiveApiToken = hasApiTokenOverride ? overrides.apiToken : undefined;

		if (DEBRID_IMPLEMENTATIONS.has(implementation) && !hasApiTokenOverride) {
			const storedToken = await this.loadStoredDebridToken(id);
			if (!storedToken.success) return storedToken;
			effectiveApiToken = storedToken.apiToken;
		}

		const result = await this.testClient({
			host: overrides.host ?? clientConfig.host,
			port: overrides.port ?? clientConfig.port,
			useSsl: overrides.useSsl ?? clientConfig.useSsl,
			urlBase: overrides.urlBase ?? clientConfig.urlBase ?? null,
			mountMode: overrides.mountMode ?? clientConfig.mountMode ?? null,
			username: overrides.username ?? clientConfig.username,
			password: effectivePassword,
			implementation,
			apiKey: implementation === 'sabnzbd' ? effectivePassword : undefined,
			apiToken: effectiveApiToken
		});

		if (result.success) {
			await this.recordHealthSuccess(id);
		} else if (
			DEBRID_IMPLEMENTATIONS.has(implementation) &&
			(result.error ?? '').toLowerCase().includes('rate limit')
		) {
			// 429 is health-neutral for debrid (decision 10):
			// do not disable the client or mark credentials invalid.
		} else {
			await this.recordHealthFailure(id, result.error ?? 'Connection test failed');
		}

		return result;
	}

	/**
	 * Get or create a client instance for operations.
	 */
	async getClientInstance(id: string): Promise<IDownloadClient | undefined> {
		// Check cache first
		let instance = this.clientInstances.get(id);
		if (instance) return instance;

		// Load config with password
		const config = await this.getClientWithPassword(id);
		if (!config) return undefined;

		// Create instance with implementation-specific config
		instance = this.createClientInstance({
			host: config.host,
			port: config.port,
			useSsl: config.useSsl,
			urlBase: config.urlBase ?? null,
			mountMode: config.mountMode ?? null,
			username: config.username,
			password: config.password,
			implementation: config.implementation,
			sequentialDownload:
				config.implementation === 'qbittorrent' ? (config.sequentialDownload ?? false) : false,
			// rTorrent evaluates seed goals app-side (see RTorrentClient); the
			// row's decimal string is parsed once here.
			seedRatioLimit:
				config.implementation === 'rtorrent' && config.seedRatioLimit
					? parseFloat(config.seedRatioLimit)
					: undefined,
			seedTimeLimit:
				config.implementation === 'rtorrent' ? (config.seedTimeLimit ?? undefined) : undefined,
			// For SABnzbd, the API key is stored in the password field
			apiKey:
				this.normalizeImplementation(config.implementation) === 'sabnzbd'
					? config.password
					: undefined,
			downloadPathLocal: config.downloadPathLocal ?? null,
			downloadPathRemote: config.downloadPathRemote ?? null,
			tempPathLocal: config.tempPathLocal ?? null,
			tempPathRemote: config.tempPathRemote ?? null
		});

		if (instance) {
			const wrappedInstance = this.wrapClientInstance(id, instance);
			this.clientInstances.set(id, wrappedInstance);
		}

		return this.clientInstances.get(id);
	}

	/**
	 * Get all enabled client instances.
	 */
	async getEnabledClients(): Promise<Array<{ client: DownloadClient; instance: IDownloadClient }>> {
		const clients = await this.getClients();
		const enabledClients = clients.filter(
			(c) => c.enabled && !DEBRID_IMPLEMENTATIONS.has(c.implementation)
		);

		const results: Array<{ client: DownloadClient; instance: IDownloadClient }> = [];

		for (const client of enabledClients) {
			const instance = await this.getClientInstance(client.id);
			if (instance) {
				results.push({ client, instance });
			}
		}

		return results;
	}

	/**
	 * Get enabled clients filtered by protocol.
	 */
	async getEnabledClientsForProtocol(
		protocol: DownloadClientProtocol
	): Promise<Array<{ client: DownloadClient; instance: IDownloadClient }>> {
		const allClients = await this.getEnabledClients();
		const matched = allClients.filter(
			({ client }) => IMPLEMENTATION_PROTOCOL_MAP[client.implementation] === protocol
		);
		return matched;
	}

	/**
	 * Get the first enabled client for a protocol, ordered by priority.
	 */
	async getClientForProtocol(
		protocol: DownloadClientProtocol
	): Promise<{ client: DownloadClient; instance: IDownloadClient } | undefined> {
		const clients = await this.getEnabledClientsForProtocol(protocol);
		if (clients.length === 0) {
			return undefined;
		}
		// Sort by priority (lower = higher priority)
		clients.sort((a, b) => a.client.priority - b.client.priority);
		return clients[0];
	}

	/**
	 * Select an enabled debrid client with a usable stored token.
	 *
	 * Debrid adapters intentionally do not implement IDownloadClient, so they
	 * cannot use getClientForProtocol(). The optional ID is used by retry paths
	 * that must stay on the queue row's original provider. `mediaType`, when
	 * given, excludes clients that have been restricted away from that content
	 * type (e.g. a client set to movies-only is skipped for a TV acquisition).
	 */
	async getDebridClientForAcquisition(
		preferredClientId?: string,
		mediaType?: 'movie' | 'tv'
	): Promise<{ client: DownloadClient; adapter: DebridAdapter } | undefined> {
		const clients = (await this.getClients())
			.filter(
				(client) =>
					client.enabled &&
					DEBRID_IMPLEMENTATIONS.has(client.implementation) &&
					(!preferredClientId || client.id === preferredClientId) &&
					(!mediaType || (mediaType === 'movie' ? client.allowMovies : client.allowTv) !== false)
			)
			.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

		for (const client of clients) {
			const storedToken = await this.loadStoredDebridToken(client.id);
			if (!storedToken.success) continue;

			const implementation = client.implementation as DebridProvider;
			const adapter = createDebridAdapter(implementation, {
				storedClientId: client.id,
				tokenLoader: async () => {
					const token = await this.loadStoredDebridToken(client.id);
					return token.success ? token.apiToken : null;
				}
			});
			return { client, adapter };
		}

		return undefined;
	}

	/**
	 * Get the protocol for a client implementation.
	 */
	static getProtocolForImplementation(implementation: string): DownloadClientProtocol {
		const normalizedImplementation = implementation === 'nzb-mount' ? 'sabnzbd' : implementation;
		return IMPLEMENTATION_PROTOCOL_MAP[normalizedImplementation] || 'torrent';
	}

	/**
	 * Create a client instance from config.
	 */
	private createClientInstance(
		config: DownloadClientConfig & { implementation?: string; apiKey?: string | null }
	): IDownloadClient | undefined {
		const implementation = this.normalizeImplementation(config.implementation);

		switch (implementation) {
			case 'qbittorrent':
				return new QBittorrentClient(config);

			case 'transmission':
				return new TransmissionClient(config);

			case 'deluge':
				return new DelugeClient(config);

			case 'rtorrent':
				return new RTorrentClient(config);

			case 'aria2':
				return new Aria2Client(config);

			case 'sabnzbd': {
				const sabConfig = config as SABnzbdConfig;
				const mountMode = this.normalizeMountMode(sabConfig.mountMode);
				const isMountMode = mountMode === 'nzbdav';
				return new SABnzbdClient({
					...sabConfig,
					implementation: 'sabnzbd',
					mountMode,
					normalizeCategoryDir: sabConfig.normalizeCategoryDir ?? isMountMode
				});
			}

			case 'nzbget':
				return new NZBGetClient(config);

			// Future implementations

			default:
				logger.warn(`Unsupported download client implementation: ${implementation}`);
				return undefined;
		}
	}

	private wrapClientInstance(id: string, instance: IDownloadClient): IDownloadClient {
		const trackedMethods = new Set<string>([
			'test',
			'addDownload',
			'getDownloads',
			'getDownload',
			'removeDownload',
			'pauseDownload',
			'resumeDownload',
			'getDefaultSavePath',
			'getCategories',
			'ensureCategory',
			'retryDownload',
			'getNntpServers',
			'getBasePath',
			'markItemAsImported',
			'setSeedingConfig'
		]);

		return new Proxy(instance, {
			get: (target, prop, receiver) => {
				const value = Reflect.get(target, prop, receiver);
				if (typeof prop !== 'string' || typeof value !== 'function' || !trackedMethods.has(prop)) {
					return value;
				}

				return async (...args: unknown[]) => {
					try {
						const result = await value.apply(target, args);
						await this.recordHealthSuccess(id);
						return result;
					} catch (error) {
						// Only mark unhealthy for connectivity/auth/API availability issues.
						if (this.isHealthFailure(error)) {
							await this.recordHealthFailure(id, this.toErrorMessage(error));
						}
						throw error;
					}
				};
			}
		}) as IDownloadClient;
	}

	private toErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private isHealthFailure(error: unknown): boolean {
		const message = this.toErrorMessage(error).toLowerCase();

		// Runtime operation errors that indicate app/business conditions rather than connectivity.
		const nonHealthPatterns = [
			'already exists',
			'not found',
			'invalid category',
			'invalid state',
			'duplicate'
		];
		if (nonHealthPatterns.some((pattern) => message.includes(pattern))) {
			return false;
		}

		// Most runtime exceptions from client calls indicate connection/auth/API availability failures.
		return true;
	}

	private async recordHealthSuccess(id: string): Promise<void> {
		if (!this.downloadClientHealthColumnsAvailable) {
			return;
		}

		const now = new Date().toISOString();
		try {
			await db
				.update(downloadClientsTable)
				.set({
					health: 'healthy',
					consecutiveFailures: 0,
					lastSuccess: now,
					lastCheckedAt: now,
					updatedAt: now
				})
				.where(eq(downloadClientsTable.id, id));
		} catch (error) {
			if (this.isMissingDownloadClientHealthColumnsError(error)) {
				this.downloadClientHealthColumnsAvailable = false;
				return;
			}
			logger.debug(
				{
					id,
					error: this.toErrorMessage(error)
				},
				'Failed to record download client success state'
			);
		}
	}

	private async recordHealthFailure(id: string, message: string): Promise<void> {
		if (!this.downloadClientHealthColumnsAvailable) {
			return;
		}

		const now = new Date().toISOString();
		try {
			const [row] = await db
				.select({
					consecutiveFailures: downloadClientsTable.consecutiveFailures,
					lastFailure: downloadClientsTable.lastFailure
				})
				.from(downloadClientsTable)
				.where(eq(downloadClientsTable.id, id));

			const previousFailures = row?.consecutiveFailures ?? 0;
			const lastFailureTime = row?.lastFailure ? new Date(row.lastFailure).getTime() : 0;
			const nowTime = Date.now();
			const shouldIncrementConsecutive =
				!lastFailureTime ||
				nowTime - lastFailureTime >= DOWNLOAD_CLIENT_FAILURE_INCREMENT_INTERVAL_MS;
			const consecutiveFailures = shouldIncrementConsecutive
				? previousFailures + 1
				: previousFailures;
			const health: DownloadClientHealth =
				consecutiveFailures >= DOWNLOAD_CLIENT_FAILURES_BEFORE_FAILING ? 'failing' : 'warning';

			await db
				.update(downloadClientsTable)
				.set({
					health,
					consecutiveFailures,
					lastFailure: now,
					lastFailureMessage: message,
					lastCheckedAt: now,
					updatedAt: now
				})
				.where(eq(downloadClientsTable.id, id));
		} catch (error) {
			if (this.isMissingDownloadClientHealthColumnsError(error)) {
				this.downloadClientHealthColumnsAvailable = false;
				return;
			}
			logger.debug(
				{
					id,
					error: this.toErrorMessage(error)
				},
				'Failed to record download client failure state'
			);
		}
	}

	/**
	 * Convert database row to DownloadClient (without password).
	 */
	private rowToClient(row: typeof downloadClientsTable.$inferSelect): DownloadClient {
		const mountMode = this.normalizeMountMode(row.mountMode);
		const implementation = this.normalizeImplementation(row.implementation);

		return {
			id: row.id,
			name: row.name,
			implementation,
			enabled: !!row.enabled,
			host: row.host,
			port: row.port,
			useSsl: !!row.useSsl,
			urlBase: row.urlBase ?? null,
			mountMode,
			username: row.username,
			hasPassword: !!row.password,
			hasApiToken: !!row.apiToken,
			removeAfterImport: !!row.removeAfterImport,
			allowMovies: row.allowMovies ?? true,
			allowTv: row.allowTv ?? true,
			movieCategory: row.movieCategory ?? 'movies',
			tvCategory: row.tvCategory ?? 'tv',
			recentPriority: (row.recentPriority as 'normal' | 'high' | 'force') ?? 'normal',
			olderPriority: (row.olderPriority as 'normal' | 'high' | 'force') ?? 'normal',
			initialState: (row.initialState as 'start' | 'pause' | 'force') ?? 'start',
			seedRatioLimit: row.seedRatioLimit,
			seedTimeLimit: row.seedTimeLimit,
			sequentialDownload: implementation === 'qbittorrent' ? !!row.sequentialDownload : false,
			downloadPathLocal: row.downloadPathLocal,
			downloadPathRemote: row.downloadPathRemote,
			tempPathLocal: row.tempPathLocal,
			tempPathRemote: row.tempPathRemote,
			priority: row.priority ?? 1,
			status: {
				health: (row.health as DownloadClientHealth) ?? 'healthy',
				consecutiveFailures: row.consecutiveFailures ?? 0,
				lastSuccess: row.lastSuccess ?? undefined,
				lastFailure: row.lastFailure ?? undefined,
				lastFailureMessage: row.lastFailureMessage ?? undefined,
				lastCheckedAt: row.lastCheckedAt ?? undefined
			},
			createdAt: row.createdAt ?? undefined,
			updatedAt: row.updatedAt ?? undefined
		};
	}
}

/** Singleton instance */
let managerInstance: DownloadClientManager | null = null;

/** Get the singleton DownloadClientManager */
export function getDownloadClientManager(): DownloadClientManager {
	if (!managerInstance) {
		managerInstance = new DownloadClientManager();
	}
	return managerInstance;
}

/** Reset the singleton (for testing) */
export function resetDownloadClientManager(): void {
	managerInstance = null;
}
