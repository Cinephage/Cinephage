/**
 * Cinephage Live Provider
 *
 * Implements the LiveTvProvider interface for the Cinephage network's live TV
 * API (https://api.cinephage.net/api/v1/live/*): a canonical, provider-independent
 * channel catalog ("the spine") plus sports/PPV events exposed through the
 * DaddyLive upstream.
 *
 * Channels are read from the canonical view: one entry per real channel, with
 * every feed that can play it (daddylive, zlive, ...). Playback is channel-scoped
 * (/channel/x/:tvgId), so adding a provider upstream does not change this client.
 * The signed HLS playlist is fetched without auth headers; its segments are
 * either camouflaged containers (daddylive-camo-1) unwrapped server-side by the
 * Live TV pipeline (see src/lib/server/livetv/streaming/camo-unwrap.ts) or need
 * a zlive Referer on playlist and segments (zlive-referer-1).
 *
 * Auth uses the standard Cinephage build identity headers injected by
 * CinephageCore - no per-account credentials.
 */

import { db } from '#lib/server/db/index.js';
import { livetvAccounts, livetvChannels, livetvCategories } from '#lib/server/db/schema.js';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { HttpError } from '#lib/server/indexers/http/index.js';
import { getCinephageCore } from '#lib/server/cinephage/core/CinephageCore.js';
import {
	unwrapHeadersForScheme,
	ZLIVE_UNWRAP_SCHEME
} from '#lib/server/livetv/streaming/playlist-unwrap.js';
import { randomUUID } from 'node:crypto';
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
	LiveTvAccountTestResult
} from '#lib/types/livetv.js';

const logger = createChildLogger({ module: 'CinephageLiveProvider', logDomain: 'livetv' as const });

const LIVE_API_BASE = '/api/v1/live';
/** Canonical ("spine") view: deduped channels, feeds grouped, overflow slots hidden. */
const CANONICAL_VIEW = 'canonical';

/** zlive streams reject requests without this Referer, on playlist and segments. */
/** daddylive feeds need no request headers (segments are camo containers). */
const DADDYLIVE_UNWRAP = 'daddylive-camo-1';
/** Unwrap schemes this client knows how to serve. */
const KNOWN_UNWRAPS = new Set([DADDYLIVE_UNWRAP, ZLIVE_UNWRAP_SCHEME]);

/** How long a resolved play payload is reused before re-minting. The signed
 * playlist URL is valid for ~1h, but the converter re-resolves every playlist
 * cycle (~3s), so a short provider-side cache keeps the channel-detail endpoint
 * from being hammered while still rotating links well before expiry. */
const PLAY_CACHE_TTL_MS = 5 * 60 * 1000;
/** Safety margin subtracted from the payload's own expiry. */
const PLAY_CACHE_EXPIRY_MARGIN_MS = 60_000;

/** Channel catalog page size + page cap (900+ channels ⇒ ~5 pages). */
const CHANNELS_PAGE_LIMIT = 200;
const CHANNELS_MAX_PAGES = 25;

/** Fallback program duration when an event is the last one on its channel. */
const DEFAULT_EVENT_DURATION_MS = 3 * 60 * 60 * 1000;
/** Maximum UTC days of schedule fetched for one EPG window. */
const MAX_SCHEDULE_DAYS = 8;

// ============================================================================
// Wire contract (api.cinephage.net /api/v1/live, ?view=canonical)
// ============================================================================

interface LiveChannelFeedDto {
	source: string;
	/** Provider-scoped id, still playable through the legacy numeric route. */
	channel_id: string;
	name?: string | null;
}

interface LiveChannelDto {
	/** Canonical id. Opaque: iptv-org ids ("SkySportsF1.uk") or ".cph". */
	id: string;
	/** Same value as id for canonical entries; kept explicit by the API. */
	tvg_id?: string | null;
	name: string;
	logo_url: string | null;
	/** Cinephage-owned taxonomy bucket (e.g. "Soccer", "Sports"). */
	category?: string | null;
	/** ISO 3166-1 alpha-2 code derived server-side by the Cinephage API. */
	country_code?: string | null;
	/** Every feed that can play this channel, ordered by provider priority. */
	feeds?: LiveChannelFeedDto[];
}

