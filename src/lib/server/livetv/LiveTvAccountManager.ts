/**
 * Live TV Account Manager
 *
 * Manages Live TV accounts for all provider types (Stalker, XStream, M3U).
 * Provides CRUD operations, testing, and account management.
 */

import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { epgPrograms, livetvAccounts, type LivetvAccountRecord } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { toFriendlyLiveTvTestError } from '#lib/livetv/errorMessages.js';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { getProvider, getProviderForAccount } from './providers';
import { probeStalkerEndpoint } from './stalker/StalkerPortalClient';
import { normalizeTmdbLanguage } from '#lib/server/languages/normalize.js';
import { liveTvEvents } from './LiveTvEvents';
import { decryptLivetvConfig, encryptLivetvConfig } from './configCrypto';
import type { BackgroundService, ServiceStatus } from '#lib/server/services/background-service.js';
import { ExternalServiceError } from '#lib/errors/index.js';
import type {
	LiveTvAccount,
	LiveTvAccountInput,
	LiveTvAccountUpdate,
	LiveTvAccountTestResult,
	LiveTvProviderType,
	StalkerConfig,
	XstreamConfig,
	M3uConfig,
	CinephageIptvConfig
} from '#lib/types/livetv.js';

const logger = createChildLogger({ module: 'LiveTvAccountManager' });

/**
 * Generate a random serial number (like MAG devices use).
 * Stalker portals treat these as device identity — use the CSPRNG, not
 * Math.random, so one account's device identity is not guessable from
 * another's.
 */
function generateSerialNumber(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let sn = '';
	for (let i = 0; i < 12; i++) {
		sn += chars[randomInt(chars.length)];
	}
	return sn;
}

/**
 * Generate a random device ID (like MAG devices use).
 */
function generateDeviceId(): string {
	return randomBytes(16).toString('hex').toUpperCase();
}

/**
 * Convert database record to API response type.
 * Shared across all providers and services that need to map DB rows to LiveTvAccount.
 */
export function recordToAccount(record: LivetvAccountRecord): LiveTvAccount {
	return {
		id: record.id,
		name: record.name,
		providerType: record.providerType as LiveTvProviderType,
		enabled: record.enabled ?? true,
		// Provider configs (credential fields are enveloped at rest; decrypted
		// here for the API/service layer)
		stalkerConfig: record.stalkerConfig
			? (decryptLivetvConfig(
					record.id,
					record.stalkerConfig as unknown as Record<string, unknown>
				) as unknown as StalkerConfig)
			: undefined,
		xstreamConfig: record.xstreamConfig
			? (decryptLivetvConfig(
					record.id,
					record.xstreamConfig as unknown as Record<string, unknown>
				) as unknown as XstreamConfig)
			: undefined,
		m3uConfig: record.m3uConfig
			? (decryptLivetvConfig(
					record.id,
					record.m3uConfig as unknown as Record<string, unknown>
				) as unknown as M3uConfig)
			: undefined,
		cinephageIptvConfig: record.iptvOrgConfig as CinephageIptvConfig | undefined,
		// Metadata from provider
		playbackLimit: record.playbackLimit ?? null,
		channelCount: record.channelCount ?? null,
		categoryCount: record.categoryCount ?? null,
		expiresAt: record.expiresAt ?? null,
		serverTimezone: record.serverTimezone ?? null,
		// Health tracking
		lastTestedAt: record.lastTestedAt ?? null,
		lastTestSuccess: record.lastTestSuccess ?? null,
		lastTestError: record.lastTestError ?? null,
		// Sync tracking
		lastSyncAt: record.lastSyncAt ?? null,
		lastSyncError: record.lastSyncError ?? null,
		syncStatus: (record.syncStatus as LiveTvAccount['syncStatus']) ?? 'never',
		// EPG tracking
		lastEpgSyncAt: record.lastEpgSyncAt ?? null,
		lastEpgSyncError: record.lastEpgSyncError ?? null,
		epgProgramCount: record.epgProgramCount ?? 0,
		hasEpg: record.hasEpg ?? null,
		// Timestamps
		createdAt: record.createdAt ?? new Date().toISOString(),
		updatedAt: record.updatedAt ?? new Date().toISOString()
	};
}

