/**
 * XStream Provider - Improved Implementation
 *
 * Implements the LiveTvProvider interface for XStream Codes IPTV servers.
 * Uses robust error handling and timeouts to handle slow/unreliable servers.
 */

import { db } from '#lib/server/db/index.js';
import { livetvAccounts, livetvChannels, livetvCategories } from '#lib/server/db/schema.js';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

const logger = createChildLogger({ logDomain: 'livetv' as const });
import type {
	LiveTvProvider,
	AuthResult,
	StreamResolutionResult,
	ProviderCapabilities,
	LiveTvAccount,
	LiveTvChannel,
	LiveTvCategory,
	ChannelSyncResult,
	EpgProgram,
	EpgLocalizedText,
	LiveTvAccountTestResult,
	XstreamConfig,
	XstreamChannelData
} from '#lib/types/livetv.js';
import { recordToAccount } from '../LiveTvAccountManager.js';
import { resolveHttpUrl } from '../urlGuards.js';
import { buildXstreamPlayerApiUrl, normalizeXstreamBaseUrl } from './xstream-url.js';

// XStream API Response Types
interface XstreamAuthResponse {
	user_info: {
		username: string;
		password: string;
		message?: string;
		auth?: number;
		status?: string;
		exp_date?: string;
		is_trial?: string;
		active_cons?: string;
		created_at?: string;
		max_connections?: string;
		t_allowed_output_formats?: string[];
	};
	server_info: {
		url: string;
		port: string;
		https_port: string;
		server_protocol: string;
		rtmp_port: string;
		timezone: string;
		timestamp_now: number;
		time_now: string;
	};
}

interface XstreamCategory {
	category_id: string;
	category_name: string;
	parent_id: number;
}

interface XstreamStream {
	num: number;
	name: string;
	stream_type: string;
	stream_id: number;
	stream_icon?: string;
	epg_channel_id?: string;
	added?: string;
	category_id?: string;
	custom_sid?: string;
	tv_archive?: number;
	direct_source?: string;
	tv_archive_duration?: number;
}

interface XstreamEpgEntry {
	start_timestamp?: number | string;
	stop_timestamp?: number | string;
	start?: string;
	end?: string;
	title?: string;
	description?: string;
	name?: string;
}

type XstreamEpgTestStatus = NonNullable<NonNullable<LiveTvAccountTestResult['profile']>['epg']>;

export class XstreamProvider implements LiveTvProvider {
	readonly type = 'xstream';

	readonly capabilities: ProviderCapabilities = {
		supportsEpg: true,
		supportsArchive: true,
		supportsCategories: true,
		requiresAuthentication: true,
		streamUrlExpires: false
	};

	private tokens: Map<string, { token: string; expiry: Date }> = new Map();

	getDisplayName(): string {
		return 'XStream Codes';
	}