interface LiveChannelsResponse {
	channels: LiveChannelDto[];
	total: number;
}

interface LiveScheduleEvent {
	id: string;
	source: string;
	title: string;
	category: string | null;
	day_key: string;
	starts_at: string;
	channels: Array<{ id: string; name: string }>;
}

interface LiveScheduleResponse {
	day: string;
	events: LiveScheduleEvent[];
}

interface LivePlayPayload {
	channel_id: string;
	source: string;
	protocol: string;
	playlist_url: string;
	expires_at: string;
	/** "daddylive-camo-1", "zlive-referer-1", or null. */
	unwrap: string | null;
}

interface LiveChannelDetailResponse {
	channel: LiveChannelDto;
	now: LiveScheduleEvent | null;
	next: LiveScheduleEvent | null;
	play: LivePlayPayload;
}

interface CachedPlayPayload {
	url: string;
	unwrap: string | null;
	/** Headers the player pipeline must attach to playlist + segment fetches. */
	headers?: Record<string, string>;
	expiresAtMs: number;
}

export class CinephageLiveProvider implements LiveTvProvider {
	readonly type = 'cinephage-live';

	readonly capabilities: ProviderCapabilities = {
		supportsEpg: true,
		supportsArchive: false,
		supportsCategories: true,
		requiresAuthentication: false,
		streamUrlExpires: true
	};

	/** accountKey -> cached signed playlist URL (see PLAY_CACHE_TTL_MS). */
	private playCache = new Map<string, CachedPlayPayload>();

	getDisplayName(): string {
		return 'Cinephage Live';
	}

	// ============================================================================
	// Authentication (Cinephage build identity headers, no account credentials)
	// ============================================================================

	async authenticate(_account: LiveTvAccount): Promise<AuthResult> {
		return {
			success: true,
			token: 'cinephage_no_auth_required'
		};
	}

	async testConnection(_account: LiveTvAccount): Promise<LiveTvAccountTestResult> {
		try {
			const core = getCinephageCore();
			const [categoriesRes, channelsRes] = await Promise.all([
				core.get(`${LIVE_API_BASE}/categories?view=${CANONICAL_VIEW}`),
				core.get(`${LIVE_API_BASE}/channels?view=${CANONICAL_VIEW}&limit=1`)
			]);

			const categories = JSON.parse(categoriesRes.body) as { categories?: string[] };
			const channels = JSON.parse(channelsRes.body) as LiveChannelsResponse;

			return {
				success: true,
				profile: {
					playbackLimit: 0,
					channelCount: typeof channels.total === 'number' ? channels.total : 0,
					categoryCount: Array.isArray(categories.categories) ? categories.categories.length : 0,
					expiresAt: null,
					serverTimezone: 'UTC',
					streamVerified: false
				}
			};
		} catch (error) {
			return { success: false, error: await this.toProviderError(error) };
		}
	}