export class LiveTvAccountManager implements BackgroundService {
	readonly name = 'LiveTvAccountManager';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;
	private readonly epgProgramPurgeQueue = new Map<
		string,
		{ accountName: string; purgeBefore: string }
	>();
	private readonly epgProgramPurgeRunning = new Set<string>();
	private readonly epgProgramPurgeScheduled = new Set<string>();
	private static readonly EPG_PURGE_BATCH_SIZE = 5000;
	private static readonly EPG_PURGE_START_DELAY_MS = 1500;

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	private scheduleEpgProgramPurgeRunner(accountId: string, delayMs: number): void {
		if (
			this.epgProgramPurgeRunning.has(accountId) ||
			this.epgProgramPurgeScheduled.has(accountId)
		) {
			return;
		}

		this.epgProgramPurgeScheduled.add(accountId);
		setTimeout(() => {
			this.epgProgramPurgeScheduled.delete(accountId);
			if (this.epgProgramPurgeRunning.has(accountId)) {
				return;
			}
			this.epgProgramPurgeRunning.add(accountId);
			void this.runQueuedEpgProgramPurge(accountId);
		}, delayMs);
	}

	private enqueueEpgProgramPurge(
		accountId: string,
		accountName: string,
		purgeBefore: string
	): void {
		const queued = this.epgProgramPurgeQueue.get(accountId);
		if (!queued || queued.purgeBefore < purgeBefore) {
			this.epgProgramPurgeQueue.set(accountId, { accountName, purgeBefore });
		}

		if (this.epgProgramPurgeRunning.has(accountId)) {
			return;
		}
		this.scheduleEpgProgramPurgeRunner(accountId, LiveTvAccountManager.EPG_PURGE_START_DELAY_MS);
	}

