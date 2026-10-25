/**
 * M3U Provider
 *
 * Implements the LiveTvProvider interface for M3U playlist sources.
 * Parses M3U playlists to extract channels and stream URLs.
 */

import { db } from '#lib/server/db/index.js';
import { livetvAccounts, livetvChannels, livetvCategories } from '#lib/server/db/schema.js';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { randomUUID } from 'node:crypto';
import { promisify } from 'util';
import { gunzip, inflate } from 'zlib';

const logger = createChildLogger({ logDomain: 'livetv' as const });
import { XMLParser } from 'fast-xml-parser';
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
	M3uChannelData,
	M3uConfig
} from '#lib/types/livetv.js';
import { recordToAccount } from '../LiveTvAccountManager.js';
import { resolveHttpUrl } from '../urlGuards.js';

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);

// Parsed M3U entry
interface M3uEntry {
	tvgId?: string;
	tvgName?: string;
	tvgLogo?: string;
	groupTitle?: string;
	name: string;
	url: string;
	attributes: Record<string, string>;
}

interface ParsedM3u {
	entries: M3uEntry[];
	headerEpgUrl: string | null;
}

type M3uEpgTestStatus = NonNullable<NonNullable<LiveTvAccountTestResult['profile']>['epg']>;

export class M3uProvider implements LiveTvProvider {
	readonly type = 'm3u';

	readonly capabilities: ProviderCapabilities = {
		supportsEpg: true, // Now supported via XMLTV
		supportsArchive: false,
		supportsCategories: true, // Via group-title
		requiresAuthentication: false,
		streamUrlExpires: false // M3U URLs are static
	};

	getDisplayName(): string {
		return 'M3U Playlist';
	}

	// ============================================================================
	// Authentication (M3U doesn't require auth)
	// ============================================================================

	async authenticate(_account: LiveTvAccount): Promise<AuthResult> {
		// M3U playlists don't require authentication
		return {
			success: true,
			token: 'm3u_no_auth_required'
		};
	}

	async testConnection(account: LiveTvAccount): Promise<LiveTvAccountTestResult> {
		try {
			const config = account.m3uConfig;
			if (!config) {
				return {
					success: false,
					error: 'M3U config not found'
				};
			}

			// Test by trying to fetch/parse the playlist
			let playlistContent: string;

			if (config.fileContent) {
				playlistContent = config.fileContent;
			} else if (config.url) {
				const fetchHeaders: Record<string, string> = {
					'User-Agent':
						config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
					...config.headers
				};
				const response = await fetch(config.url, {
					headers: fetchHeaders,
					signal: AbortSignal.timeout(30000)
				});

				if (!response.ok) {
					return {
						success: false,
						error: `Failed to fetch playlist: HTTP ${response.status}`
					};
				}

				playlistContent = await response.text();
			} else {
				return {
					success: false,
					error: 'No M3U URL or file content provided'
				};
			}

			// Try to parse
			const parsed = this.parseM3u(playlistContent);
			const entries = parsed.entries;
			const configuredEpgUrl = config.epgUrl?.trim();
			const derivedEpgUrl = parsed.headerEpgUrl;
			const epgUrl = configuredEpgUrl || derivedEpgUrl || null;
			const epgSource = configuredEpgUrl
				? 'configured'
				: derivedEpgUrl
					? 'playlist-header'
					: undefined;
			const epg = await this.testEpgConnection(epgUrl, epgSource, config);

			return {
				success: true,
				profile: {
					playbackLimit: 0,
					channelCount: entries.length,
					categoryCount: new Set(entries.map((e) => e.groupTitle).filter(Boolean)).size,
					expiresAt: null,
					serverTimezone: 'UTC',
					streamVerified: false,
					epg
				}
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				error: message
			};
		}
	}

	isAuthenticated(_account: LiveTvAccount): boolean {
		// M3U is always "authenticated" (no auth required)
		return true;
	}

	// ============================================================================
	// Channel Sync
	// ============================================================================