	isAuthenticated(_account: LiveTvAccount): boolean {
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

			const core = getCinephageCore();

			logger.info(
				{ accountId },
				'[CinephageLive] Fetching canonical live catalog from Cinephage API'
			);

			const categoryTitles = await this.fetchCategoryTitles(core);
			const channels = await this.fetchAllChannels(core);

			// Upsert categories (externalId = title; the catalog has no other id)
			const existingCategories = await db
				.select()
				.from(livetvCategories)
				.where(eq(livetvCategories.accountId, accountId));

			const categoryMap = new Map(existingCategories.map((c) => [c.externalId, c.id]));
			let categoriesAdded = 0;
			let categoriesUpdated = 0;

			for (const title of categoryTitles) {
				const existingId = categoryMap.get(title);
				const now = new Date().toISOString();

				if (existingId) {
					await db
						.update(livetvCategories)
						.set({ title, updatedAt: now })
						.where(eq(livetvCategories.id, existingId));
					categoriesUpdated++;
				} else {
					const newId = randomUUID();
					await db.insert(livetvCategories).values({
						// The id must be explicit: channels inserted below link to it
						// through the category map.
						id: newId,
						accountId,
						providerType: 'cinephage-live' as const,
						externalId: title,
						title,
						createdAt: now,
						updatedAt: now
					});
					categoryMap.set(title, newId);
					categoriesAdded++;
				}
			}

			// Upsert canonical channels. The canonical id (tvg_id) becomes the
			// channel's externalId; feeds are kept so the legacy numeric routes and
			// the schedule-based EPG can still be mapped back to the channel.
			const existingChannels = await db
				.select()
				.from(livetvChannels)
				.where(eq(livetvChannels.accountId, accountId));

			const canonicalIds = new Set(
				channels.map((channel) => canonicalChannelId(channel)).filter(Boolean)
			);
			const byExternalId = new Map(existingChannels.map((row) => [row.externalId, row]));
			// Feed id -> existing row. Legacy rows (synced before the canonical
			// view) carry the provider channel id as their externalId; canonical
			// rows carry it in feeds[]. This is what lets a pre-migration row keep
			// its database id - and therefore its lineup item - when it is re-keyed.
			const byFeedChannelId = new Map<string, (typeof existingChannels)[number]>();
			for (const row of existingChannels) {
				for (const feed of row.cinephageData?.feeds ?? []) {
					if (!byFeedChannelId.has(feed.channelId)) byFeedChannelId.set(feed.channelId, row);
				}
				if (!byFeedChannelId.has(row.externalId)) byFeedChannelId.set(row.externalId, row);
			}

			const claimedRowIds = new Set<string>();
			let channelsAdded = 0;
			let channelsUpdated = 0;
			let channelsRekeyed = 0;

			for (const channel of channels) {
				const canonicalId = canonicalChannelId(channel);
				if (!canonicalId) continue;

				const now = new Date().toISOString();
				const feeds = (channel.feeds ?? [])
					.filter(
						(feed) => feed && typeof feed.channel_id === 'string' && feed.channel_id.length > 0
					)
					.map((feed) => ({
						source: feed.source,
						channelId: feed.channel_id,
						name: feed.name ?? undefined
					}));
				const cinephageData = {
					category: channel.category ?? undefined,
					countryCode: channel.country_code ?? undefined,
					feeds: feeds.length > 0 ? feeds : undefined
				};
				const categoryId = channel.category ? (categoryMap.get(channel.category) ?? null) : null;

				let existing = byExternalId.get(canonicalId);

				if (!existing) {
					// No row with this canonical id yet. Claim a pre-canonical row by
					// feed id so its primary key (and every lineup/EPG reference)
					// survives the migration. Never steal a row that is already the
					// canonical row of a different channel.
					for (const feed of feeds) {
						const candidate = byFeedChannelId.get(feed.channelId);
						if (
							candidate &&
							!claimedRowIds.has(candidate.id) &&
							!canonicalIds.has(candidate.externalId)
						) {
							existing = candidate;
							break;
						}
					}
				}

				if (existing) {
					claimedRowIds.add(existing.id);
					const rekeyed = existing.externalId !== canonicalId;
					await db
						.update(livetvChannels)
						.set({
							externalId: canonicalId,
							name: channel.name,
							logo: channel.logo_url ?? null,
							categoryId,
							providerCategoryId: channel.category ?? null,
							cinephageData,
							updatedAt: now
						})
						.where(eq(livetvChannels.id, existing.id));
					if (rekeyed) channelsRekeyed++;
					channelsUpdated++;
				} else {
					await db.insert(livetvChannels).values({
						accountId,
						providerType: 'cinephage-live' as const,
						externalId: canonicalId,
						name: channel.name,
						logo: channel.logo_url ?? null,
						categoryId,
						providerCategoryId: channel.category ?? null,
						cinephageData,
						createdAt: now,
						updatedAt: now
					});
					channelsAdded++;
				}
			}

			// Remove stale channels/categories. Rows that were re-keyed above now
			// carry a canonical id and are kept; leftover provider-only overflow
			// slots and retired channels are removed.
			let channelsRemoved = 0;
			const providerChannelIds = [...canonicalIds];
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

			const staleCategoryIds = existingCategories
				.filter((category) => !categoryTitles.includes(category.externalId))
				.map((category) => category.id);
			if (staleCategoryIds.length > 0) {
				await db.delete(livetvCategories).where(inArray(livetvCategories.id, staleCategoryIds));
			}

			await db
				.update(livetvAccounts)
				.set({
					channelCount: channels.length,
					categoryCount: categoryTitles.length,
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
					channelsRekeyed,
					channelsRemoved,
					duration
				},
				'[CinephageLive] Canonical channel sync completed'
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
			const message = await this.toProviderError(error);
			const duration = Date.now() - startTime;

			logger.error({ accountId, err: error }, '[CinephageLive] Channel sync failed');

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
		channel: CachedChannelLike,
		_format?: 'ts' | 'hls'
	): Promise<StreamResolutionResult> {
		try {
			const play = await this.getPlayPayload(account.id, channel.externalId);

			if (play.unwrap && !KNOWN_UNWRAPS.has(play.unwrap)) {
				logger.info(
					{ channelId: channel.externalId, unwrap: play.unwrap },
					'[CinephageLive] Upstream reports an unknown unwrap scheme; the sniff chain will still apply'
				);
			}

			// Streams are always HLS. There is no native TS variant upstream; the
			// TS format is produced server-side by the HLS-to-TS converter.
			return {
				success: true,
				url: play.url,
				type: 'hls',
				...(play.headers ? { headers: play.headers } : {})
			};
		} catch (error) {
			return {
				success: false,
				type: 'unknown',
				error: await this.toProviderError(error)
			};
		}
	}

	// ============================================================================
	// EPG (schedule events per UTC day)
	// ============================================================================

	hasEpgSupport(): boolean {
		return true;
	}

	async fetchEpg(account: LiveTvAccount, startTime: Date, endTime: Date): Promise<EpgProgram[]> {
		// Failures propagate: EpgService records them on the account, so a broken
		// upstream shows up in the EPG status panel instead of silently keeping
		// stale data until retention expires it.
		const events = await this.fetchScheduleEvents(startTime, endTime);
		if (events.length === 0) return [];

		// Map upstream channel ids to internal channel rows. Schedule events still
		// carry provider-scoped feed ids, so resolve those through the canonical
		// channel's feeds[] before falling back to a direct externalId match.
		const channels = await db
			.select()
			.from(livetvChannels)
			.where(eq(livetvChannels.accountId, account.id));

		const channelMap = new Map(channels.map((c) => [c.externalId, c]));
		const feedToCanonicalId = new Map<string, string>();
		for (const channel of channels) {
			for (const feed of channel.cinephageData?.feeds ?? []) {
				if (!feedToCanonicalId.has(feed.channelId)) {
					feedToCanonicalId.set(feed.channelId, channel.externalId);
				}
			}
		}

		// Expand events to (channelId, event) pairs; EPG-only events (no
		// channels yet) cannot be linked and are skipped. Several feeds of one
		// channel can appear in the same event - collapse them to one programme.
		interface ChannelEvent {
			channelExternalId: string;
			start: Date;
			title: string;
			category: string | null;
		}
		const channelEvents: ChannelEvent[] = [];
		const seen = new Set<string>();
		for (const event of events) {
			const start = new Date(event.starts_at);
			if (Number.isNaN(start.getTime()) || event.channels.length === 0) continue;
			for (const channelRef of event.channels) {
				const channelExternalId = feedToCanonicalId.get(channelRef.id) ?? channelRef.id;
				if (!channelMap.has(channelExternalId)) continue;
				const key = `${channelExternalId}::${start.toISOString()}`;
				if (seen.has(key)) continue;
				seen.add(key);
				channelEvents.push({
					channelExternalId,
					start,
					title: event.title,
					category: event.category
				});
			}
		}

		// End each program at the next event on the same channel; the last
		// event of the window gets the default sports-event duration.
		const byChannel = new Map<string, ChannelEvent[]>();
		for (const entry of channelEvents) {
			const list = byChannel.get(entry.channelExternalId);
			if (list) {
				list.push(entry);
			} else {
				byChannel.set(entry.channelExternalId, [entry]);
			}
		}

		const programs: EpgProgram[] = [];
		const now = new Date().toISOString();

		for (const [channelExternalId, entries] of byChannel) {
			const channel = channelMap.get(channelExternalId);
			if (!channel) continue;

			entries.sort((a, b) => a.start.getTime() - b.start.getTime());

			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i];
				const next = entries[i + 1];
				const end = next ? next.start : new Date(entry.start.getTime() + DEFAULT_EVENT_DURATION_MS);
				if (end.getTime() <= entry.start.getTime()) continue;
				// Keep any programme that overlaps the requested window.
				if (end < startTime || entry.start > endTime) continue;

				programs.push({
					id: randomUUID(),
					channelId: channel.id,
					externalChannelId: channelExternalId,
					accountId: account.id,
					providerType: 'cinephage-live',
					title: entry.title,
					description: null,
					category: entry.category,
					director: null,
					actor: null,
					startTime: entry.start.toISOString(),
					endTime: end.toISOString(),
					duration: Math.round((end.getTime() - entry.start.getTime()) / 1000),
					hasArchive: false,
					cachedAt: now,
					updatedAt: now
				});
			}
		}