	private async runQueuedEpgProgramPurge(accountId: string): Promise<void> {
		try {
			while (true) {
				const queued = this.epgProgramPurgeQueue.get(accountId);
				if (!queued) {
					break;
				}
				this.epgProgramPurgeQueue.delete(accountId);
				let deletedPrograms = 0;
				while (true) {
					const ids = await db
						.select({ id: epgPrograms.id })
						.from(epgPrograms)
						.where(
							and(
								eq(epgPrograms.accountId, accountId),
								lte(epgPrograms.cachedAt, queued.purgeBefore)
							)
						)
						.limit(LiveTvAccountManager.EPG_PURGE_BATCH_SIZE);

					if (ids.length === 0) {
						break;
					}

					const deleted = await db.delete(epgPrograms).where(
						and(
							eq(epgPrograms.accountId, accountId),
							inArray(
								epgPrograms.id,
								ids.map((row) => row.id)
							)
						)
					);

					deletedPrograms += deleted.changes ?? 0;

					// Yield so regular API requests are not blocked by long purge loops.
					await new Promise<void>((resolve) => setImmediate(resolve));
				}

				logger.info(
					{
						id: accountId,
						name: queued.accountName,
						deletedPrograms,
						purgeBefore: queued.purgeBefore
					},
					'Cleared cached EPG programs after source change'
				);
			}
		} catch (error) {
			logger.error(
				{
					id: accountId,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed background EPG program purge after source change'
			);
		} finally {
			this.epgProgramPurgeRunning.delete(accountId);
			if (this.epgProgramPurgeQueue.has(accountId)) {
				// Continue quickly when additional purge work was queued while we were running.
				this.scheduleEpgProgramPurgeRunner(accountId, 100);
			}
		}
	}

	/**
	 * Start the service (non-blocking)
	 * Implements BackgroundService.start()
	 */
	start(): void {
		if (this._status === 'ready' || this._status === 'starting') {
			logger.debug('LiveTvAccountManager already running');
			return;
		}

		this._status = 'starting';
		logger.info('Starting LiveTvAccountManager');

		// Service initialization is synchronous for this manager
		setImmediate(() => {
			this._status = 'ready';
			logger.info('LiveTvAccountManager ready');
		});
	}

	/**
	 * Stop the service gracefully
	 * Implements BackgroundService.stop()
	 */
	async stop(): Promise<void> {
		if (this._status === 'pending') {
			return;
		}

		logger.info('Stopping LiveTvAccountManager');
		this._status = 'pending';
		logger.info('LiveTvAccountManager stopped');
	}

	/**
	 * Get all Live TV accounts
	 */
	async getAccounts(): Promise<LiveTvAccount[]> {
		const records = await db.select().from(livetvAccounts);
		return records.map(recordToAccount);
	}

	/**
	 * Get accounts by provider type
	 */
	async getAccountsByType(providerType: LiveTvProviderType): Promise<LiveTvAccount[]> {
		const records = await db
			.select()
			.from(livetvAccounts)
			.where(eq(livetvAccounts.providerType, providerType));
		return records.map(recordToAccount);
	}

	/**
	 * Get a Live TV account by ID
	 */
	async getAccount(id: string): Promise<LiveTvAccount | null> {
		const records = await db
			.select()
			.from(livetvAccounts)
			.where(eq(livetvAccounts.id, id))
			.limit(1);

		if (records.length === 0) {
			return null;
		}

		return recordToAccount(records[0]);
	}

	/**
	 * Create a new Live TV account
	 * Optionally tests the connection before saving
	 */
	async createAccount(
		input: LiveTvAccountInput,
		testFirst: boolean = true
	): Promise<LiveTvAccount> {
		const now = new Date().toISOString();

		// Build provider-specific config
		let stalkerConfig: StalkerConfig | undefined;
		let xstreamConfig: XstreamConfig | undefined;
		let m3uConfig: M3uConfig | undefined;
		let iptvOrgConfig: Record<string, unknown> | undefined;

		if (input.providerType === 'stalker' && input.stalkerConfig) {
			stalkerConfig = {
				portalUrl: input.stalkerConfig.portalUrl,
				macAddress: input.stalkerConfig.macAddress.toUpperCase(),
				serialNumber: input.stalkerConfig.serialNumber || generateSerialNumber(),
				deviceId: input.stalkerConfig.deviceId || generateDeviceId(),
				deviceId2: input.stalkerConfig.deviceId2 || generateDeviceId(),
				model: input.stalkerConfig.model || 'MAG254',
				timezone: input.stalkerConfig.timezone || 'Europe/London',
				// 2-letter portal UI language (stb_lang); falls back to English.
				language: normalizeTmdbLanguage(input.stalkerConfig.language) || 'en',
				username: input.stalkerConfig.username,
				password: input.stalkerConfig.password,
				endpoint: await probeStalkerEndpoint(input.stalkerConfig.portalUrl)
			};
		} else if (input.providerType === 'xstream' && input.xstreamConfig) {
			xstreamConfig = {
				baseUrl: input.xstreamConfig.baseUrl,
				username: input.xstreamConfig.username,
				password: input.xstreamConfig.password,
				epgUrl: input.xstreamConfig.epgUrl
			};
		} else if (input.providerType === 'm3u' && input.m3uConfig) {
			m3uConfig = {
				url: input.m3uConfig.url,
				fileContent: input.m3uConfig.fileContent,
				epgUrl: input.m3uConfig.epgUrl,
				refreshIntervalHours: input.m3uConfig.refreshIntervalHours || 24,
				autoRefresh: input.m3uConfig.autoRefresh ?? false,
				headers: input.m3uConfig.headers,
				userAgent: input.m3uConfig.userAgent
			};
		} else if (input.providerType === 'cinephage-iptv' && input.cinephageIptvConfig) {
			iptvOrgConfig = {
				countries: input.cinephageIptvConfig.countries || [],
				categories: input.cinephageIptvConfig.categories || [],
				languages: input.cinephageIptvConfig.languages || [],
				autoSyncIntervalHours: input.cinephageIptvConfig.autoSyncIntervalHours || 24
			};
		}

		// Test connection if requested
		let testResult: LiveTvAccountTestResult | null = null;
		if (testFirst) {
			const accountForTest: LiveTvAccount = {
				id: randomUUID(), // Temporary ID for testing
				name: input.name,
				providerType: input.providerType,
				enabled: input.enabled ?? true,
				stalkerConfig,
				xstreamConfig,
				m3uConfig,
				cinephageIptvConfig: input.cinephageIptvConfig,
				playbackLimit: null,
				channelCount: null,
				categoryCount: null,
				expiresAt: null,
				serverTimezone: null,
				lastTestedAt: null,
				lastTestSuccess: null,
				lastTestError: null,
				lastSyncAt: null,
				lastSyncError: null,
				syncStatus: 'never',
				lastEpgSyncAt: null,
				lastEpgSyncError: null,
				epgProgramCount: 0,
				hasEpg: null,
				createdAt: now,
				updatedAt: now
			};

			const provider = getProvider(input.providerType);
			testResult = await provider.testConnection(accountForTest);

			if (!testResult.success) {
				throw new ExternalServiceError(
					input.providerType,
					testResult.error || 'Connection test failed',
					502
				);
			}
		}

		// Prepare insert data (credential fields encrypted at rest, bound to the
		// account id via AAD)
		const accountId = randomUUID();
		const insertData: typeof livetvAccounts.$inferInsert = {
			id: accountId,
			name: input.name,
			providerType: input.providerType,
			enabled: input.enabled ?? true,
			stalkerConfig: stalkerConfig
				? (encryptLivetvConfig(
						accountId,
						stalkerConfig as unknown as Record<string, unknown>
					) as unknown as StalkerConfig)
				: stalkerConfig,
			xstreamConfig: xstreamConfig
				? (encryptLivetvConfig(
						accountId,
						xstreamConfig as unknown as Record<string, unknown>
					) as unknown as XstreamConfig)
				: xstreamConfig,
			m3uConfig: m3uConfig
				? (encryptLivetvConfig(
						accountId,
						m3uConfig as unknown as Record<string, unknown>
					) as unknown as M3uConfig)
				: m3uConfig,
			iptvOrgConfig,
			createdAt: now,
			updatedAt: now
		};

		// Add test result metadata if available
		if (testResult?.success && testResult.profile) {
			insertData.playbackLimit = testResult.profile.playbackLimit;
			insertData.channelCount = testResult.profile.channelCount;
			insertData.categoryCount = testResult.profile.categoryCount;
			insertData.expiresAt = testResult.profile.expiresAt;
			insertData.serverTimezone = testResult.profile.serverTimezone;
			insertData.lastTestedAt = now;
			insertData.lastTestSuccess = true;
			insertData.lastTestError = null;
		}

		const [record] = await db.insert(livetvAccounts).values(insertData).returning();

		logger.info(
			{
				id: record.id,
				name: record.name,
				providerType: record.providerType
			},
			'Created account'
		);

		liveTvEvents.emitAccountCreated(record.id);
		return recordToAccount(record);
	}

	/**
	 * Update an existing Live TV account
	 */
	async updateAccount(id: string, updates: LiveTvAccountUpdate): Promise<LiveTvAccount | null> {
		const existing = await this.getAccount(id);
		if (!existing) {
			return null;
		}

		const now = new Date().toISOString();
		const updateData: Partial<typeof livetvAccounts.$inferInsert> = {
			updatedAt: now
		};
		let purgeAccountEpgData = false;

		// Update name
		if (updates.name !== undefined) {
			updateData.name = updates.name;
		}

		// Update enabled status
		if (updates.enabled !== undefined) {
			updateData.enabled = updates.enabled;
		}

		// Update provider configs
		if (updates.stalkerConfig && existing.providerType === 'stalker') {
			const mergedConfig = {
				...existing.stalkerConfig,
				...updates.stalkerConfig
			} as StalkerConfig;

			if (
				updates.stalkerConfig.portalUrl &&
				updates.stalkerConfig.portalUrl !== existing.stalkerConfig?.portalUrl
			) {
				mergedConfig.endpoint = await probeStalkerEndpoint(updates.stalkerConfig.portalUrl);
			}

			updateData.stalkerConfig = encryptLivetvConfig(
				id,
				mergedConfig as unknown as Record<string, unknown>
			) as unknown as StalkerConfig;
		}

		if (updates.xstreamConfig && existing.providerType === 'xstream') {
			updateData.xstreamConfig = encryptLivetvConfig(id, {
				...existing.xstreamConfig,
				...updates.xstreamConfig
			} as unknown as Record<string, unknown>) as unknown as XstreamConfig;
		}

		if (updates.m3uConfig && existing.providerType === 'm3u') {
			const mergedM3uConfig = {
				...existing.m3uConfig,
				...updates.m3uConfig
			} as M3uConfig;

			const hasExplicitEpgUrlUpdate = Object.prototype.hasOwnProperty.call(
				updates.m3uConfig,
				'epgUrl'
			);
			if (hasExplicitEpgUrlUpdate) {
				const previousEpgUrl = (existing.m3uConfig?.epgUrl ?? '').trim();
				const nextEpgUrl = (mergedM3uConfig.epgUrl ?? '').trim();
				purgeAccountEpgData = previousEpgUrl !== nextEpgUrl;
				mergedM3uConfig.epgUrl = nextEpgUrl || undefined;
			}

			updateData.m3uConfig = encryptLivetvConfig(
				id,
				mergedM3uConfig as unknown as Record<string, unknown>
			) as M3uConfig;

			if (purgeAccountEpgData) {
				// Force fresh EPG state when source changes/clears.
				updateData.epgProgramCount = 0;
				updateData.hasEpg = false;
				updateData.lastEpgSyncAt = null;
				updateData.lastEpgSyncError = null;
			}
		}

		if (updates.cinephageIptvConfig && existing.providerType === 'cinephage-iptv') {
			updateData.iptvOrgConfig = {
				...existing.cinephageIptvConfig,
				...updates.cinephageIptvConfig
			} as Record<string, unknown>;
		}

		const [record] = await db
			.update(livetvAccounts)
			.set(updateData)
			.where(eq(livetvAccounts.id, id))
			.returning();

		if (!record) {
			return null;
		}

		if (purgeAccountEpgData) {
			// Defer large deletes to background so update/save response remains fast.
			this.enqueueEpgProgramPurge(id, record.name, now);
		}

		logger.info({ id, name: record.name }, 'Updated account');
		liveTvEvents.emitAccountUpdated(id);
		return recordToAccount(record);
	}

	/**
	 * Delete a Live TV account
	 */
	async deleteAccount(id: string): Promise<boolean> {
		const result = await db.delete(livetvAccounts).where(eq(livetvAccounts.id, id));
		const deleted = (result.changes ?? 0) > 0;

		if (deleted) {
			logger.info({ id }, 'Deleted account');
			liveTvEvents.emitAccountDeleted(id);
		}

		return deleted;
	}

	/**
	 * Test a Live TV account connection
	 */
	async testAccount(id: string): Promise<LiveTvAccountTestResult> {
		const account = await this.getAccount(id);
		if (!account) {
			return {
				success: false,
				error: 'Account not found'
			};
		}

		try {
			const provider = getProviderForAccount(account);
			const providerResult = await provider.testConnection(account);
			const result = providerResult.success
				? providerResult
				: {
						...providerResult,
						error: toFriendlyLiveTvTestError(providerResult.error, account.providerType)
					};

			// Update account with test results
			const now = new Date().toISOString();
			await db
				.update(livetvAccounts)
				.set({
					lastTestedAt: now,
					lastTestSuccess: result.success,
					lastTestError: result.success ? null : (result.error ?? 'Unknown error'),
					updatedAt: now,
					...(result.success && result.profile
						? {
								playbackLimit: result.profile.playbackLimit,
								channelCount: result.profile.channelCount,
								categoryCount: result.profile.categoryCount,
								expiresAt: result.profile.expiresAt,
								serverTimezone: result.profile.serverTimezone
							}
						: {})
				})
				.where(eq(livetvAccounts.id, id));

			liveTvEvents.emitAccountUpdated(id);
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				error: toFriendlyLiveTvTestError(message, account.providerType)
			};
		}
	}