	async syncChannels(accountId: string): Promise<ChannelSyncResult> {
		const startTime = Date.now();

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
			const config = account.m3uConfig;

			if (!config) {
				throw new Error('M3U config not found for account');
			}

			// Fetch or use playlist content
			let playlistContent: string;
			let fetchedFromUrl = false;

			if (config.fileContent) {
				playlistContent = config.fileContent;
			} else if (config.url) {
				const fetchHeaders: Record<string, string> = {
					'User-Agent':
						config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
					...config.headers
				};
				const response = await fetch(config.url, {
					headers: fetchHeaders,
					signal: AbortSignal.timeout(30000)
				});

				if (!response.ok) {
					throw new Error(`Failed to fetch playlist: HTTP ${response.status}`);
				}

				playlistContent = await response.text();
				fetchedFromUrl = true;
			} else {
				throw new Error('No M3U URL or file content provided');
			}

			// Parse M3U
			const parsed = this.parseM3u(playlistContent);
			const entries = parsed.entries;

			// If EPG URL wasn't configured, try to derive it from the #EXTM3U header.
			const derivedEpgUrl = !config.epgUrl ? parsed.headerEpgUrl : null;
			if ((fetchedFromUrl && config.autoRefresh) || derivedEpgUrl) {
				const now = new Date().toISOString();
				const nextConfig: M3uConfig = {
					...config,
					...(fetchedFromUrl && config.autoRefresh ? { lastRefreshAt: now } : {}),
					...(derivedEpgUrl ? { epgUrl: derivedEpgUrl } : {})
				};

				await db
					.update(livetvAccounts)
					.set({
						m3uConfig: nextConfig,
						updatedAt: now
					})
					.where(eq(livetvAccounts.id, accountId));

				if (derivedEpgUrl) {
					logger.info(
						{
							accountId,
							epgUrl: derivedEpgUrl
						},
						'[M3uProvider] Derived EPG URL from playlist header'
					);
				}
			}

			// Get existing categories
			const existingCategories = await db
				.select()
				.from(livetvCategories)
				.where(eq(livetvCategories.accountId, accountId));

			const categoryMap = new Map(existingCategories.map((c) => [c.title, c.id]));
			let categoriesAdded = 0;
			let categoriesUpdated = 0;

			// Create categories from group titles
			const groupTitles = [...new Set(entries.map((e) => e.groupTitle).filter(Boolean))];

			for (const title of groupTitles) {
				if (!title) continue;
				const existingId = categoryMap.get(title);

				if (existingId) {
					categoriesUpdated++;
				} else {
					const newId = randomUUID();
					await db.insert(livetvCategories).values({
						id: newId,
						accountId,
						providerType: 'm3u',
						externalId: title,
						title,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					});
					categoryMap.set(title, newId);
					categoriesAdded++;
				}
			}

			// Get existing channels
			const existingChannels = await db
				.select()
				.from(livetvChannels)
				.where(eq(livetvChannels.accountId, accountId));

			const channelMap = new Map(existingChannels.map((c) => [c.externalId, c.id]));
			let channelsAdded = 0;
			let channelsUpdated = 0;
			let channelsRemoved = 0;
			let duplicateTvgIdCount = 0;
			const tvgIdSeenCount = new Map<string, number>();
			const providerChannelIds = new Set<string>();

			// Sync channels
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i];
				const m3uData: M3uChannelData = {
					tvgId: entry.tvgId,
					tvgName: entry.tvgName,
					groupTitle: entry.groupTitle,
					url: entry.url,
					tvgLogo: entry.tvgLogo,
					attributes: entry.attributes
				};

				const normalizedTvgId = entry.tvgId?.trim();
				let externalId: string;
				if (normalizedTvgId) {
					const seenCount = tvgIdSeenCount.get(normalizedTvgId) ?? 0;
					tvgIdSeenCount.set(normalizedTvgId, seenCount + 1);
					if (seenCount === 0) {
						externalId = normalizedTvgId;
					} else {
						duplicateTvgIdCount++;
						// Keep IDs deterministic across sync runs for duplicate tvg-id entries.
						externalId = `${normalizedTvgId}__${seenCount + 1}`;
					}
				} else {
					// Preserve legacy fallback behavior for playlists with no tvg-id.
					externalId = `m3u_${i}`;
				}
				providerChannelIds.add(externalId);
				const categoryId = entry.groupTitle ? categoryMap.get(entry.groupTitle) : null;

