/**
 * EPG Service
 *
 * Manages Electronic Program Guide (EPG) data for Live TV.
 * Fetches EPG from provider accounts (Stalker, XStream) and provides query methods.
 * Updated for multi-provider support.
 */

import { eq, and, gte, lte, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '#lib/server/db/index.js';
import {
	livetvAccounts,
	livetvChannels,
	channelLineupItems,
	epgPrograms,
	type EpgProgramRecord
} from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { normalizeLanguageTag } from '#lib/server/languages/normalize.js';
import { getProvider } from '../providers';
import { liveTvEvents } from '../LiveTvEvents';
import { recordToAccount } from '../LiveTvAccountManager.js';
import {
	selectAutoAttachEpgSource,
	type AutoAttachCandidate,
	type AutoAttachTarget
} from './epg-utils';
import type {
	EpgProgram,
	EpgLocalizedText,
	EpgProgramWithProgress,
	EpgSyncResult,
	ChannelNowNext,
	LiveTvAccount,
	LiveTvProviderType
} from '#lib/types/livetv.js';

const logger = createChildLogger({ module: 'EpgService' });

const BATCH_SIZE = 1000;
const DEFAULT_RETENTION_HOURS = 48;
const DEFAULT_LOOKAHEAD_HOURS = 72;
const DEFAULT_LOOKBACK_HOURS = DEFAULT_RETENTION_HOURS;
export const EPG_SYNC_CANCELLED_MESSAGE = 'Sync cancelled by user';

interface EpgSyncAccountOptions {
	shouldCancel?: () => boolean;
}

interface EpgSyncAllOptions {
	shouldCancelAll?: () => boolean;
	shouldCancelAccount?: (accountId: string) => boolean;
}

export class EpgService {
	/**
	 * Update account EPG tracking columns after sync
	 */
	private async updateAccountEpgStatus(
		accountId: string,
		status: {
			success: boolean;
			programCount?: number;
			hasEpg?: boolean;
			guideEndsAt?: string | null;
			error?: string;
		}
	): Promise<void> {
		const now = new Date().toISOString();

		await db
			.update(livetvAccounts)
			.set({
				lastEpgSyncAt: now,
				lastEpgSyncError: status.success ? null : (status.error ?? null),
				...(status.programCount !== undefined && { epgProgramCount: status.programCount }),
				...(status.hasEpg !== undefined && { hasEpg: status.hasEpg }),
				updatedAt: now
			})
			.where(eq(livetvAccounts.id, accountId));
	}

	private async getAccountEpgStats(accountId: string): Promise<{
		programCount: number;
		channelsWithEpg: number;
		guideEndsAt: string | null;
	}> {
		const result = await db
			.select({
				programCount: sql<number>`count(*)`,
				channelsWithEpg: sql<number>`count(distinct ${epgPrograms.channelId})`,
				guideEndsAt: sql<string | null>`max(${epgPrograms.endTime})`
			})
			.from(epgPrograms)
			.where(eq(epgPrograms.accountId, accountId))
			.then((rows) => rows[0]);

		return {
			programCount: result?.programCount ?? 0,
			channelsWithEpg: result?.channelsWithEpg ?? 0,
			guideEndsAt: result?.guideEndsAt ?? null
		};
	}

	private async autoAttachMissingLineupEpgSources(accountId: string): Promise<number> {
		const lineupRows = await db
			.select({
				lineupItemId: channelLineupItems.id,
				channelId: channelLineupItems.channelId,
				providerType: livetvChannels.providerType,
				name: livetvChannels.name,
				categoryId: livetvChannels.categoryId
			})
			.from(channelLineupItems)
			.innerJoin(livetvChannels, eq(channelLineupItems.channelId, livetvChannels.id))
			.where(
				and(
					eq(channelLineupItems.accountId, accountId),
					isNull(channelLineupItems.epgSourceChannelId)
				)
			);

		if (lineupRows.length === 0) {
			return 0;
		}

		const channelsWithEpg = await db
			.select({
				channelId: livetvChannels.id,
				providerType: livetvChannels.providerType,
				name: livetvChannels.name,
				categoryId: livetvChannels.categoryId,
				programCount: sql<number>`count(${epgPrograms.id})`
			})
			.from(epgPrograms)
			.innerJoin(livetvChannels, eq(epgPrograms.channelId, livetvChannels.id))
			.where(eq(epgPrograms.accountId, accountId))
			.groupBy(livetvChannels.id);

		if (channelsWithEpg.length === 0) {
			return 0;
		}

		const candidates: AutoAttachCandidate[] = channelsWithEpg.map((channel) => ({
			channelId: channel.channelId,
			providerType: channel.providerType as LiveTvProviderType,
			name: channel.name,
			categoryId: channel.categoryId,
			programCount: channel.programCount
		}));
		const candidateChannelIds = new Set(candidates.map((candidate) => candidate.channelId));
		const now = new Date().toISOString();
		let attachedCount = 0;

		for (const row of lineupRows) {
			if (candidateChannelIds.has(row.channelId)) {
				continue;
			}

			const match = selectAutoAttachEpgSource(
				{
					lineupItemId: row.lineupItemId,
					channelId: row.channelId,
					providerType: row.providerType as LiveTvProviderType,
					name: row.name,
					categoryId: row.categoryId
				} satisfies AutoAttachTarget,
				candidates
			);

			if (!match) {
				continue;
			}

			await db
				.update(channelLineupItems)
				.set({
					epgSourceChannelId: match.channelId,
					updatedAt: now
				})
				.where(eq(channelLineupItems.id, row.lineupItemId));

			attachedCount++;
		}

		if (attachedCount > 0) {
			logger.info({ accountId, attachedCount }, 'Auto-attached lineup EPG sources');
			liveTvEvents.emitLineupUpdated();
		}

		return attachedCount;
	}

	/**
	 * Sync EPG data for a single account
	 */
	async syncAccount(
		accountId: string,
		options: EpgSyncAccountOptions = {}
	): Promise<EpgSyncResult> {
		const startTime = Date.now();
		const throwIfCancelled = () => {
			if (options.shouldCancel?.()) {
				throw new Error(EPG_SYNC_CANCELLED_MESSAGE);
			}
		};

		// Get account from new unified table
		const account = await db
			.select()
			.from(livetvAccounts)
			.where(eq(livetvAccounts.id, accountId))
			.limit(1)
			.then((rows) => rows[0]);

		if (!account) {
			return {
				success: false,
				accountId,
				accountName: 'Unknown',
				providerType: 'stalker',
				programsAdded: 0,
				programsUpdated: 0,
				programsRemoved: 0,
				duration: Date.now() - startTime,
				error: 'Account not found'
			};
		}

		if (!account.enabled) {
			return {
				success: false,
				accountId,
				accountName: account.name,
				providerType: account.providerType as LiveTvProviderType,
				programsAdded: 0,
				programsUpdated: 0,
				programsRemoved: 0,
				duration: Date.now() - startTime,
				error: 'Account is disabled'
			};
		}
		throwIfCancelled();

		// Get the appropriate provider
		const provider = getProvider(account.providerType as LiveTvProviderType);

		// Check if provider supports EPG
		if (!provider.hasEpgSupport()) {
			return {
				success: true,
				accountId,
				accountName: account.name,
				providerType: account.providerType as LiveTvProviderType,
				programsAdded: 0,
				programsUpdated: 0,
				programsRemoved: 0,
				duration: Date.now() - startTime
			};
		}

		try {
			logger.info(
				{
					accountId,
					name: account.name,
					providerType: account.providerType
				},
				'Starting EPG sync'
			);

			// Convert account record to LiveTvAccount type (shared mapper,
			// decrypts credential fields enveloped at rest)
			const liveTvAccount: LiveTvAccount = recordToAccount(account);

			// Calculate time range. Include historical hours so the guide can show
			// previously aired programs (within retention) after sync.
			const now = new Date();
			const rangeStart = new Date(now.getTime() - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000);
			const endTime = new Date(now.getTime() + DEFAULT_LOOKAHEAD_HOURS * 60 * 60 * 1000);

			// Fetch EPG data from provider
			throwIfCancelled();
			const epgPrograms = await provider.fetchEpg!(liveTvAccount, rangeStart, endTime);
			throwIfCancelled();

			if (epgPrograms.length === 0) {
				const accountStats = await this.getAccountEpgStats(accountId);
				logger.info(
					{
						accountId,
						name: account.name,
						providerType: account.providerType as LiveTvProviderType,
						existingPrograms: accountStats.programCount,
						existingChannelsWithEpg: accountStats.channelsWithEpg
					},
					'No EPG data returned from provider'
				);

				// Update account status based on what is currently cached.
				await this.updateAccountEpgStatus(accountId, {
					success: true,
					programCount: accountStats.programCount,
					hasEpg: accountStats.programCount > 0,
					guideEndsAt: accountStats.guideEndsAt
				});

				return {
					success: true,
					accountId,
					accountName: account.name,
					providerType: account.providerType as LiveTvProviderType,
					programsAdded: 0,
					programsUpdated: 0,
					programsRemoved: 0,
					duration: Date.now() - startTime
				};
			}

			// Build a map of external channel IDs to our local channel IDs
			const channels = await db
				.select({ id: livetvChannels.id, externalId: livetvChannels.externalId })
				.from(livetvChannels)
				.where(eq(livetvChannels.accountId, accountId));

			const channelMap = new Map<string, string>();
			for (const ch of channels) {
				channelMap.set(ch.externalId, ch.id);
			}

			// Process and store EPG data
			throwIfCancelled();
			const result = await this.storeEpgData(
				accountId,
				epgPrograms,
				channelMap,
				options.shouldCancel
			);
			throwIfCancelled();
			const autoAttachedCount = await this.autoAttachMissingLineupEpgSources(accountId);
			throwIfCancelled();
			const accountStats = await this.getAccountEpgStats(accountId);

			logger.info(
				{
					accountId,
					name: account.name,
					providerType: account.providerType as LiveTvProviderType,
					...result,
					autoAttachedCount,
					channelsWithEpg: accountStats.channelsWithEpg,
					guideEndsAt: accountStats.guideEndsAt,
					duration: Date.now() - startTime
				},
				'EPG sync complete'
			);

			// Update account status - successful sync with EPG data
			await this.updateAccountEpgStatus(accountId, {
				success: true,
				programCount: accountStats.programCount,
				hasEpg: accountStats.programCount > 0,
				guideEndsAt: accountStats.guideEndsAt
			});

			return {
				success: true,
				accountId,
				accountName: account.name,
				providerType: account.providerType as LiveTvProviderType,
				...result,
				duration: Date.now() - startTime
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			const cancelled = message === EPG_SYNC_CANCELLED_MESSAGE;
			logger.error(
				{
					accountId,
					name: account.name,
					providerType: account.providerType as LiveTvProviderType,
					error: message
				},
				cancelled ? 'EPG sync cancelled' : 'EPG sync failed'
			);

			// Keep account status intact for user-initiated cancellations.
			if (!cancelled) {
				await this.updateAccountEpgStatus(accountId, {
					success: false,
					error: message
				});
			}

			return {
				success: false,
				accountId,
				accountName: account.name,
				providerType: account.providerType as LiveTvProviderType,
				programsAdded: 0,
				programsUpdated: 0,
				programsRemoved: 0,
				duration: Date.now() - startTime,
				error: message
			};
		}
	}

	/**
	 * Sync EPG data for all enabled accounts that support EPG
	 */
	async syncAll(options: EpgSyncAllOptions = {}): Promise<EpgSyncResult[]> {
		const accounts = await db.select().from(livetvAccounts).where(eq(livetvAccounts.enabled, true));

		logger.info(
			{
				accountCount: accounts.length
			},
			'Starting EPG sync for all accounts'
		);

		const results: EpgSyncResult[] = [];

		for (const account of accounts) {
			if (options.shouldCancelAll?.()) {
				logger.info('Stopping EPG all-accounts sync due to cancellation request');
				break;
			}

			const provider = getProvider(account.providerType as LiveTvProviderType);
			if (provider.hasEpgSupport()) {
				if (options.shouldCancelAccount?.(account.id)) {
					results.push({
						success: false,
						accountId: account.id,
						accountName: account.name,
						providerType: account.providerType as LiveTvProviderType,
						programsAdded: 0,
						programsUpdated: 0,
						programsRemoved: 0,
						duration: 0,
						error: EPG_SYNC_CANCELLED_MESSAGE
					});
					continue;
				}

				const result = await this.syncAccount(account.id, {
					shouldCancel: () =>
						Boolean(options.shouldCancelAll?.() || options.shouldCancelAccount?.(account.id))
				});
				results.push(result);
			}
		}

		const totalAdded = results.reduce((sum, r) => sum + r.programsAdded, 0);
		const totalUpdated = results.reduce((sum, r) => sum + r.programsUpdated, 0);
		const successful = results.filter((r) => r.success).length;

		logger.info(
			{
				accounts: accounts.length,
				successful,
				totalAdded,
				totalUpdated
			},
			'EPG sync complete for all accounts'
		);

		return results;
	}

	/**
	 * Store EPG data in the database
	 */
	private async storeEpgData(
		accountId: string,
		epgProgramsData: EpgProgram[],
		channelMap: Map<string, string>,
		shouldCancel?: () => boolean
	): Promise<{ programsAdded: number; programsUpdated: number; programsRemoved: number }> {
		let programsAdded = 0;
		let programsUpdated = 0;
		const now = new Date().toISOString();
		const unmatchedExternalChannelIds = new Set<string>();
		const makeProgramKey = (externalChannelId: string, startTime: string) =>
			`${externalChannelId}::${startTime}`;

		// Collect all programs to upsert (deduplicated by account + external channel + start time)
		const uniquePrograms = new Map<
			string,
			{
				id: string;
				channelId: string;
				externalChannelId: string;
				accountId: string;
				providerType: EpgProgram['providerType'];
				title: string;
				description: string | null;
				category: string | null;
				titleI18n: EpgLocalizedText[] | null;
				descriptionI18n: EpgLocalizedText[] | null;
				categoryI18n: EpgLocalizedText[] | null;
				director: string | null;
				actor: string | null;
				startTime: string;
				endTime: string;
				duration: number;
				hasArchive: boolean;
				cachedAt: string;
				updatedAt: string;
			}
		>();

		for (const program of epgProgramsData) {
			if (shouldCancel?.()) {
				throw new Error(EPG_SYNC_CANCELLED_MESSAGE);
			}

			const localChannelId = channelMap.get(program.externalChannelId);
			if (!localChannelId) {
				unmatchedExternalChannelIds.add(program.externalChannelId);
				continue;
			}

			const key = makeProgramKey(program.externalChannelId, program.startTime);
			uniquePrograms.set(key, {
				id: randomUUID(),
				channelId: localChannelId,
				externalChannelId: program.externalChannelId,
				accountId,
				providerType: program.providerType as LiveTvProviderType,
				title: program.title,
				description: program.description,
				category: program.category,
				titleI18n: program.titleI18n ?? null,
				descriptionI18n: program.descriptionI18n ?? null,
				categoryI18n: program.categoryI18n ?? null,
				director: program.director,
				actor: program.actor,
				startTime: program.startTime,
				endTime: program.endTime,
				duration: program.duration,
				hasArchive: program.hasArchive,
				cachedAt: now,
				updatedAt: now
			});
		}

		const allPrograms: {
			id: string;
			channelId: string;
			externalChannelId: string;
			accountId: string;
			providerType: EpgProgram['providerType'];
			title: string;
			description: string | null;
			category: string | null;
			titleI18n: EpgLocalizedText[] | null;
			descriptionI18n: EpgLocalizedText[] | null;
			categoryI18n: EpgLocalizedText[] | null;
			director: string | null;
			actor: string | null;
			startTime: string;
			endTime: string;
			duration: number;
			hasArchive: boolean;
			cachedAt: string;
			updatedAt: string;
		}[] = Array.from(uniquePrograms.values());

		if (unmatchedExternalChannelIds.size > 0) {
			logger.warn(
				{
					accountId,
					unmatchedChannelCount: unmatchedExternalChannelIds.size,
					samples: Array.from(unmatchedExternalChannelIds).slice(0, 10)
				},
				'EPG sync skipped unmatched provider channels'
			);
		}

		if (allPrograms.length > 0) {
			const existingRows = await db
				.select({
					externalChannelId: epgPrograms.externalChannelId,
					startTime: epgPrograms.startTime
				})
				.from(epgPrograms)
				.where(eq(epgPrograms.accountId, accountId));

			const existingKeys = new Set(
				existingRows.map((row) => makeProgramKey(row.externalChannelId, row.startTime))
			);

			for (const key of uniquePrograms.keys()) {
				if (existingKeys.has(key)) {
					programsUpdated++;
				} else {
					programsAdded++;
				}
			}
		}

		// Upsert programs in batches
		for (let i = 0; i < allPrograms.length; i += BATCH_SIZE) {
			if (shouldCancel?.()) {
				throw new Error(EPG_SYNC_CANCELLED_MESSAGE);
			}

			const batch = allPrograms.slice(i, i + BATCH_SIZE);
			if (batch.length === 0) {
				continue;
			}

			await db
				.insert(epgPrograms)
				.values(batch)
				.onConflictDoUpdate({
					target: [epgPrograms.accountId, epgPrograms.externalChannelId, epgPrograms.startTime],
					set: {
						channelId: sql`excluded.channel_id`,
						providerType: sql`excluded.provider_type`,
						title: sql`excluded.title`,
						description: sql`excluded.description`,
						category: sql`excluded.category`,
						titleI18n: sql`excluded.title_i18n`,
						descriptionI18n: sql`excluded.description_i18n`,
						categoryI18n: sql`excluded.category_i18n`,
						director: sql`excluded.director`,
						actor: sql`excluded.actor`,
						endTime: sql`excluded.end_time`,
						duration: sql`excluded.duration`,
						hasArchive: sql`excluded.has_archive`,
						cachedAt: sql`excluded.cached_at`,
						updatedAt: sql`excluded.updated_at`
					}
				});

			// Let the event loop process pending requests between write batches.
			if (i + BATCH_SIZE < allPrograms.length) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}

		// Remove old programs (past retention period)
		const cutoffTime = new Date(
			Date.now() - DEFAULT_RETENTION_HOURS * 60 * 60 * 1000
		).toISOString();
		const deleted = await db
			.delete(epgPrograms)
			.where(and(eq(epgPrograms.accountId, accountId), lte(epgPrograms.endTime, cutoffTime)));

		return {
			programsAdded,
			programsUpdated,
			programsRemoved: deleted.changes ?? 0
		};
	}

	/**
	 * Get current and next program for multiple channels
	 * @param channelIds - Array of local channel IDs (from channel_lineup_items.channel_id)
	 */
	getNowAndNext(channelIds: string[]): Map<string, ChannelNowNext> {
		if (channelIds.length === 0) {
			return new Map();
		}

		const now = new Date();
		const nowIso = now.toISOString();

		const result = new Map<string, ChannelNowNext>();

		// Initialize results
		for (const channelId of channelIds) {
			result.set(channelId, {
				channelId,
				now: null,
				next: null
			});
		}

		// Get all programs that could be current or next
		// (starts before now+2h and ends after now)
		const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();

		const programs = db
			.select()
			.from(epgPrograms)
			.where(
				and(
					inArray(epgPrograms.channelId, channelIds),
					lte(epgPrograms.startTime, twoHoursLater),
					gte(epgPrograms.endTime, nowIso)
				)
			)
			.orderBy(epgPrograms.startTime)
			.all();

		// Group by channel
		const byChannel = new Map<string, EpgProgramRecord[]>();
		for (const program of programs) {
			const existing = byChannel.get(program.channelId) || [];
			existing.push(program);
			byChannel.set(program.channelId, existing);
		}

		// Find current and next for each channel
		for (const [channelId, channelPrograms] of byChannel) {
			const entry = result.get(channelId);
			if (!entry) continue;

			for (const program of channelPrograms) {
				const startTime = new Date(program.startTime);
				const endTime = new Date(program.endTime);

				// Check if current (now is between start and end)
				if (startTime <= now && endTime > now) {
					entry.now = this.programToWithProgress(program, now);
				}
				// Check if next (starts after now and we don't have a next yet)
				else if (startTime > now && !entry.next) {
					entry.next = this.programRecordToEpgProgram(program);
				}

				// If we have both, stop
				if (entry.now && entry.next) break;
			}
		}

		return result;
	}

	/**
	 * Get programs for a time range (for guide view)
	 * @param channelIds - Array of local channel IDs
	 * @param start - Start time
	 * @param end - End time
	 * @param lang - Optional display language (validated base tag). When omitted,
	 *   the plain title/description/category columns are returned unchanged.
	 */
	getGuideData(
		channelIds: string[],
		start: Date,
		end: Date,
		lang?: string | null
	): Map<string, EpgProgram[]> {
		if (channelIds.length === 0) {
			return new Map();
		}

		const startIso = start.toISOString();
		const endIso = end.toISOString();

		const programs = db
			.select()
			.from(epgPrograms)
			.where(
				and(
					inArray(epgPrograms.channelId, channelIds),
					// Program overlaps with time range if:
					// - starts before end AND ends after start
					lte(epgPrograms.startTime, endIso),
					gte(epgPrograms.endTime, startIso)
				)
			)
			.orderBy(epgPrograms.startTime)
			.all();

		// Group by channel
		const result = new Map<string, EpgProgram[]>();

		for (const program of programs) {
			const existing = result.get(program.channelId) || [];
			existing.push(this.programRecordToEpgProgram(program, lang));
			result.set(program.channelId, existing);
		}

		return result;
	}

	/**
	 * Get programs for a single channel
	 * @param lang - Optional display language (validated base tag). When omitted,
	 *   the plain title/description/category columns are returned unchanged.
	 */
	getChannelPrograms(
		channelId: string,
		start: Date,
		end: Date,
		lang?: string | null
	): EpgProgram[] {
		const startIso = start.toISOString();
		const endIso = end.toISOString();

		const programs = db
			.select()
			.from(epgPrograms)
			.where(
				and(
					eq(epgPrograms.channelId, channelId),
					lte(epgPrograms.startTime, endIso),
					gte(epgPrograms.endTime, startIso)
				)
			)
			.orderBy(epgPrograms.startTime)
			.all();

		return programs.map((p) => this.programRecordToEpgProgram(p, lang));
	}

	/**
	 * Cleanup old EPG programs
	 * @param retentionHours - Number of hours to keep past programs
	 * @returns Number of deleted programs
	 */
	cleanup(retentionHours: number = DEFAULT_RETENTION_HOURS): number {
		const cutoffTime = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();

		const deleted = db.delete(epgPrograms).where(lte(epgPrograms.endTime, cutoffTime)).run();

		if (deleted.changes > 0) {
			logger.info(
				{
					deleted: deleted.changes,
					cutoffTime
				},
				'Cleaned up old EPG programs'
			);
		}

		return deleted.changes ?? 0;
	}

	/**
	 * Get total program count
	 */
	getProgramCount(): number {
		const result = db
			.select({ count: sql<number>`count(*)` })
			.from(epgPrograms)
			.get();
		return result?.count ?? 0;
	}

	/**
	 * Get program count by account
	 */
	getProgramCountByAccount(): Map<string, number> {
		const results = db
			.select({
				accountId: epgPrograms.accountId,
				count: sql<number>`count(*)`
			})
			.from(epgPrograms)
			.groupBy(epgPrograms.accountId)
			.all();

		const map = new Map<string, number>();
		for (const row of results) {
			map.set(row.accountId, row.count);
		}
		return map;
	}

	/**
	 * Parse a stored i18n JSON column into its entry list.
	 * Defensive against legacy/malformed values: anything that is not an array
	 * of usable entries yields null so the plain column wins.
	 */
	private parseI18nList(value: unknown): EpgLocalizedText[] | null {
		if (!Array.isArray(value)) return null;
		const entries: EpgLocalizedText[] = [];
		for (const entry of value) {
			if (typeof entry !== 'object' || entry === null) continue;
			const text = (entry as { text?: unknown }).text;
			if (typeof text !== 'string' || text === '') continue;
			const lang = (entry as { lang?: unknown }).lang;
			entries.push({
				lang: typeof lang === 'string' && lang !== '' ? lang.toLowerCase() : null,
				text
			});
		}
		return entries.length > 0 ? entries : null;
	}

	/**
	 * Display-time localized text selection (migration 140).
	 *
	 * Selection chain for a program with a stored i18n list
	 * (`[{ lang: string | null, text: string }, ...]`) and an optional requested
	 * display language:
	 *
	 *   1. exact tag match        — entry.lang equals the requested tag
	 *                               (case-insensitive)
	 *   2. base-language match    — entry.lang's base tag equals the requested
	 *                               base tag (stored "en-US" matches "en")
	 *   3. first stored entry     — source order fallback when nothing matched
	 *   4. plain column fallback  — the pre-i18n title/description/category text,
	 *                               also used when no language was requested or
	 *                               no i18n list is stored
	 *
	 * With no requested language the plain column is always returned, which is
	 * exactly the pre-migration behavior.
	 */
	private selectLocalizedText(
		i18n: EpgLocalizedText[] | null | undefined,
		lang: string | null | undefined,
		fallback: string | null
	): string | null {
		const entries = this.parseI18nList(i18n);
		if (!lang || !entries) {
			return fallback;
		}

		// Canonicalize both sides through the server registry so ISO 639-2
		// stored tags (`ger`, `zho`) and alias variants match a `de`/`zh`
		// request instead of silently falling back to the first variant.
		const requested = normalizeLanguageTag(lang);
		if (requested === 'und') return fallback;

		const canonicalEntries = entries.map((entry) => ({
			entry,
			canonical: entry.lang ? normalizeLanguageTag(entry.lang) : 'und'
		}));

		const exact = canonicalEntries.find(({ canonical }) => canonical === requested);
		if (exact) {
			return exact.entry.text;
		}

		const requestedBase = requested.split('-')[0];
		const baseMatch = canonicalEntries.find(
			({ canonical }) => canonical !== 'und' && canonical.split('-')[0] === requestedBase
		);
		if (baseMatch) {
			return baseMatch.entry.text;
		}

		return entries[0].text ?? fallback;
	}

	/**
	 * Convert database record to EpgProgram type
	 */
	private programRecordToEpgProgram(record: EpgProgramRecord, lang?: string | null): EpgProgram {
		return {
			id: record.id,
			channelId: record.channelId,
			externalChannelId: record.externalChannelId,
			accountId: record.accountId,
			providerType: record.providerType as LiveTvProviderType,
			title: this.selectLocalizedText(record.titleI18n, lang, record.title) ?? record.title,
			description: this.selectLocalizedText(record.descriptionI18n, lang, record.description),
			category: this.selectLocalizedText(record.categoryI18n, lang, record.category),
			director: record.director,
			actor: record.actor,
			startTime: record.startTime,
			endTime: record.endTime,
			duration: record.duration,
			hasArchive: record.hasArchive ?? false,
			cachedAt: record.cachedAt ?? '',
			updatedAt: record.updatedAt ?? ''
		};
	}

	/**
	 * Convert database record to EpgProgramWithProgress
	 */
	private programToWithProgress(record: EpgProgramRecord, now: Date): EpgProgramWithProgress {
		const startTime = new Date(record.startTime);
		const endTime = new Date(record.endTime);

		const elapsed = now.getTime() - startTime.getTime();
		const total = endTime.getTime() - startTime.getTime();
		const progress = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 0;
		const remainingMs = endTime.getTime() - now.getTime();
		const remainingMinutes = Math.max(0, Math.floor(remainingMs / 60000));

		return {
			...this.programRecordToEpgProgram(record),
			progress,
			isLive: true,
			remainingMinutes
		};
	}
}

// Singleton instance
let epgServiceInstance: EpgService | null = null;

export function getEpgService(): EpgService {
	if (!epgServiceInstance) {
		epgServiceInstance = new EpgService();
	}
	return epgServiceInstance;
}