	/**
	 * Enable/disable an account
	 */
	async setEnabled(id: string, enabled: boolean): Promise<LiveTvAccount | null> {
		const [record] = await db
			.update(livetvAccounts)
			.set({
				enabled,
				updatedAt: new Date().toISOString()
			})
			.where(eq(livetvAccounts.id, id))
			.returning();

		if (!record) {
			return null;
		}

		logger.info('Account ' + (enabled ? 'enabled' : 'disabled'), {
			id,
			name: record.name
		});

		liveTvEvents.emitAccountUpdated(id);
		return recordToAccount(record);
	}

	/**
	 * Update sync status for an account
	 */
	async updateSyncStatus(
		id: string,
		status: LiveTvAccount['syncStatus'],
		error?: string
	): Promise<void> {
		const now = new Date().toISOString();
		await db
			.update(livetvAccounts)
			.set({
				syncStatus: status,
				lastSyncAt: now,
				lastSyncError: error ?? null,
				updatedAt: now
			})
			.where(eq(livetvAccounts.id, id));

		liveTvEvents.emitAccountUpdated(id);
	}

	/**
	 * Get account count by provider type
	 */
	async getAccountCounts(): Promise<Map<LiveTvProviderType, number>> {
		const records = await db
			.select({
				providerType: livetvAccounts.providerType,
				count: sql<number>`count(*)`
			})
			.from(livetvAccounts)
			.groupBy(livetvAccounts.providerType);

		const map = new Map<LiveTvProviderType, number>();
		for (const record of records) {
			map.set(record.providerType as LiveTvProviderType, record.count);
		}
		return map;
	}
}

// Singleton instance
let accountManagerInstance: LiveTvAccountManager | null = null;

/**
 * Get the singleton LiveTvAccountManager instance
 */
export function getLiveTvAccountManager(): LiveTvAccountManager {
	if (!accountManagerInstance) {
		accountManagerInstance = new LiveTvAccountManager();
	}
	return accountManagerInstance;
}