				const existingId = channelMap.get(externalId);

				if (existingId) {
					await db
						.update(livetvChannels)
						.set({
							name: entry.name,
							logo: entry.tvgLogo,
							categoryId,
							providerCategoryId: entry.groupTitle || null,
							m3uData,
							updatedAt: new Date().toISOString()
						})
						.where(eq(livetvChannels.id, existingId));
					channelsUpdated++;
				} else {
					const newId = randomUUID();
					await db.insert(livetvChannels).values({
						id: newId,
						accountId,
						providerType: 'm3u',
						externalId,
						name: entry.name,
						logo: entry.tvgLogo,
						categoryId,
						providerCategoryId: entry.groupTitle || null,
						m3uData,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					});
					channelMap.set(externalId, newId);
					channelsAdded++;
				}
			}

			if (providerChannelIds.size > 0) {
				const deletedChannels = await db
					.delete(livetvChannels)
					.where(
						and(
							eq(livetvChannels.accountId, accountId),
							notInArray(livetvChannels.externalId, Array.from(providerChannelIds))
						)
					);
				channelsRemoved = deletedChannels.changes ?? 0;
			}

			const staleCategoryIds = existingCategories
				.filter((category) => !groupTitles.includes(category.title))
				.map((category) => category.id);

			if (staleCategoryIds.length > 0) {
				await db.delete(livetvCategories).where(inArray(livetvCategories.id, staleCategoryIds));
			}

			// Update account sync status
			await db
				.update(livetvAccounts)
				.set({
					channelCount: entries.length,
					categoryCount: groupTitles.length,
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
					duplicateTvgIdCount,
					duration
				},
				'[M3uProvider] Channel sync completed'
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

			logger.error({ accountId, err: error }, '[M3uProvider] Channel sync failed');

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

	// ============================================================================
	// Stream Resolution
	// ============================================================================

	async resolveStreamUrl(
		account: LiveTvAccount,
		channel: LiveTvChannel,
		_format?: 'ts' | 'hls'
	): Promise<StreamResolutionResult> {
		try {
			const m3uData = channel.m3u;

			if (!m3uData?.url) {
				return {
					success: false,
					type: 'unknown',
					error: 'Channel has no stream URL'
				};
			}

			// Detect stream type from URL
			const type = this.detectStreamType(m3uData.url);

			// Build provider headers from M3U config (custom headers/user-agent)
			const config = account.m3uConfig;
			const headers = this.buildRequestHeaders(config);

			return {
				success: true,
				url: m3uData.url,
				type,
				headers: Object.keys(headers).length > 0 ? headers : undefined
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
	// EPG (Supported via XMLTV)
	// ============================================================================

	hasEpgSupport(): boolean {
		return true;
	}

	async fetchEpg(account: LiveTvAccount, startTime: Date, endTime: Date): Promise<EpgProgram[]> {
		try {
			const config = account.m3uConfig;
			if (!config) {
				logger.debug('[M3uProvider] No M3U config found');
				return [];
			}

			let epgUrl = config.epgUrl;

			if (!epgUrl) {
				let playlistContent: string | null = null;

				if (config.fileContent) {
					playlistContent = config.fileContent;
				} else if (config.url) {
					try {
						const fetchHeaders: Record<string, string> = {
							'User-Agent':
								config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
							...config.headers
						};
						const response = await fetch(config.url, {
							headers: fetchHeaders,
							signal: AbortSignal.timeout(30000)
						});
						if (response.ok) {
							playlistContent = await response.text();
						}
					} catch {
						// Ignore playlist fetch errors here and fall back to "no epg url"
					}
				}

				if (playlistContent) {
					const parsed = this.parseM3u(playlistContent);
					// The header attribute is third-party content — only honor
					// it when it parses as an ordinary http(s) URL.
					epgUrl = resolveHttpUrl(parsed.headerEpgUrl)?.toString() ?? undefined;
					if (parsed.headerEpgUrl && !epgUrl) {
						logger.warn(
							{ accountId: account.id, declared: parsed.headerEpgUrl.slice(0, 80) },
							'[M3uProvider] Playlist-declared EPG URL rejected (invalid scheme/format); ignoring'
						);
					}
				}

				if (epgUrl) {
					await db
						.update(livetvAccounts)
						.set({
							m3uConfig: {
								...config,
								epgUrl
							},
							updatedAt: new Date().toISOString()
						})
						.where(eq(livetvAccounts.id, account.id));

					logger.info(
						{
							accountId: account.id,
							epgUrl
						},
						'[M3uProvider] Derived EPG URL from playlist for EPG sync'
					);
				}
			}

			if (!epgUrl) {
				logger.debug('[M3uProvider] No EPG URL configured');
				return [];
			}

			// Fetch XMLTV data
			if (!resolveHttpUrl(epgUrl)) {
				logger.warn(
					{ accountId: account.id },
					'[M3uProvider] EPG URL is not a valid http(s) URL; skipping EPG sync'
				);
				return [];
			}
			logger.info({ epgUrl }, '[M3uProvider] Fetching XMLTV EPG');
			const headers = this.buildRequestHeaders(config);
			if (!headers['User-Agent']) {
				headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
			}

			const response = await fetch(epgUrl, {
				headers,
				signal: AbortSignal.timeout(60000) // 60s timeout for potentially large XML files
			});

			if (!response.ok) {
				throw new Error(`Failed to fetch XMLTV: HTTP ${response.status}`);
			}

			const xmlContent = await this.readXmltvContent(response, epgUrl);

			if (!xmlContent || xmlContent.length === 0) {
				logger.warn('[M3uProvider] Empty XMLTV response');
				return [];
			}

			// Parse XMLTV
			const parser = new XMLParser({
				ignoreAttributes: false,
				attributeNamePrefix: '@_',
				textNodeName: '#text',
				parseAttributeValue: false,
				trimValues: true
			});

			const parsed = parser.parse(xmlContent);

			if (!parsed?.tv) {
				logger.warn('[M3uProvider] Invalid XMLTV format: no <tv> root element');
				return [];
			}

			// Get channels for this account to map tvg-id to our channel IDs
			const channels = await db
				.select()
				.from(livetvChannels)
				.where(eq(livetvChannels.accountId, account.id));

			// Build map of XMLTV channel IDs -> one or more of our channels.
			const channelMap = new Map<string, Map<string, { id: string; externalId: string }>>();
			const localChannelLookup = new Map<string, Map<string, { id: string; externalId: string }>>();
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
			const addLocalLookupEntry = (
				value: string | undefined,
				channelInfo: { id: string; externalId: string }
			) => {
				const key = this.normalizeChannelLookupKey(value);
				if (!key) return;
				if (!localChannelLookup.has(key)) {
					localChannelLookup.set(key, new Map());
				}
				localChannelLookup.get(key)!.set(channelInfo.id, channelInfo);
			};

			for (const channel of channels) {
				const channelInfo = { id: channel.id, externalId: channel.externalId };
				const m3uData = channel.m3uData;
				addChannelMapEntry(m3uData?.tvgId, channelInfo);
				// Fallback map by externalId for playlists where XMLTV channel uses external IDs.
				addChannelMapEntry(channel.externalId, channelInfo);
				addLocalLookupEntry(m3uData?.tvgId, channelInfo);
				addLocalLookupEntry(m3uData?.tvgName, channelInfo);
				addLocalLookupEntry(channel.name, channelInfo);
				addLocalLookupEntry(channel.externalId, channelInfo);
			}

			const xmlChannels = Array.isArray(parsed.tv.channel)
				? parsed.tv.channel
				: parsed.tv.channel
					? [parsed.tv.channel]
					: [];
			let inferredChannelMappings = 0;
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
					const name = this.extractXmltvText(value);
					const normalizedName = this.normalizeChannelLookupKey(name ?? undefined);
					if (normalizedName) {
						lookupKeys.add(normalizedName);
					}
				}

				for (const key of lookupKeys) {
					const matches = localChannelLookup.get(key);
					if (!matches) continue;
					for (const [channelId, channelInfo] of matches) {
						resolvedMatches.set(channelId, channelInfo);
					}
				}

				if (resolvedMatches.size > 0) {
					channelMap.set(xmltvChannelId, resolvedMatches);
					inferredChannelMappings += resolvedMatches.size;
				}
			}

			// Parse programmes
			const programmes = Array.isArray(parsed.tv.programme)
				? parsed.tv.programme
				: parsed.tv.programme
					? [parsed.tv.programme]
					: [];
			const totalProgrammes = programmes.length;
			let matchedProgrammes = 0;
			const unmatchedXmlProgrammeChannelIds = new Set<string>();

			const programs: EpgProgram[] = [];

			for (const prog of programmes) {
				try {
					const xmltvChannelId = prog['@_channel']?.toString().trim();
					if (!xmltvChannelId) continue;

					// Find matching channels (can be multiple when tvg-id is duplicated in playlist).
					const channelInfos = channelMap.get(xmltvChannelId);
					if (!channelInfos || channelInfos.size === 0) {
						unmatchedXmlProgrammeChannelIds.add(xmltvChannelId);
						continue;
					}
					matchedProgrammes++;

					// Parse timestamps (XMLTV format: YYYYMMDDHHMMSS +TZ)
					const startStr = prog['@_start'];
					const stopStr = prog['@_stop'];

					if (!startStr || !stopStr) continue;

					const progStart = this.parseXmltvTime(startStr);
					const progEnd = this.parseXmltvTime(stopStr);

					if (!progStart || !progEnd) continue;

					// Keep any programme that overlaps the requested window.
					if (progEnd < startTime || progStart > endTime) continue;

					// Extract program info. The plain columns intentionally keep the
					// pre-i18n behavior (first element's text) so existing readers are
					// unaffected; the full per-language variant lists are preserved
					// alongside for display-time selection (migration 140).
					const title = this.extractXmltvText(prog.title);
					const description = this.extractXmltvText(prog.desc);
					const category = this.extractXmltvText(prog.category);

					const titleI18n = this.extractXmltvTexts(prog.title);
					const descriptionI18n = this.extractXmltvTexts(prog.desc);
					const categoryI18n = this.extractXmltvTexts(prog.category);

					// Handle credits (director, actors)
					let director: string | null = null;
					let actor: string | null = null;

					if (prog.credits) {
						if (prog.credits.director) {
							director = this.extractXmltvText(prog.credits.director);
						}
						if (prog.credits.actor) {
							const actors = Array.isArray(prog.credits.actor)
								? prog.credits.actor.map((a: unknown) => this.extractXmltvText(a)).filter(Boolean)
								: [this.extractXmltvText(prog.credits.actor)];
							actor = actors.join(', ') || null;
						}
					}

					for (const channelInfo of channelInfos.values()) {
						programs.push({
							id: randomUUID(),
							channelId: channelInfo.id,
							externalChannelId: channelInfo.externalId,
							accountId: account.id,
							providerType: 'm3u',
							title: title || 'Unknown',
							description,
							category,
							titleI18n: titleI18n.length > 0 ? titleI18n : null,
							descriptionI18n: descriptionI18n.length > 0 ? descriptionI18n : null,
							categoryI18n: categoryI18n.length > 0 ? categoryI18n : null,
							director,
							actor,
							startTime: progStart.toISOString(),
							endTime: progEnd.toISOString(),
							duration: Math.floor((progEnd.getTime() - progStart.getTime()) / 1000),
							hasArchive: false, // M3U doesn't support archive
							cachedAt: new Date().toISOString(),
							updatedAt: new Date().toISOString()
						});
					}
				} catch (_error) {
					// Skip malformed programmes
					continue;
				}
			}

			logger.info(
				{
					accountId: account.id,
					totalProgrammes,
					matchedProgrammes,
					inferredChannelMappings,
					unmatchedXmlProgrammeChannels: unmatchedXmlProgrammeChannelIds.size,
					unmatchedXmlProgrammeSamples: Array.from(unmatchedXmlProgrammeChannelIds).slice(0, 10),
					programsFound: programs.length,
					channelsMatched: new Set(programs.map((p) => p.channelId)).size
				},
				'[M3uProvider] XMLTV EPG parsed successfully'
			);

			return programs;
		} catch (error) {
			logger.error({ accountId: account.id, err: error }, '[M3uProvider] EPG fetch failed');
			return [];
		}
	}

	/**
	 * Parse XMLTV timestamp format: YYYYMMDDHHMMSS +HHMM or YYYYMMDDHHMMSS +HH:MM
	 */
	private parseXmltvTime(timeStr: string): Date | null {
		try {
			// XMLTV format: YYYYMMDDHHMMSS +HHMM or YYYYMMDDHHMMSS +HH:MM
			const match = timeStr.match(
				/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{2}):?(\d{2})?$/
			);
			if (!match) return null;

			const [, year, month, day, hour, minute, second, tzHour, tzMin] = match;

			// Create date in UTC
			const date = new Date(
				Date.UTC(
					parseInt(year),
					parseInt(month) - 1,
					parseInt(day),
					parseInt(hour),
					parseInt(minute),
					parseInt(second)
				)
			);

			// Apply timezone offset
			if (tzHour) {
				const tzOffsetHours = parseInt(tzHour);
				const tzOffsetMinutes = parseInt(tzMin || '0');
				const totalOffsetMinutes =
					tzOffsetHours * 60 + (tzOffsetHours < 0 ? -tzOffsetMinutes : tzOffsetMinutes);
				date.setUTCMinutes(date.getUTCMinutes() - totalOffsetMinutes);
			}

			return date;
		} catch {
			return null;
		}
	}

	/**
	 * Extract text from XMLTV text element (handles both string and object formats)
	 */
	private extractXmltvText(value: unknown): string | null {
		if (!value) return null;
		if (typeof value === 'string') return value;
		if (typeof value === 'object' && value !== null) {
			if ('#text' in value) {
				return String((value as Record<string, unknown>)['#text']);
			}
			// If it's an array, take the first element
			if (Array.isArray(value) && value.length > 0) {
				return this.extractXmltvText(value[0]);
			}
		}
		return null;
	}

	/**
	 * Extract ALL localized text variants from an XMLTV text element.
	 *
	 * XMLTV text elements (title/desc/category) may repeat with different `lang`
	 * attributes. fast-xml-parser is configured in fetchEpg with
	 * `attributeNamePrefix: '@_'`, so a parsed element looks like
	 * `{ '#text': 'News', '@_lang': 'en' }` (or a plain string when the element
	 * has no attributes), and repeated elements become an array. Every variant
	 * is collected as `{ lang, text }` with `lang` being the lower-cased
	 * `@_lang` value or null; elements without text are skipped. Source order is
	 * preserved.
	 */
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

	/**
	 * Build a normalization key for matching M3U channels against XMLTV ones.
	 *
	 * NFKD-normalizes, strips combining marks, lower-cases, then keeps only
	 * Unicode letters and numbers (`\p{L}`/`\p{N}`), so Latin diacritics
	 * collapse ('Café' → 'cafe') while non-Latin scripts (CJK, Cyrillic,
	 * Arabic, …) keep a stable key instead of collapsing to nothing. Returns
	 * null when nothing usable remains — null keys are never entered into or
	 * looked up in the lookup map, so two punctuation-only names can never
	 * cross-match.
	 */
	private normalizeChannelLookupKey(value: string | undefined): string | null {
		if (!value) return null;
		const normalized = value
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, '');
		return normalized || null;
	}

	private async testEpgConnection(
		epgUrl: string | null,
		source: 'configured' | 'playlist-header' | undefined,
		config?: M3uConfig
	): Promise<M3uEpgTestStatus> {
		if (!epgUrl) {
			return {
				status: 'not_configured'
			};
		}

		if (!resolveHttpUrl(epgUrl)) {
			return {
				status: 'unreachable',
				source,
				error: 'EPG URL is not a valid http(s) URL'
			};
		}

		try {
			const headers = this.buildRequestHeaders(config);
			if (!headers['User-Agent']) {
				headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
			}

			const response = await fetch(epgUrl, {
				headers,
				signal: AbortSignal.timeout(30000)
			});

			if (!response.ok) {
				return {
					status: 'unreachable',
					source,
					error: `HTTP ${response.status}`
				};
			}

			const xmlContent = await this.readXmltvContent(response, epgUrl);
			if (!xmlContent.trim()) {
				return {
					status: 'unreachable',
					source,
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
					source,
					error: 'Invalid XMLTV format: missing <tv> root'
				};
			}

			return {
				status: 'reachable',
				source
			};
		} catch (error) {
			return {
				status: 'unreachable',
				source,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/**
	 * Read XMLTV response body, transparently handling gzip payloads (.gz).
	 */
	private async readXmltvContent(response: Response, epgUrl: string): Promise<string> {
		const raw = new Uint8Array(await response.arrayBuffer());
		if (raw.length === 0) {
			return '';
		}

		const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
		const contentEncoding = response.headers.get('content-encoding')?.toLowerCase() ?? '';
		const hasGzipMetadataHint =
			contentType.includes('application/gzip') ||
			contentType.includes('application/x-gzip') ||
			contentEncoding.includes('gzip') ||
			contentEncoding.includes('x-gzip') ||
			/\.gz(?:$|[?#])/i.test(epgUrl);
		const hasDeflateMetadataHint = contentEncoding.includes('deflate');

		let xmlBuffer = Buffer.from(raw);
		let decompressed = false;
		const MAX_DECOMPRESS_PASSES = 2;

		for (let pass = 0; pass < MAX_DECOMPRESS_PASSES; pass++) {
			const hasGzipMagic = xmlBuffer.length >= 2 && xmlBuffer[0] === 0x1f && xmlBuffer[1] === 0x8b;
			const hasZlibDeflateMagic =
				xmlBuffer.length >= 2 &&
				xmlBuffer[0] === 0x78 &&
				(xmlBuffer[1] === 0x01 ||
					xmlBuffer[1] === 0x5e ||
					xmlBuffer[1] === 0x9c ||
					xmlBuffer[1] === 0xda);
			const metadataHintActive = pass === 0 && (hasGzipMetadataHint || hasDeflateMetadataHint);
			const shouldAttemptDecompression = hasGzipMagic || hasZlibDeflateMagic || metadataHintActive;

			if (!shouldAttemptDecompression) {
				break;
			}

			const beforeLength = xmlBuffer.length;
			try {
				if (hasGzipMagic) {
					xmlBuffer = await gunzipAsync(xmlBuffer);
				} else if (hasZlibDeflateMagic) {
					xmlBuffer = await inflateAsync(xmlBuffer);
				} else if (hasDeflateMetadataHint) {
					xmlBuffer = await inflateAsync(xmlBuffer);
				} else {
					xmlBuffer = await gunzipAsync(xmlBuffer);
				}
				decompressed = true;
				logger.debug(
					{
						epgUrl,
						pass: pass + 1,
						compressedBytes: beforeLength,
						uncompressedBytes: xmlBuffer.length
					},
					'[M3uProvider] Decompressed XMLTV payload'
				);
			} catch (error) {
				// Some providers serve plain XML from .gz URLs (or already decompressed bodies).
				const plainText = xmlBuffer.toString('utf-8');
				if (plainText.trimStart().startsWith('<')) {
					logger.debug(
						{ epgUrl },
						'[M3uProvider] XMLTV marked as compressed but response was plain text'
					);
					break;
				} else {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(`Failed to decompress XMLTV payload: ${message}`, { cause: error });
				}
			}
		}

		let xmlContent = xmlBuffer.toString('utf-8');
		if (xmlContent.charCodeAt(0) === 0xfeff) {
			xmlContent = xmlContent.slice(1);
		}
		if (!decompressed && !xmlContent.trimStart().startsWith('<')) {
			throw new Error('XMLTV payload is not valid XML after decompression attempts');
		}

		return xmlContent;
	}

	// ============================================================================
	// Archive (Not supported by M3U)
	// ============================================================================

	supportsArchive(): boolean {
		return false;
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	private parseM3u(content: string): ParsedM3u {
		const entries: M3uEntry[] = [];
		const lines = content.split('\n');
		let headerEpgUrl: string | null = null;

		let currentAttrs: Record<string, string> = {};
		let currentName = '';

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();

			if (line.startsWith('#EXTM3U')) {
				const headerAttrs = this.parseM3uAttributes(line.slice('#EXTM3U'.length));
				headerEpgUrl = this.extractHeaderEpgUrl(headerAttrs);
				continue;
			}

			if (line.startsWith('#EXTINF:')) {
				// Parse EXTINF line
				const match = line.match(/#EXTINF:([^,]*),(.*)/);
				if (match) {
					const attrsString = match[1];
					currentName = match[2].trim();

					// Parse attributes
					currentAttrs = this.parseM3uAttributes(attrsString);
				}
			} else if (line && !line.startsWith('#')) {
				// This is a URL line
				entries.push({
					tvgId: currentAttrs['tvg-id'],
					tvgName: currentAttrs['tvg-name'],
					tvgLogo: currentAttrs['tvg-logo'],
					groupTitle: currentAttrs['group-title'],
					name: currentName || 'Unknown',
					url: line,
					attributes: { ...currentAttrs }
				});

				// Reset for next entry
				currentAttrs = {};
				currentName = '';
			}
		}

		return { entries, headerEpgUrl };
	}

	private parseM3uAttributes(attributesString: string): Record<string, string> {
		const attributes: Record<string, string> = {};
		const attrRegex = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
		let attrMatch: RegExpExecArray | null;

		while ((attrMatch = attrRegex.exec(attributesString)) !== null) {
			const key = attrMatch[1].toLowerCase();
			const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
			attributes[key] = value;
		}

		return attributes;
	}

	private extractHeaderEpgUrl(attributes: Record<string, string>): string | null {
		const raw = attributes['x-tvg-url'] ?? attributes['url-tvg'] ?? attributes['tvg-url'];
		if (!raw) return null;

		for (const candidateRaw of raw.split(',')) {
			const candidate = candidateRaw.trim();
			if (!candidate) continue;
			try {
				return new URL(candidate).toString();
			} catch {
				// Try next candidate
			}
		}

		return null;
	}

	private detectStreamType(url: string): 'hls' | 'direct' | 'unknown' {
		const lowerUrl = url.toLowerCase();
		if (lowerUrl.includes('.m3u8') || lowerUrl.includes('/hls/')) {
			return 'hls';
		}
		if (lowerUrl.includes('.ts') || lowerUrl.includes('.mp4')) {
			return 'direct';
		}
		return 'unknown';
	}

	/**
	 * Build request headers from M3U config (custom headers + user agent)
	 */
	private buildRequestHeaders(config?: M3uConfig): Record<string, string> {
		const headers: Record<string, string> = {};
		if (config?.userAgent) {
			headers['User-Agent'] = config.userAgent;
		}
		if (config?.headers) {
			Object.assign(headers, config.headers);
		}
		return headers;
	}
}

// Singleton instance
let m3uProviderInstance: M3uProvider | null = null;

export function getM3uProvider(): M3uProvider {
	if (!m3uProviderInstance) {
		m3uProviderInstance = new M3uProvider();
	}
	return m3uProviderInstance;
}
