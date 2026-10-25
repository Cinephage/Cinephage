/**
 * Stalker Provider
 *
 * Implements the LiveTvProvider interface for Stalker/Ministra portals.
 * Wraps the existing StalkerPortalClient to provide a unified provider interface.
 */

import { db } from '#lib/server/db/index.js';
import { livetvAccounts, livetvChannels, livetvCategories } from '#lib/server/db/schema.js';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';

const logger = createChildLogger({ logDomain: 'livetv' as const });
import type {
	LiveTvProvider,
	AuthResult,
	StreamResolutionResult,
	ProviderCapabilities,
	LiveTvAccount,
	LiveTvChannel,
	CachedChannel,
	LiveTvCategory,
	ChannelSyncResult,
	EpgProgram,
	LiveTvAccountTestResult,
	StalkerChannelData
} from '#lib/types/livetv.js';
import { StalkerPortalClient, type StalkerPortalConfig } from '../stalker/StalkerPortalClient';
import { recordToAccount } from '../LiveTvAccountManager.js';
import { decryptLivetvConfig, encryptLivetvConfig } from '../configCrypto';

export class StalkerProvider implements LiveTvProvider {
	readonly type = 'stalker';

	readonly capabilities: ProviderCapabilities = {
		supportsEpg: true,
		supportsArchive: true,
		supportsCategories: true,
		requiresAuthentication: true,
		streamUrlExpires: true
	};

	// Cache of authenticated clients per account
	private clients: Map<string, StalkerPortalClient> = new Map();

	getDisplayName(): string {
		return 'Stalker Portal';
	}

	// ============================================================================
	// Authentication
	// ============================================================================