		return programs;
	}

	// ============================================================================
	// Archive (Not supported)
	// ============================================================================

	supportsArchive(): boolean {
		return false;
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	private async fetchCategoryTitles(core: ReturnType<typeof getCinephageCore>): Promise<string[]> {
		const response = await core.get(`${LIVE_API_BASE}/categories?view=${CANONICAL_VIEW}`);
		const data = JSON.parse(response.body) as { categories?: unknown };
		if (!Array.isArray(data.categories)) {
			throw new Error('Cinephage Live API returned an unexpected categories payload');
		}
		return data.categories.filter((title): title is string => typeof title === 'string');
	}

	private async fetchAllChannels(
		core: ReturnType<typeof getCinephageCore>
	): Promise<LiveChannelDto[]> {
		const all: LiveChannelDto[] = [];
		const seen = new Set<string>();
		let total = Number.POSITIVE_INFINITY;

		for (let page = 0; page < CHANNELS_MAX_PAGES && all.length < total; page++) {
			const params = new URLSearchParams({
				view: CANONICAL_VIEW,
				limit: String(CHANNELS_PAGE_LIMIT),
				offset: String(page * CHANNELS_PAGE_LIMIT)
			});
			const response = await core.get(`${LIVE_API_BASE}/channels?${params.toString()}`);
			const data = JSON.parse(response.body) as LiveChannelsResponse;

			if (!Array.isArray(data.channels)) {
				throw new Error('Cinephage Live API returned an unexpected channels payload');
			}

			for (const channel of data.channels) {
				// Re-fetching offset pages while the spine re-syncs can repeat an
				// entry; the canonical view is deduped, so keep the first copy.
				const id = canonicalChannelId(channel);
				if (!id || seen.has(id)) continue;
				seen.add(id);
				all.push(channel);
			}
			if (typeof data.total === 'number') total = data.total;
			if (data.channels.length === 0) break;
		}

		return all;
	}

	private async fetchScheduleEvents(startTime: Date, endTime: Date): Promise<LiveScheduleEvent[]> {
		const core = getCinephageCore();
		const events: LiveScheduleEvent[] = [];
		let dayAttempts = 0;
		let dayFailures = 0;

		// One request per UTC day covering the window.
		const cursor = new Date(
			Date.UTC(startTime.getUTCFullYear(), startTime.getUTCMonth(), startTime.getUTCDate())
		);
		const lastDay = new Date(
			Date.UTC(endTime.getUTCFullYear(), endTime.getUTCMonth(), endTime.getUTCDate())
		);

		for (let i = 0; cursor <= lastDay && i < MAX_SCHEDULE_DAYS; i++) {
			const day = cursor.toISOString().slice(0, 10);
			dayAttempts++;
			try {
				const response = await core.get(`${LIVE_API_BASE}/schedule?day=${day}`);
				const data = JSON.parse(response.body) as LiveScheduleResponse;
				if (Array.isArray(data.events)) events.push(...data.events);
			} catch (error) {
				// A single bad day must not take down the whole EPG sync.
				dayFailures++;
				logger.warn(
					{ day, err: error instanceof Error ? error.message : String(error) },
					'[CinephageLive] Schedule day fetch failed; skipping'
				);
			}
			cursor.setUTCDate(cursor.getUTCDate() + 1);
		}

		// Every day failing is an upstream outage, not an empty schedule - throw
		// so the sync is recorded as failed instead of silently keeping stale
		// data until retention expires it.
		if (dayAttempts > 0 && dayFailures === dayAttempts && events.length === 0) {
			throw new Error(`Cinephage Live schedule unavailable: all ${dayAttempts} day fetches failed`);
		}

		return events;
	}

	private async getPlayPayload(
		accountId: string,
		channelExternalId: string
	): Promise<CachedPlayPayload> {
		const cacheKey = `${accountId}:${channelExternalId}`;
		const cached = this.playCache.get(cacheKey);
		if (cached && Date.now() < cached.expiresAtMs) {
			return cached;
		}

		const core = getCinephageCore();
		// Canonical channels play through /channel/x/:tvgId. Numeric ids are
		// pre-migration rows (or overflow slots before the next sync) and keep
		// using the legacy provider-scoped route.
		const path = isLegacyNumericChannelId(channelExternalId)
			? `${LIVE_API_BASE}/channel/${encodeURIComponent(channelExternalId)}`
			: `${LIVE_API_BASE}/channel/x/${encodeURIComponent(channelExternalId)}`;
		const response = await core.get(path);
		const data = JSON.parse(response.body) as LiveChannelDetailResponse;

		if (!data.play?.playlist_url) {
			throw new Error(
				`Cinephage Live returned no playable stream for channel ${channelExternalId}`
			);
		}

		const expiresAtMs =
			Math.min(
				parseExpiry(data.play.expires_at) ?? Number.MAX_SAFE_INTEGER,
				Date.now() + PLAY_CACHE_TTL_MS
			) - PLAY_CACHE_EXPIRY_MARGIN_MS;

		const payload: CachedPlayPayload = {
			url: data.play.playlist_url,
			unwrap: data.play.unwrap ?? null,
			headers: headersForUnwrap(data.play.unwrap ?? null),
			expiresAtMs
		};
		this.playCache.set(cacheKey, payload);
		return payload;
	}

	/** Map client/HTTP errors to provider messages, self-healing stale identities. */
	private async toProviderError(error: unknown): Promise<string> {
		if (error instanceof HttpError) {
			if (error.status === 401) {
				// Shared mapping branches on install-key state: unregistered
				// installs get registration guidance (required once
				// install_key_required enforcement flips on); registered ones
				// keep the stale-identity self-heal path.
				return getCinephageCore().toGatewayErrorMessage(error);
			}
			if (error.status === 404) {
				return 'Channel not found or currently offline on Cinephage Live.';
			}
			if (error.status === 429) {
				return 'Cinephage Live is rate-limiting this install. Try again in a moment.';
			}
			if (error.status === 503) {
				// The API reports details.code "live_source_gated" with a fallback
				// player URL; there is no playable source through this route now.
				return 'No playable source is available for this channel right now. Try again shortly.';
			}
			return `Cinephage API returned HTTP ${error.status}`;
		}
		return error instanceof Error ? error.message : String(error);
	}
}

/** Structural subset of CachedChannel/LiveTvChannel the provider needs. */
interface CachedChannelLike {
	externalId: string;
}

/** Canonical id for a catalog entry: tvg_id is authoritative, id is the same. */
function canonicalChannelId(channel: LiveChannelDto): string {
	return channel.tvg_id || channel.id;
}

/** Pre-canonical rows and hidden overflow slots use the numeric provider ids. */
function isLegacyNumericChannelId(id: string): boolean {
	return /^\d+$/.test(id);
}

function headersForUnwrap(unwrap: string | null): Record<string, string> | undefined {
	return unwrap ? unwrapHeadersForScheme(unwrap) : undefined;
}

function parseExpiry(iso: string | undefined): number | null {
	if (!iso) return null;
	const time = Date.parse(iso);
	return Number.isNaN(time) ? null : time;
}

// Singleton instance
let instance: CinephageLiveProvider | null = null;

export function getCinephageLiveProvider(): CinephageLiveProvider {
	if (!instance) {
		instance = new CinephageLiveProvider();
	}
	return instance;
}

export function resetCinephageLiveProvider(): void {
	instance = null;
}