	async authenticate(account: LiveTvAccount): Promise<AuthResult> {
		try {
			logger.debug({ accountId: account.id }, '[XstreamProvider] Starting authentication');
			const result = await this.makeAuthRequest(account);

			if (result.user_info?.auth === 0) {
				return {
					success: false,
					error: result.user_info.message || 'Authentication failed'
				};
			}

			const token = this.generateAuthToken(account);
			const expiry = new Date();
			expiry.setHours(expiry.getHours() + 24);

			this.tokens.set(account.id, { token, expiry });

			logger.debug({ accountId: account.id }, '[XstreamProvider] Authentication successful');

			return {
				success: true,
				token,
				tokenExpiry: expiry
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(
				{
					accountId: account.id,
					error: message
				},
				'[XstreamProvider] Authentication failed'
			);
			return {
				success: false,
				error: message
			};
		}
	}

	async testConnection(account: LiveTvAccount): Promise<LiveTvAccountTestResult> {
		try {
			logger.debug({ accountId: account.id }, '[XstreamProvider] Testing connection');
			const result = await this.makeAuthRequest(account);

			if (result.user_info?.auth === 0) {
				return {
					success: false,
					error: result.user_info.message || 'Authentication failed'
				};
			}

			const expDate = result.user_info?.exp_date
				? new Date(parseInt(result.user_info.exp_date) * 1000).toISOString()
				: null;

			const config = account.xstreamConfig;
			if (!config) {
				throw new Error('XStream config not found');
			}

			let categoryCount = 0;
			let channelCount = 0;
			const configuredEpgUrl = config.epgUrl?.trim();
			const epg = await this.testConfiguredXmltvEpg(configuredEpgUrl || null);

			try {
				const [categories, streams] = await Promise.all([
					this.fetchXstreamCategories(config),
					this.fetchXstreamStreams(config)
				]);
				categoryCount = categories.length;
				channelCount = streams.length;
			} catch (error) {
				logger.warn(
					{
						accountId: account.id,
						error: error instanceof Error ? error.message : String(error)
					},
					'[XstreamProvider] Connection test succeeded, but count fetch failed'
				);
			}

			logger.info(
				{
					accountId: account.id,
					channelCount,
					categoryCount
				},
				'[XstreamProvider] Connection test successful'
			);

			return {
				success: true,
				profile: {
					playbackLimit: parseInt(result.user_info?.max_connections || '1'),
					channelCount,
					categoryCount,
					expiresAt: expDate,
					serverTimezone: result.server_info?.timezone || 'UTC',
					streamVerified: false,
					epg
				}
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(
				{
					accountId: account.id,
					error: message
				},
				'[XstreamProvider] Connection test failed'
			);
			return {
				success: false,
				error: message
			};
		}
	}

	isAuthenticated(account: LiveTvAccount): boolean {
		const cached = this.tokens.get(account.id);
		if (!cached) return false;
		return cached.expiry > new Date();
	}

	async syncChannels(accountId: string): Promise<ChannelSyncResult> {
		const startTime = Date.now();
		logger.info({ accountId }, '[XstreamProvider] Starting channel sync');

		try {
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
			const config = account.xstreamConfig;

			if (!config) {
				throw new Error('XStream config not found for account');
			}

			logger.info(
				{
					accountId,
					serverUrl: config.baseUrl
				},
				'[XstreamProvider] Fetching categories'
			);

			// Fetch categories first
			const categories = await this.fetchXstreamCategories(config);
			logger.info({ accountId, count: categories.length }, '[XstreamProvider] Categories fetched');

			const existingCategories = await db
				.select()
				.from(livetvCategories)
				.where(eq(livetvCategories.accountId, accountId));

			const categoryMap = new Map(existingCategories.map((c) => [c.externalId, c.id]));
			let categoriesAdded = 0;
			let categoriesUpdated = 0;

			for (const category of categories) {
				const existingId = categoryMap.get(category.category_id);

				if (existingId) {
					await db
						.update(livetvCategories)
						.set({
							title: category.category_name,
							updatedAt: new Date().toISOString()
						})
						.where(eq(livetvCategories.id, existingId));
					categoriesUpdated++;
				} else {
					const newId = randomUUID();
					await db.insert(livetvCategories).values({
						id: newId,
						accountId,
						providerType: 'xstream',
						externalId: category.category_id,
						title: category.category_name,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					});
					categoryMap.set(category.category_id, newId);
					categoriesAdded++;
				}
			}

			logger.info(
				{
					accountId,
					categoryCount: categories.length
				},
				'[XstreamProvider] Fetching streams by category'
			);

			// Fetch streams in parallel batches for better performance
			const CONCURRENT_REQUESTS = 10;
			const allStreams: XstreamStream[] = [];

			for (let i = 0; i < categories.length; i += CONCURRENT_REQUESTS) {
				const batch = categories.slice(i, i + CONCURRENT_REQUESTS);

				// Fetch all categories in this batch concurrently
				const results = await Promise.all(
					batch.map(async (category) => {
						try {
							return await this.fetchXstreamStreamsByCategory(config, category.category_id);
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							logger.warn(
								{
									accountId,
									categoryId: category.category_id,
									error: message
								},
								'[XstreamProvider] Failed to fetch streams for category'
							);
							return [];
						}
					})
				);

				// Flatten results and add to allStreams
				results.forEach((streams) => allStreams.push(...streams));

				logger.info(
					{
						accountId,
						processed: Math.min(i + CONCURRENT_REQUESTS, categories.length),
						total: categories.length,
						streamsSoFar: allStreams.length
					},
					'[XstreamProvider] Batch progress'
				);
			}

			const streams = allStreams;
			logger.info({ accountId, count: streams.length }, '[XstreamProvider] Streams fetched');

			const existingChannels = await db
				.select()
				.from(livetvChannels)
				.where(eq(livetvChannels.accountId, accountId));

			const channelMap = new Map(existingChannels.map((c) => [c.externalId, c.id]));
			let channelsAdded = 0;
			let channelsUpdated = 0;
			let channelsRemoved = 0;

			logger.info({ accountId, count: streams.length }, '[XstreamProvider] Processing streams');

			for (let i = 0; i < streams.length; i++) {
				const stream = streams[i];

				// Log progress every 1000 channels
				if (i % 1000 === 0 && i > 0) {
					logger.info(
						{
							accountId,
							processed: i,
							total: streams.length
						},
						'[XstreamProvider] Processing progress'
					);
				}

				const xstreamData: XstreamChannelData = {
					streamId: stream.stream_id.toString(),
					streamType: stream.stream_type,
					epgChannelId: stream.epg_channel_id,
					directStreamUrl: stream.direct_source,
					containerExtension: ''
				};

				const categoryId = stream.category_id ? categoryMap.get(stream.category_id) : null;
				const existingId = channelMap.get(stream.stream_id.toString());

				if (existingId) {
					await db
						.update(livetvChannels)
						.set({
							name: stream.name,
							number: stream.num?.toString(),
							logo: stream.stream_icon,
							categoryId,
							providerCategoryId: stream.category_id,
							xstreamData,
							updatedAt: new Date().toISOString()
						})
						.where(eq(livetvChannels.id, existingId));
					channelsUpdated++;
				} else {
					await db.insert(livetvChannels).values({
						id: randomUUID(),
						accountId,
						providerType: 'xstream',
						externalId: stream.stream_id.toString(),
						name: stream.name,
						number: stream.num?.toString(),
						logo: stream.stream_icon,
						categoryId,
						providerCategoryId: stream.category_id,
						xstreamData,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					});
					channelsAdded++;
				}
			}

			const providerChannelIds = streams.map((stream) => stream.stream_id.toString());
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

			const providerCategoryIds = categories.map((category) => category.category_id);
			const staleCategoryIds = existingCategories
				.filter((category) => !providerCategoryIds.includes(category.externalId))
				.map((category) => category.id);

			if (staleCategoryIds.length > 0) {
				await db.delete(livetvCategories).where(inArray(livetvCategories.id, staleCategoryIds));
			}

			// Update account sync status
			await db
				.update(livetvAccounts)
				.set({
					channelCount: streams.length,
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
				'[XstreamProvider] Channel sync completed'
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

			logger.error(
				{
					accountId,
					error: message,
					duration
				},
				'[XstreamProvider] Channel sync failed'
			);

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
		return [];
	}

	async fetchChannels(_account: LiveTvAccount): Promise<LiveTvChannel[]> {
		return [];
	}

	async resolveStreamUrl(
		account: LiveTvAccount,
		channel: LiveTvChannel,
		_format?: 'ts' | 'hls'
	): Promise<StreamResolutionResult> {
		try {
			const config = account.xstreamConfig;
			if (!config) {
				return {
					success: false,
					type: 'unknown',
					error: 'XStream config not found'
				};
			}

			const xstreamData = channel.xstream;

			if (!xstreamData) {
				return {
					success: false,
					type: 'unknown',
					error: 'Channel has no XStream data'
				};
			}

			const baseUrl = normalizeXstreamBaseUrl(config.baseUrl);
			const format = config.outputFormat || 'ts';
			const url = `${baseUrl}/live/${config.username}/${config.password}/${xstreamData.streamId}.${format}`;

			return {
				success: true,
				url,
				type: format === 'm3u8' ? 'hls' : 'direct'
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

	hasEpgSupport(): boolean {
		return true;
	}

	async fetchEpg(account: LiveTvAccount, startTime: Date, endTime: Date): Promise<EpgProgram[]> {
		try {
			const config = account.xstreamConfig;
			if (!config) {
				logger.warn('[XstreamProvider] EPG fetch failed: no config');
				return [];
			}

			const configuredEpgUrl = config.epgUrl?.trim();
			if (configuredEpgUrl) {
				const xmltvPrograms = await this.fetchConfiguredXmltvEpg(
					account.id,
					configuredEpgUrl,
					startTime,
					endTime
				);
				if (xmltvPrograms.length > 0) {
					return xmltvPrograms;
				}

				logger.warn(
					{
						accountId: account.id,
						epgUrl: configuredEpgUrl
					},
					'[XstreamProvider] Configured XMLTV returned no programs, falling back to player_api EPG'
				);
			}

			const channels = await db
				.select()
				.from(livetvChannels)
				.where(eq(livetvChannels.accountId, account.id));

			if (channels.length === 0) {
				logger.debug('[XstreamProvider] No channels found for EPG fetch');
				return [];
			}

			const programs: EpgProgram[] = [];
			const baseUrl = normalizeXstreamBaseUrl(config.baseUrl);
			let actionOrder: string[] = ['get_epg', 'get_simple_data_table', 'get_short_epg'];
			const failedChannelSamples: Array<{ channelId: string; streamId: string }> = [];
			const errorChannelSamples: Array<{ channelId: string; streamId: string; error: string }> = [];
			let failedChannelCount = 0;
			let errorChannelCount = 0;
			const sampleLimit = 5;

			for (const channel of channels) {
				const xstreamData = channel.xstreamData;
				if (!xstreamData?.streamId) continue;

				try {
					const channelEpgResult = await this.fetchChannelEpg(
						baseUrl,
						config.username,
						config.password,
						xstreamData.streamId,
						actionOrder
					);

					if (!channelEpgResult) {
						failedChannelCount++;
						if (failedChannelSamples.length < sampleLimit) {
							failedChannelSamples.push({
								channelId: channel.id,
								streamId: xstreamData.streamId
							});
						}
						continue;
					}

					if (channelEpgResult.usedAction && channelEpgResult.usedAction !== actionOrder[0]) {
						actionOrder = [
							channelEpgResult.usedAction,
							...actionOrder.filter((a) => a !== channelEpgResult.usedAction)
						];
					}

					for (const entry of channelEpgResult.entries) {
						const entryStart = this.parseEpgTime(
							entry.start_timestamp ?? entry.start,
							entry.start_timestamp !== undefined
						);
						const entryEnd = this.parseEpgTime(
							entry.stop_timestamp ?? entry.end,
							entry.stop_timestamp !== undefined
						);

						if (!entryStart || !entryEnd) continue;
						// Keep any programme that overlaps the requested window.
						if (entryEnd < startTime || entryStart > endTime) continue;

						const title = this.decodeMaybeBase64(entry.title) ?? entry.name ?? 'Unknown';
						const description = this.decodeMaybeBase64(entry.description);

						programs.push({
							id: randomUUID(),
							channelId: channel.id,
							externalChannelId: channel.externalId,
							accountId: account.id,
							providerType: 'xstream',
							title,
							description: description || null,
							category: null,
							director: null,
							actor: null,
							startTime: entryStart.toISOString(),
							endTime: entryEnd.toISOString(),
							duration: Math.floor((entryEnd.getTime() - entryStart.getTime()) / 1000),
							hasArchive: false,
							cachedAt: new Date().toISOString(),
							updatedAt: new Date().toISOString()
						});
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					errorChannelCount++;
					if (errorChannelSamples.length < sampleLimit) {
						errorChannelSamples.push({
							channelId: channel.id,
							streamId: xstreamData.streamId,
							error: message
						});
					}
				}
			}

			if (failedChannelCount > 0 || errorChannelCount > 0) {
				logger.warn(
					{
						accountId: account.id,
						channelsChecked: channels.length,
						failedChannels: failedChannelCount,
						errorChannels: errorChannelCount,
						failedChannelSamples,
						errorChannelSamples,
						suppressedFailedChannelLogs: Math.max(
							0,
							failedChannelCount - failedChannelSamples.length
						),
						suppressedErrorChannelLogs: Math.max(0, errorChannelCount - errorChannelSamples.length)
					},
					'[XstreamProvider] EPG fetch completed with channel issues'
				);
			}

			logger.info(
				{
					accountId: account.id,
					programsFetched: programs.length,
					channelsChecked: channels.length
				},
				'[XstreamProvider] EPG fetch complete'
			);

			return programs;
		} catch (error) {
			logger.error({ accountId: account.id, err: error }, '[XstreamProvider] EPG fetch failed');
			return [];
		}
	}

	supportsArchive(): boolean {
		return true;
	}

	async getArchiveStreamUrl(
		account: LiveTvAccount,
		channel: LiveTvChannel,
		startTime: Date,
		duration: number
	): Promise<StreamResolutionResult> {
		try {
			const config = account.xstreamConfig;
			if (!config) {
				return {
					success: false,
					type: 'unknown',
					error: 'XStream config not found'
				};
			}

			const xstreamData = channel.xstream;
			if (!xstreamData) {
				return {
					success: false,
					type: 'unknown',
					error: 'Channel has no XStream data'
				};
			}

			const baseUrl = normalizeXstreamBaseUrl(config.baseUrl);
			const startTimestamp = Math.floor(startTime.getTime() / 1000);
			const url = `${baseUrl}/timeshift/${config.username}/${config.password}/${duration}/${startTimestamp}/${xstreamData.streamId}.ts`;

			return {
				success: true,
				url,
				type: 'direct'
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

	private async fetchChannelEpg(
		baseUrl: string,
		username: string,
		password: string,
		streamId: string,
		actionOrder: string[]
	): Promise<{ entries: XstreamEpgEntry[]; usedAction: string | null } | null> {
		for (const action of actionOrder) {
			const url = new URL('player_api.php', `${baseUrl}/`);
			url.searchParams.set('username', username);
			url.searchParams.set('password', password);
			url.searchParams.set('action', action);
			url.searchParams.set('stream_id', streamId);
			if (action === 'get_short_epg') {
				url.searchParams.set('limit', '200');
			}

			const response = await fetch(url.toString(), {
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
				},
				signal: AbortSignal.timeout(30000)
			});

			if (!response.ok) {
				if (response.status === 400 || response.status === 404) {
					continue;
				}
				throw new Error(`HTTP ${response.status} on action ${action}`);
			}

			const data = await response.json();
			const entries = this.extractEpgEntries(data);
			return { entries, usedAction: action };
		}

		return null;
	}

	private extractEpgEntries(data: unknown): XstreamEpgEntry[] {
		if (Array.isArray(data)) {
			return data as XstreamEpgEntry[];
		}
		if (data && typeof data === 'object') {
			const record = data as Record<string, unknown>;
			if (Array.isArray(record.epg_listings)) {
				return record.epg_listings as XstreamEpgEntry[];
			}
			if (Array.isArray(record.listings)) {
				return record.listings as XstreamEpgEntry[];
			}
		}
		return [];
	}

	private parseEpgTime(value: number | string | undefined, isTimestamp: boolean): Date | null {
		if (value === undefined || value === null) return null;

		if (isTimestamp) {
			const parsed = Number(value);
			if (!Number.isFinite(parsed) || parsed <= 0) return null;
			const millis = parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
			const date = new Date(millis);
			return Number.isNaN(date.getTime()) ? null : date;
		}

		const date = new Date(String(value));
		return Number.isNaN(date.getTime()) ? null : date;
	}

	private decodeMaybeBase64(value: string | undefined): string | null {
		if (!value) return null;
		const trimmed = value.trim();
		if (!trimmed) return null;

		if (!/^[A-Za-z0-9+/=]+$/.test(trimmed) || trimmed.length % 4 !== 0) {
			return trimmed;
		}

		try {
			const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
			return decoded || trimmed;
		} catch {
			return trimmed;
		}
	}

	private async testConfiguredXmltvEpg(epgUrl: string | null): Promise<XstreamEpgTestStatus> {
		if (!epgUrl) {
			return {
				status: 'not_configured'
			};
		}

		try {
			const response = await fetch(epgUrl, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
				},
				signal: AbortSignal.timeout(30000)
			});

			if (!response.ok) {
				return {
					status: 'unreachable',
					source: 'configured',
					error: `HTTP ${response.status}`
				};
			}

			const xmlContent = await response.text();
			if (!xmlContent.trim()) {
				return {
					status: 'unreachable',
					source: 'configured',
					error: 'Empty XMLTV response'
				};
			}

			const parser = new XMLParser({
				ignoreAttributes: false,
				attributeNamePrefix: '@_',
				textNodeName: '#text',
				parseAttributeValue: false,
				trimValues: true
			});
			const parsed = parser.parse(xmlContent);
			if (!parsed?.tv) {
				return {
					status: 'unreachable',
					source: 'configured',
					error: 'Invalid XMLTV format: missing <tv> root'
				};
			}

			return {
				status: 'reachable',
				source: 'configured'
			};
		} catch (error) {
			return {
				status: 'unreachable',
				source: 'configured',
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	private async fetchConfiguredXmltvEpg(
		accountId: string,
		epgUrl: string,
		startTime: Date,
		endTime: Date
	): Promise<EpgProgram[]> {
		if (!resolveHttpUrl(epgUrl)) {
			logger.warn(
				{ accountId },
				'[XstreamProvider] Configured EPG URL is not a valid http(s) URL; skipping EPG sync'
			);
			return [];
		}

		try {
			// Log the URL through the redaction-aware logger: Xtream EPG URLs
			// commonly embed portal credentials as query params.
			logger.info({ accountId, epgUrl }, '[XstreamProvider] Fetching configured XMLTV EPG');

			const response = await fetch(epgUrl, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
				},
				signal: AbortSignal.timeout(60000)
			});

			if (!response.ok) {
				throw new Error(`Failed to fetch XMLTV: HTTP ${response.status}`);
			}

			const xmlContent = await response.text();
			if (!xmlContent.trim()) {
				logger.warn({ accountId }, '[XstreamProvider] Configured XMLTV returned empty response');
				return [];
			}

			const parser = new XMLParser({
				ignoreAttributes: false,
				attributeNamePrefix: '@_',
				textNodeName: '#text',
				parseAttributeValue: false,
				trimValues: true
			});
			const parsed = parser.parse(xmlContent);
			if (!parsed?.tv) {
				logger.warn({ accountId }, '[XstreamProvider] Configured XMLTV missing <tv> root');
				return [];
			}

			const channels = await db
				.select()
				.from(livetvChannels)
				.where(eq(livetvChannels.accountId, accountId));

			const channelMap = new Map<string, Map<string, { id: string; externalId: string }>>();
			const normalizedLookup = new Map<string, Map<string, { id: string; externalId: string }>>();
			const addChannelMapEntry = (
				xmltvChannelId: string | undefined,
				channelInfo: { id: string; externalId: string }
			) => {
				if (!xmltvChannelId) return;
				const key = xmltvChannelId.trim();
				if (!key) return;
				if (!channelMap.has(key)) {
					channelMap.set(key, new Map());
				}
				channelMap.get(key)!.set(channelInfo.id, channelInfo);
			};
			const addNormalizedLookupEntry = (
				value: string | undefined,
				channelInfo: { id: string; externalId: string }
			) => {
				const key = this.normalizeChannelLookupKey(value);
				if (!key) return;
				if (!normalizedLookup.has(key)) {
					normalizedLookup.set(key, new Map());
				}
				normalizedLookup.get(key)!.set(channelInfo.id, channelInfo);
			};

			for (const channel of channels) {
				const channelInfo = { id: channel.id, externalId: channel.externalId };
				addChannelMapEntry(channel.xstreamData?.epgChannelId, channelInfo);
				addChannelMapEntry(channel.externalId, channelInfo);
				addNormalizedLookupEntry(channel.name, channelInfo);
				addNormalizedLookupEntry(channel.externalId, channelInfo);
				addNormalizedLookupEntry(channel.xstreamData?.epgChannelId, channelInfo);
			}

			const xmlChannels = Array.isArray(parsed.tv.channel)
				? parsed.tv.channel
				: parsed.tv.channel
					? [parsed.tv.channel]
					: [];
			for (const xmlChannel of xmlChannels) {
				const xmltvChannelId = xmlChannel?.['@_id']?.toString().trim();
				if (!xmltvChannelId || channelMap.has(xmltvChannelId)) continue;

				const resolvedMatches = new Map<string, { id: string; externalId: string }>();
				const lookupKeys = new Set<string>();

				const normalizedXmlId = this.normalizeChannelLookupKey(xmltvChannelId);
				if (normalizedXmlId) {
					lookupKeys.add(normalizedXmlId);
				}

				const displayNameValues = Array.isArray(xmlChannel?.['display-name'])
					? xmlChannel['display-name']
					: xmlChannel?.['display-name']
						? [xmlChannel['display-name']]
						: [];
				for (const value of displayNameValues) {
					const displayName = this.extractXmltvText(value);
					const normalizedName = this.normalizeChannelLookupKey(displayName ?? undefined);
					if (normalizedName) {
						lookupKeys.add(normalizedName);
					}
				}

				for (const key of lookupKeys) {
					const matches = normalizedLookup.get(key);
					if (!matches) continue;
					for (const [channelId, channelInfo] of matches) {
						resolvedMatches.set(channelId, channelInfo);
					}
				}

				if (resolvedMatches.size > 0) {
					channelMap.set(xmltvChannelId, resolvedMatches);
				}
			}

			const programmes = Array.isArray(parsed.tv.programme)
				? parsed.tv.programme
				: parsed.tv.programme
					? [parsed.tv.programme]
					: [];
			const programs: EpgProgram[] = [];

			for (const programme of programmes) {
				const xmltvChannelId = programme?.['@_channel']?.toString().trim();
				if (!xmltvChannelId) continue;

				const channelInfos = channelMap.get(xmltvChannelId);
				if (!channelInfos || channelInfos.size === 0) continue;

				const startRaw = programme?.['@_start'];
				const endRaw = programme?.['@_stop'];
				if (!startRaw || !endRaw) continue;

				const programmeStart = this.parseXmltvTime(startRaw);
				const programmeEnd = this.parseXmltvTime(endRaw);
				if (!programmeStart || !programmeEnd) continue;
				if (programmeEnd < startTime || programmeStart > endTime) continue;

				const title = this.extractXmltvText(programme?.title) ?? 'Unknown';
				const description = this.extractXmltvText(programme?.desc);
				const category = this.extractXmltvText(programme?.category);

				// Preserve every XMLTV @lang variant (parity with M3uProvider) so
				// display-time language selection works for xstream EPG too.
				const titleI18n = this.extractXmltvTexts(programme?.title);
				const descriptionI18n = this.extractXmltvTexts(programme?.desc);
				const categoryI18n = this.extractXmltvTexts(programme?.category);

				for (const channelInfo of channelInfos.values()) {
					programs.push({
						id: randomUUID(),
						channelId: channelInfo.id,
						externalChannelId: channelInfo.externalId,
						accountId,
						providerType: 'xstream',
						title,
						description: description ?? null,
						category: category ?? null,
						titleI18n: titleI18n.length > 0 ? titleI18n : null,
						descriptionI18n: descriptionI18n.length > 0 ? descriptionI18n : null,
						categoryI18n: categoryI18n.length > 0 ? categoryI18n : null,
						director: null,
						actor: null,
						startTime: programmeStart.toISOString(),
						endTime: programmeEnd.toISOString(),
						duration: Math.floor((programmeEnd.getTime() - programmeStart.getTime()) / 1000),
						hasArchive: false,
						cachedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					});
				}
			}

			logger.info(
				{
					accountId,
					programsFound: programs.length
				},
				'[XstreamProvider] Configured XMLTV EPG parsed successfully'
			);

			return programs;
		} catch (error) {
			logger.warn(
				{
					accountId,
					epgUrl,
					error: error instanceof Error ? error.message : String(error)
				},
				'[XstreamProvider] Configured XMLTV fetch failed'
			);
			return [];
		}
	}

	private parseXmltvTime(timeStr: string): Date | null {
		try {
			const cleaned = timeStr.replace(/\s+/g, ' ').trim();
			const match = cleaned.match(/^(\d{14})(?:\s*([+-]\d{4}|UTC))?$/);
			if (!match) return null;

			const dateStr = match[1];
			const timezone = match[2];

			const year = parseInt(dateStr.substring(0, 4), 10);
			const month = parseInt(dateStr.substring(4, 6), 10) - 1;
			const day = parseInt(dateStr.substring(6, 8), 10);
			const hour = parseInt(dateStr.substring(8, 10), 10);
			const minute = parseInt(dateStr.substring(10, 12), 10);
			const second = parseInt(dateStr.substring(12, 14), 10);

			const date = new Date(Date.UTC(year, month, day, hour, minute, second));
			if (Number.isNaN(date.getTime())) return null;

			if (timezone && timezone !== 'UTC') {
				const tzOffsetHours = parseInt(timezone.substring(0, 3), 10);
				const tzOffsetMinutes = parseInt(timezone.substring(3, 5), 10);
				const totalOffsetMinutes =
					tzOffsetHours * 60 + (tzOffsetHours < 0 ? -tzOffsetMinutes : tzOffsetMinutes);
				date.setUTCMinutes(date.getUTCMinutes() - totalOffsetMinutes);
			}

			return date;
		} catch {
			return null;
		}
	}

	private extractXmltvText(value: unknown): string | null {
		if (!value) return null;
		if (typeof value === 'string') return value;
		if (typeof value === 'object' && value !== null) {
			if ('#text' in value) {
				return String((value as Record<string, unknown>)['#text']);
			}
			if (Array.isArray(value) && value.length > 0) {
				return this.extractXmltvText(value[0]);
			}
		}
		return null;
	}

	private extractXmltvTexts(value: unknown): EpgLocalizedText[] {
		if (!value) return [];
		const elements = Array.isArray(value) ? value : [value];
		const texts: EpgLocalizedText[] = [];
		for (const element of elements) {
			if (element == null) continue;
			let text: string | null = null;
			let lang: string | null = null;
			if (typeof element === 'string') {
				text = element;
			} else if (typeof element === 'object') {
				const record = element as Record<string, unknown>;
				if (record['#text'] != null) {
					text = String(record['#text']);
				}
				if (typeof record['@_lang'] === 'string' && record['@_lang'].trim() !== '') {
					lang = record['@_lang'].trim().toLowerCase();
				}
			}
			if (text == null) continue;
			texts.push({ lang, text });
		}
		return texts;
	}

	private normalizeChannelLookupKey(value: string | undefined): string | null {
		if (!value) return null;
		// Unicode-aware (parity with M3uProvider): diacritics fold, non-Latin
		// scripts (CJK/Cyrillic/Arabic) keep a stable key instead of collapsing
		// to null and silently failing name-based XMLTV matching.
		const normalized = value
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, '');
		return normalized || null;
	}

	private async makeAuthRequest(account: LiveTvAccount): Promise<XstreamAuthResponse> {
		const config = account.xstreamConfig;
		if (!config) {
			throw new Error('XStream config not found');
		}

		const baseUrl = normalizeXstreamBaseUrl(config.baseUrl);
		const url = buildXstreamPlayerApiUrl(config);

		logger.debug({ url: baseUrl }, '[XstreamProvider] Making auth request');

		const response = await fetch(url, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
			}
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		return response.json();
	}

	private async fetchXstreamCategories(config: XstreamConfig): Promise<XstreamCategory[]> {
		const baseUrl = normalizeXstreamBaseUrl(config.baseUrl);
		const url = buildXstreamPlayerApiUrl(config, { action: 'get_live_categories' });

		logger.debug({ serverUrl: baseUrl }, '[XstreamProvider] Fetching categories');

		const response = await fetch(url, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
			}
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const data = await response.json();
		return Array.isArray(data) ? data : [];
	}

	private async fetchXstreamStreams(config: XstreamConfig): Promise<XstreamStream[]> {
		const baseUrl = normalizeXstreamBaseUrl(config.baseUrl);
		const url = buildXstreamPlayerApiUrl(config, { action: 'get_live_streams' });

		logger.info(
			{ serverUrl: baseUrl },
			'[XstreamProvider] Fetching streams - this may take a while for large channel lists'
		);

		const response = await fetch(url, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
			}
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const data = await response.json();
		return Array.isArray(data) ? data : [];
	}

	private async fetchXstreamStreamsByCategory(
		config: XstreamConfig,
		categoryId: string
	): Promise<XstreamStream[]> {
		const url = buildXstreamPlayerApiUrl(config, {
			action: 'get_live_streams',
			category_id: categoryId
		});

		const response = await fetch(url, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
			}
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const data = await response.json();
		return Array.isArray(data) ? data : [];
	}

	private generateAuthToken(account: LiveTvAccount): string {
		return `xstream_${account.id}_${Date.now()}`;
	}
}

let xstreamProviderInstance: XstreamProvider | null = null;

export function getXstreamProvider(): XstreamProvider {
	if (!xstreamProviderInstance) {
		xstreamProviderInstance = new XstreamProvider();
	}
	return xstreamProviderInstance;
}