	async authenticate(account: LiveTvAccount): Promise<AuthResult> {
		try {
			const config = this.buildClientConfig(account);
			const client = new StalkerPortalClient(config);
			await client.start();

			// Cache the authenticated client
			this.clients.set(account.id, client);

			// Update token in database if it changed
			const newToken = client.getToken();
			const stalkerConfig = account.stalkerConfig;
			if (stalkerConfig && newToken !== stalkerConfig.token) {
				await this.updateAccountToken(account.id, newToken);
			}

			return {
				success: true,
				token: newToken
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(
				{
					accountId: account.id,
					error: message
				},
				'[StalkerProvider] Authentication failed'
			);
			return {
				success: false,
				error: message
			};
		}
	}

	async testConnection(account: LiveTvAccount): Promise<LiveTvAccountTestResult> {
		try {
			// Delegate to client's testConnection which has comprehensive status/expiry
			// parsing: checks blocked flag, tariff dates, account_info phone field,
			// expire_billing_date, and correctly compares expiry dates against now.
			const config = this.buildClientConfig(account);
			const client = new StalkerPortalClient(config);
			const result = await client.testConnection();

			// Stop the client (don't cache test clients)
			client.stop();

			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(
				{
					accountId: account.id,
					error: message
				},
				'[StalkerProvider] Connection test failed'
			);
			return {
				success: false,
				error: message
			};
		}
	}

	isAuthenticated(account: LiveTvAccount): boolean {
		const client = this.clients.get(account.id);
		return client?.isAuthenticated() ?? false;
	}

	// ============================================================================
	// Channel Sync
	// ============================================================================

	async syncChannels(accountId: string): Promise<ChannelSyncResult> {
		const startTime = Date.now();

		try {
			// Get account from database
			const accountRecord = await db
				.select()
				.from(livetvAccounts)
				.where(eq(livetvAccounts.id, accountId))
				.limit(1)
				.then((rows) => rows[0]);

			if (!accountRecord) {
				throw new Error(`Account not found: ${accountId}`);
			}

			const account = recordToAccount(accountRecord);

			// Get authenticated client
			const client = await this.getClient(account);

			// Fetch categories
			const categories = await client.getGenres();

			// Get existing categories
			const existingCategories = await db
				.select()
				.from(livetvCategories)
				.where(eq(livetvCategories.accountId, accountId));

			const categoryMap = new Map(existingCategories.map((c) => [c.externalId, c.id]));

			let categoriesAdded = 0;
			let categoriesUpdated = 0;

			// Sync categories
			for (const category of categories) {
				const existingId = categoryMap.get(category.id);

				if (existingId) {
					await db
						.update(livetvCategories)
						.set({
							title: category.title,
							alias: category.alias,
							censored: category.censored,
							updatedAt: new Date().toISOString()
						})
						.where(eq(livetvCategories.id, existingId));
					categoriesUpdated++;
				} else {
					const newId = randomUUID();
					await db.insert(livetvCategories).values({
						id: newId,
						accountId,
						providerType: 'stalker',
						externalId: category.id,
						title: category.title,
						alias: category.alias,
						censored: category.censored,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					});
					categoryMap.set(category.id, newId);
					categoriesAdded++;
				}
			}

			// Fetch channels
			const channels = await client.getChannels();

			// Get existing channels
			const existingChannels = await db
				.select()
				.from(livetvChannels)
				.where(eq(livetvChannels.accountId, accountId));

			const channelMap = new Map(existingChannels.map((c) => [c.externalId, c.id]));

			let channelsAdded = 0;
			let channelsUpdated = 0;
			let channelsRemoved = 0;

			// Sync channels
			for (const channel of channels) {
				const stalkerData: StalkerChannelData = {
					stalkerGenreId: channel.genreId,
					cmd: channel.cmd,
					tvArchive: channel.tvArchive,
					archiveDuration: channel.archiveDuration
				};

				const categoryId = channel.genreId ? categoryMap.get(channel.genreId) : null;

				const existingId = channelMap.get(channel.id);

				if (existingId) {
					await db
						.update(livetvChannels)
						.set({
							name: channel.name,
							number: channel.number,
							logo: channel.logo,
							categoryId,
							providerCategoryId: channel.genreId,
							stalkerData,
							updatedAt: new Date().toISOString()
						})
						.where(eq(livetvChannels.id, existingId));
					channelsUpdated++;
				} else {
					await db.insert(livetvChannels).values({
						id: randomUUID(),
						accountId,
						providerType: 'stalker',
						externalId: channel.id,
						name: channel.name,
						number: channel.number,
						logo: channel.logo,
						categoryId,
						providerCategoryId: channel.genreId,
						stalkerData,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					});
					channelsAdded++;
				}
			}

			const providerChannelIds = channels.map((channel) => channel.id);
			if (providerChannelIds.length > 0) {
				const deletedChannels = await db
					.delete(livetvChannels)
					.where(
						and(
							eq(livetvChannels.accountId, accountId),
							notInArray(livetvChannels.externalId, providerChannelIds)
						)
					);
				channelsRemoved = deletedChannels.changes ?? 0;
			}

			const providerCategoryIds = categories.map((category) => category.id);
			const staleCategoryIds = existingCategories
				.filter((category) => !providerCategoryIds.includes(category.externalId))
				.map((category) => category.id);

			if (staleCategoryIds.length > 0) {
				await db.delete(livetvCategories).where(inArray(livetvCategories.id, staleCategoryIds));
			}

			// Update category channel counts
			for (const [externalId, categoryId] of categoryMap) {
				const count = channels.filter((c) => c.genreId === externalId).length;
				await db
					.update(livetvCategories)
					.set({ channelCount: count })
					.where(eq(livetvCategories.id, categoryId));
			}

			// Update account sync status
			await db
				.update(livetvAccounts)
				.set({
					channelCount: channels.length,
					categoryCount: categories.length,
					lastSyncAt: new Date().toISOString(),
					lastSyncError: null,
					syncStatus: 'success'
				})
				.where(eq(livetvAccounts.id, accountId));

			const duration = Date.now() - startTime;

			logger.info(
				{
					accountId,
					categoriesAdded,
					categoriesUpdated,
					channelsAdded,
					channelsUpdated,
					channelsRemoved,
					duration
				},
				'[StalkerProvider] Channel sync completed'
			);

			return {
				success: true,
				categoriesAdded,
				categoriesUpdated,
				channelsAdded,
				channelsUpdated,
				channelsRemoved,
				duration
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const duration = Date.now() - startTime;

			logger.error({ accountId, err: error }, '[StalkerProvider] Channel sync failed');

			// Update account sync status
			await db
				.update(livetvAccounts)
				.set({
					lastSyncAt: new Date().toISOString(),
					lastSyncError: message,
					syncStatus: 'failed'
				})
				.where(eq(livetvAccounts.id, accountId));

			return {
				success: false,
				categoriesAdded: 0,
				categoriesUpdated: 0,
				channelsAdded: 0,
				channelsUpdated: 0,
				channelsRemoved: 0,
				duration,
				error: message
			};
		}
	}

	async fetchCategories(_account: LiveTvAccount): Promise<LiveTvCategory[]> {
		// Categories are synced to database, fetch from there
		return [];
	}

	async fetchChannels(_account: LiveTvAccount): Promise<LiveTvChannel[]> {
		// Channels are synced to database, fetch from there
		return [];
	}

	// ============================================================================
	// Stream Resolution
	// ============================================================================

	async resolveStreamUrl(
		account: LiveTvAccount,
		channel: CachedChannel,
		format?: 'ts' | 'hls'
	): Promise<StreamResolutionResult> {
		try {
			const client = await this.getClient(account);
			const stalkerData = channel.stalker;

			if (!stalkerData?.cmd) {
				return {
					success: false,
					type: 'unknown',
					error: 'Channel has no CMD value'
				};
			}

			const streamUrlType = account.stalkerConfig?.streamUrlType ?? 'unknown';

			// Always fetch fresh stream URL to avoid expired tokens in cached stalkerData.cmd
			// getFreshStreamUrl handles both 'direct' and 'create_link' types internally
			let url = await client.getFreshStreamUrl(channel.externalId, streamUrlType);

			// Rewrite stalker portal TS streams to HLS at the provider level.
			//
			// WHY: Stalker portals enforce per-token session time limits (~24s of
			// wall-clock streaming in TS mode). When the connection drops and a new
			// token is obtained, the server replays ~20s of content from its internal
			// buffer origin, creating a visible 30-45s loop for the viewer.
			//
			// HLS avoids this because:
			// - The play_token is consumed once during the 302 redirect to the playlist
			// - Segments use hash-based URLs on the backend (e.g. /hls/{hash}/xxx.ts)
			//   that are independently fetchable without additional auth
			// - The stream proxy's HlsToTsConverter can request new tokens via
			//   createLink() for each playlist refresh, tracking segments by
			//   EXT-X-MEDIA-SEQUENCE to prevent duplicates
			//
			// The stream proxy (/api/livetv/stream/:lineupId) then converts HLS back
			// to a continuous TS stream for media server consumption. See
			// HlsToTsConverter.ts for the full conversion pipeline.
			//
			// When format=ts is explicitly requested (debugging), skip the rewrite
			// to allow raw TS passthrough.
			if (url.includes('extension=ts') && format !== 'ts') {
				url = url.replace('extension=ts', 'extension=m3u8');
				logger.debug(
					{
						channelId: channel.id,
						accountId: account.id
					},
					'[StalkerProvider] Rewrote stream URL from TS to HLS'
				);
			}

			if (format === 'ts' && url.includes('extension=ts')) {
				logger.debug(
					{
						channelId: channel.id,
						accountId: account.id
					},
					'[StalkerProvider] Keeping TS format as requested'
				);
			}

			// Detect stream type
			const type = this.detectStreamType(url);

			// Get stream headers from client (includes cookies for authentication)
			const clientHeaders = client.getStreamHeaders();
			const headers: Record<string, string> = {};
			if (typeof clientHeaders === 'object' && clientHeaders !== null) {
				if (Array.isArray(clientHeaders)) {
					// Handle [string, string][] format
					clientHeaders.forEach(([key, value]) => {
						headers[key] = value;
					});
				} else {
					// Handle Record<string, string> format
					Object.assign(headers, clientHeaders);
				}
			}

			return {
				success: true,
				url,
				type,
				headers
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(
				{
					accountId: account.id,
					channelId: channel.id,
					err: error
				},
				'[StalkerProvider] Stream resolution failed'
			);

			return {
				success: false,
				type: 'unknown',
				error: message
			};
		}
	}

	// ============================================================================
	// EPG
	// ============================================================================

	hasEpgSupport(): boolean {
		return true;
	}

	async fetchEpg(account: LiveTvAccount, startTime: Date, endTime: Date): Promise<EpgProgram[]> {
		try {
			const client = await this.getClient(account);

			// Calculate period in hours
			const periodHours = Math.ceil((endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60));

			// Get EPG data from client (returns Map of channelId -> programs)
			const epgData = await client.getEpgInfo(periodHours);

			// Get channels for this account to map external IDs to internal IDs
			const channels = await db
				.select()
				.from(livetvChannels)
				.where(eq(livetvChannels.accountId, account.id));

			const channelMap = new Map(channels.map((c) => [c.externalId, c]));

			const programs: EpgProgram[] = [];

			// Iterate over the EPG data Map
			for (const [channelExternalId, channelPrograms] of epgData.entries()) {
				const channel = channelMap.get(channelExternalId);
				if (!channel) continue;

				for (const program of channelPrograms) {
					// Use Unix timestamps for timezone-independent comparison
					const programStart = new Date(program.start_timestamp * 1000);
					const programEnd = new Date(program.stop_timestamp * 1000);
					// Keep any programme that overlaps the requested window.
					if (programEnd < startTime || programStart > endTime) continue;

					programs.push({
						id: randomUUID(),
						channelId: channel.id,
						externalChannelId: channelExternalId,
						accountId: account.id,
						providerType: 'stalker',
						title: program.name,
						description: program.descr || null,
						category: program.category || null,
						director: program.director || null,
						actor: program.actor || null,
						startTime: programStart.toISOString(),
						endTime: programEnd.toISOString(),
						duration: program.duration,
						hasArchive: program.mark_archive === 1,
						cachedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					});
				}
			}

			return programs;
		} catch (error) {
			logger.error({ accountId: account.id, err: error }, '[StalkerProvider] EPG fetch failed');
			return [];
		}
	}

	// ============================================================================
	// Archive
	// ============================================================================

	supportsArchive(): boolean {
		return true;
	}

	async getArchiveStreamUrl(
		account: LiveTvAccount,
		channel: CachedChannel,
		startTime: Date,
		_duration: number
	): Promise<StreamResolutionResult> {
		try {
			const client = await this.getClient(account);

			// Build archive command using normalized localhost format
			// Portals expect: "ffmpeg http://localhost/ch/{channelId}_" with archive params
			const normalizedCmd = `ffmpeg http://localhost/ch/${channel.externalId}_`;
			const archiveCmd = `${normalizedCmd}?utc=${Math.floor(startTime.getTime() / 1000)}&lutc=${Math.floor(Date.now() / 1000)}`;
			const url = await client.createLink(archiveCmd);

			const type = this.detectStreamType(url);

			return {
				success: true,
				url,
				type
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				type: 'unknown',
				error: message
			};
		}
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	private buildClientConfig(account: LiveTvAccount): StalkerPortalConfig {
		const config = account.stalkerConfig;
		if (!config) {
			throw new Error('Stalker config not found for account');
		}

		return {
			portalUrl: config.portalUrl,
			macAddress: config.macAddress,
			serialNumber: config.serialNumber ?? this.generateSerialNumber(),
			deviceId: config.deviceId ?? this.generateDeviceId(),
			deviceId2: config.deviceId2 ?? this.generateDeviceId(),
			model: config.model ?? 'MAG254',
			timezone: config.timezone ?? 'Europe/London',
			// Portal UI language (stb_lang / Accept-Language); old configs without
			// the field keep the previous hardcoded English behavior.
			language: config.language ?? 'en',
			token: config.token,
			username: config.username,
			password: config.password,
			endpoint: config.endpoint
		};
	}

	private async getClient(account: LiveTvAccount): Promise<StalkerPortalClient> {
		// Check cache
		const cached = this.clients.get(account.id);
		if (cached?.isAuthenticated()) {
			return cached;
		}

		// Stop old client's watchdog timer before replacing
		if (cached) {
			cached.stop();
		}

		// Create new client and authenticate
		const config = this.buildClientConfig(account);
		const client = new StalkerPortalClient(config);
		await client.start();

		// Cache client
		this.clients.set(account.id, client);

		return client;
	}

	private async updateAccountToken(accountId: string, token: string): Promise<void> {
		const account = await db
			.select()
			.from(livetvAccounts)
			.where(eq(livetvAccounts.id, accountId))
			.limit(1)
			.then((rows) => rows[0]);

		if (account?.stalkerConfig) {
			// Stored config is encrypted at rest: decrypt, merge the fresh
			// token, re-encrypt (other envelopes pass through idempotently).
			const decrypted = decryptLivetvConfig(
				accountId,
				account.stalkerConfig as unknown as Record<string, unknown>
			);
			const updatedConfig = encryptLivetvConfig(accountId, {
				...decrypted,
				token
			}) as unknown as typeof account.stalkerConfig;
			await db
				.update(livetvAccounts)
				.set({ stalkerConfig: updatedConfig })
				.where(eq(livetvAccounts.id, accountId));
		}
	}

	private generateSerialNumber(): string {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
		let sn = '';
		for (let i = 0; i < 12; i++) {
			sn += chars[randomInt(chars.length)];
		}
		return sn;
	}

	private generateDeviceId(): string {
		return randomBytes(16).toString('hex').toUpperCase();
	}

	private detectStreamType(url: string): 'hls' | 'direct' | 'unknown' {
		const lowerUrl = url.toLowerCase();
		// Check for HLS indicators: file extension, path component, or query parameter
		if (
			lowerUrl.includes('.m3u8') ||
			lowerUrl.includes('/hls/') ||
			lowerUrl.includes('extension=m3u8')
		) {
			return 'hls';
		}
		// Check for direct stream indicators: file extension or query parameter
		if (
			lowerUrl.includes('.ts') ||
			lowerUrl.includes('.mp4') ||
			lowerUrl.includes('extension=ts') ||
			lowerUrl.includes('extension=mp4')
		) {
			return 'direct';
		}
		return 'unknown';
	}
}

// Singleton instance
let stalkerProviderInstance: StalkerProvider | null = null;

export function getStalkerProvider(): StalkerProvider {
	if (!stalkerProviderInstance) {
		stalkerProviderInstance = new StalkerProvider();
	}
	return stalkerProviderInstance;
}
