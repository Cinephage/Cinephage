/**
 * ChannelLineupService - Manages user's custom channel lineup for Live TV.
 * Provides CRUD operations and ordering for lineup items.
 * Updated for multi-provider support (Stalker, XStream, M3U).
 */

import { db } from '#lib/server/db/index.js';
import {
	channelLineupItems,
	channelLineupBackups,
	channelCategories,
	livetvAccounts,
	livetvChannels,
	livetvCategories,
	type ChannelLineupItemRecord,
	type ChannelCategoryRecord,
	type LivetvChannelRecord
} from '#lib/server/db/schema.js';
import { eq, asc, inArray, sql, and } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'livetv' as const });
import { randomUUID } from 'node:crypto';
import { normalizeLiveTvChannelName } from '#lib/livetv/channel-name-normalizer.js';
import { liveTvEvents } from '../LiveTvEvents';
import type {
	ChannelLineupItemWithDetails,
	ChannelLineupItemWithBackups,
	ChannelBackupLink,
	ChannelCategory,
	CachedChannel,
	AddToLineupRequest,
	UpdateChannelRequest,
	LiveTvProviderType
} from '#lib/types/livetv.js';

/**
 * Convert category record to API response format
 */
function toCategoryResponse(record: ChannelCategoryRecord | null): ChannelCategory | null {
	if (!record) return null;
	return {
		id: record.id,
		name: record.name,
		position: record.position,
		color: record.color,
		icon: record.icon,
		createdAt: record.createdAt || new Date().toISOString(),
		updatedAt: record.updatedAt || new Date().toISOString()
	};
}

/**
 * Convert channel record to cached channel format with provider-specific data
 */
function toChannelResponse(
	record: LivetvChannelRecord,
	categoryTitle: string | null
): CachedChannel {
	// Build provider-specific data based on provider type
	const providerData: CachedChannel = {
		id: record.id,
		accountId: record.accountId,
		providerType: record.providerType as LiveTvProviderType,
		externalId: record.externalId,
		name: record.name,
		number: record.number,
		logo: record.logo,
		categoryId: record.categoryId,
		categoryTitle,
		providerCategoryId: record.providerCategoryId,
		createdAt: record.createdAt || new Date().toISOString(),
		updatedAt: record.updatedAt || new Date().toISOString()
	};

	// Add provider-specific fields
	if (record.stalkerData) {
		providerData.stalker = record.stalkerData;
	}
	if (record.xstreamData) {
		providerData.xstream = record.xstreamData;
	}
	if (record.m3uData) {
		providerData.m3u = record.m3uData;
	}

	return providerData;
}

/**
 * Convert database record to API response format with computed display values
 */
function toLineupItem(
	record: ChannelLineupItemRecord,
	accountName: string,
	providerType: string,
	channel: LivetvChannelRecord,
	channelCategoryTitle: string | null,
	category: ChannelCategoryRecord | null = null,
	epgSourceChannel: LivetvChannelRecord | null = null,
	epgSourceCategoryTitle: string | null = null,
	epgSourceAccountName: string | null = null
): ChannelLineupItemWithDetails {
	const channelData = toChannelResponse(channel, channelCategoryTitle);

	return {
		id: record.id,
		accountId: record.accountId,
		channelId: record.channelId,
		position: record.position,
		channelNumber: record.channelNumber,
		customName: record.customName,
		customLogo: record.customLogo,
		epgId: record.epgId,
		epgSourceChannelId: record.epgSourceChannelId,
		categoryId: record.categoryId,
		addedAt: record.addedAt || new Date().toISOString(),
		updatedAt: record.updatedAt || new Date().toISOString(),
		providerType: providerType as LiveTvProviderType,
		channel: channelData,
		accountName,
		category: toCategoryResponse(category),
		displayName: record.customName || channel.name,
		displayLogo: record.customLogo || channel.logo,
		epgSourceChannel: epgSourceChannel
			? toChannelResponse(epgSourceChannel, epgSourceCategoryTitle)
			: null,
		epgSourceAccountName
	};
}

class ChannelLineupService {
	/**
	 * Get all lineup items ordered by position with joined data
	 */
	async getLineup(): Promise<ChannelLineupItemWithDetails[]> {
		// Create aliases for EPG source channel joins
		const epgSourceChannels = alias(livetvChannels, 'epgSourceChannels');
		const epgSourceAccounts = alias(livetvAccounts, 'epgSourceAccounts');

		const items = await db
			.select({
				item: channelLineupItems,
				accountName: livetvAccounts.name,
				providerType: livetvAccounts.providerType,
				channel: livetvChannels,
				category: channelCategories,
				epgSourceChannel: epgSourceChannels,
				epgSourceAccountName: epgSourceAccounts.name
			})
			.from(channelLineupItems)
			.innerJoin(livetvAccounts, eq(channelLineupItems.accountId, livetvAccounts.id))
			.innerJoin(livetvChannels, eq(channelLineupItems.channelId, livetvChannels.id))
			.leftJoin(channelCategories, eq(channelLineupItems.categoryId, channelCategories.id))
			.leftJoin(epgSourceChannels, eq(channelLineupItems.epgSourceChannelId, epgSourceChannels.id))
			.leftJoin(epgSourceAccounts, eq(epgSourceChannels.accountId, epgSourceAccounts.id))
			.orderBy(asc(channelLineupItems.position));

		// Get channel categories for the category title display (primary + EPG source)
		const allCategoryIds = [
			...new Set([
				...items.map((i) => i.channel.categoryId).filter(Boolean),
				...items.map((i) => i.epgSourceChannel?.categoryId).filter(Boolean)
			])
		];
		const channelCategoriesMap = new Map<string, string>();

		if (allCategoryIds.length > 0) {
			const cats = await db
				.select({ id: livetvCategories.id, title: livetvCategories.title })
				.from(livetvCategories)
				.where(inArray(livetvCategories.id, allCategoryIds as string[]));
			for (const cat of cats) {
				channelCategoriesMap.set(cat.id, cat.title);
			}
		}

		return items.map((row) =>
			toLineupItem(
				row.item,
				row.accountName || 'Unknown Account',
				row.providerType || 'stalker',
				row.channel,
				row.channel.categoryId ? channelCategoriesMap.get(row.channel.categoryId) || null : null,
				row.category,
				row.epgSourceChannel,
				row.epgSourceChannel?.categoryId
					? channelCategoriesMap.get(row.epgSourceChannel.categoryId) || null
					: null,
				row.epgSourceAccountName || null
			)
		);
	}

	/**
	 * Get a single lineup item by ID
	 */
	async getChannelById(id: string): Promise<ChannelLineupItemWithDetails | null> {
		// Create aliases for EPG source channel joins
		const epgSourceChannels = alias(livetvChannels, 'epgSourceChannels');
		const epgSourceAccounts = alias(livetvAccounts, 'epgSourceAccounts');

		const items = await db
			.select({
				item: channelLineupItems,
				accountName: livetvAccounts.name,
				providerType: livetvAccounts.providerType,
				channel: livetvChannels,
				category: channelCategories,
				epgSourceChannel: epgSourceChannels,
				epgSourceAccountName: epgSourceAccounts.name
			})
			.from(channelLineupItems)
			.innerJoin(livetvAccounts, eq(channelLineupItems.accountId, livetvAccounts.id))
			.innerJoin(livetvChannels, eq(channelLineupItems.channelId, livetvChannels.id))
			.leftJoin(channelCategories, eq(channelLineupItems.categoryId, channelCategories.id))
			.leftJoin(epgSourceChannels, eq(channelLineupItems.epgSourceChannelId, epgSourceChannels.id))
			.leftJoin(epgSourceAccounts, eq(epgSourceChannels.accountId, epgSourceAccounts.id))
			.where(eq(channelLineupItems.id, id))
			.limit(1);

		if (items.length === 0) return null;

		const row = items[0];

		// Get channel category titles (primary + EPG source)
		const categoryIds = [row.channel.categoryId, row.epgSourceChannel?.categoryId].filter(Boolean);
		const categoriesMap = new Map<string, string>();

		if (categoryIds.length > 0) {
			const cats = await db
				.select({ id: livetvCategories.id, title: livetvCategories.title })
				.from(livetvCategories)
				.where(inArray(livetvCategories.id, categoryIds as string[]));
			for (const cat of cats) {
				categoriesMap.set(cat.id, cat.title);
			}
		}

		return toLineupItem(
			row.item,
			row.accountName || 'Unknown Account',
			row.providerType || 'stalker',
			row.channel,
			row.channel.categoryId ? categoriesMap.get(row.channel.categoryId) || null : null,
			row.category,
			row.epgSourceChannel,
			row.epgSourceChannel?.categoryId
				? categoriesMap.get(row.epgSourceChannel.categoryId) || null
				: null,
			row.epgSourceAccountName || null
		);
	}

	/**
	 * Get lineup item count
	 */
	async getLineupCount(): Promise<number> {
		const result = await db.select({ count: sql<number>`count(*)` }).from(channelLineupItems);
		return result[0]?.count || 0;
	}

	/**
	 * Check if a channel is already in the lineup
	 */
	async isInLineup(channelId: string): Promise<boolean> {
		const existing = await db
			.select({ id: channelLineupItems.id })
			.from(channelLineupItems)
			.where(eq(channelLineupItems.channelId, channelId))
			.limit(1);
		return existing.length > 0;
	}

	/**
	 * Get set of channel IDs already in lineup (for bulk checking)
	 */
	async getLineupChannelIds(): Promise<Set<string>> {
		const items = await db
			.select({ channelId: channelLineupItems.channelId })
			.from(channelLineupItems);
		return new Set(items.map((i) => i.channelId));
	}

	/**
	 * Add channels to the lineup
	 */
	async addToLineup(request: AddToLineupRequest): Promise<{ added: number; skipped: number }> {
		if (request.channels.length === 0) {
			return { added: 0, skipped: 0 };
		}

		// Get existing channel IDs in lineup
		const existingIds = await this.getLineupChannelIds();

		// Get next position
		const maxPosResult = await db
			.select({ maxPos: sql<number>`COALESCE(MAX(position), 0)` })
			.from(channelLineupItems);
		let nextPosition = (maxPosResult[0]?.maxPos || 0) + 1;

		let added = 0;
		let skipped = 0;

		const now = new Date().toISOString();

		for (const channel of request.channels) {
			// Skip if already in lineup
			if (existingIds.has(channel.channelId)) {
				skipped++;
				continue;
			}

			await db.insert(channelLineupItems).values({
				id: randomUUID(),
				accountId: channel.accountId,
				channelId: channel.channelId,
				position: nextPosition++,
				categoryId: channel.categoryId || null,
				addedAt: now,
				updatedAt: now
			});

			added++;
			existingIds.add(channel.channelId);
		}

		logger.info({ added, skipped }, '[ChannelLineupService] Added channels to lineup');
		if (added > 0) {
			liveTvEvents.emitLineupUpdated();
		}
		return { added, skipped };
	}

	/**
	 * Remove a channel from the lineup
	 */
	async removeFromLineup(id: string): Promise<boolean> {
		const result = await db.delete(channelLineupItems).where(eq(channelLineupItems.id, id));
		if (result.changes > 0) {
			liveTvEvents.emitLineupUpdated();
		}
		return result.changes > 0;
	}

	/**
	 * Remove multiple channels from the lineup
	 */
	async bulkRemoveFromLineup(ids: string[]): Promise<number> {
		if (ids.length === 0) return 0;

		const result = await db.delete(channelLineupItems).where(inArray(channelLineupItems.id, ids));

		logger.info({ count: result.changes }, '[ChannelLineupService] Removed channels from lineup');
		if (result.changes > 0) {
			liveTvEvents.emitLineupUpdated();
		}
		return result.changes;
	}

	/**
	 * Update a lineup item
	 */
	async updateChannel(
		id: string,
		update: UpdateChannelRequest
	): Promise<ChannelLineupItemWithDetails | null> {
		const now = new Date().toISOString();

		await db
			.update(channelLineupItems)
			.set({
				channelNumber: update.channelNumber,
				customName: update.customName,
				customLogo: update.customLogo,
				epgId: update.epgId,
				epgSourceChannelId: update.epgSourceChannelId,
				categoryId: update.categoryId,
				updatedAt: now
			})
			.where(eq(channelLineupItems.id, id));

		liveTvEvents.emitLineupUpdated();
		return this.getChannelById(id);
	}

	/**
	 * Reorder lineup items
	 */
	async reorderLineup(itemIds: string[]): Promise<void> {
		const now = new Date().toISOString();

		// Update positions in order
		for (let i = 0; i < itemIds.length; i++) {
			await db
				.update(channelLineupItems)
				.set({ position: i + 1, updatedAt: now })
				.where(eq(channelLineupItems.id, itemIds[i]));
		}

		logger.info({ count: itemIds.length }, '[ChannelLineupService] Reordered lineup');
		liveTvEvents.emitLineupUpdated();
	}

	/**
	 * Set category for multiple lineup items
	 */
	async bulkSetCategory(itemIds: string[], categoryId: string | null): Promise<number> {
		if (itemIds.length === 0) return 0;

		const now = new Date().toISOString();
		const result = await db
			.update(channelLineupItems)
			.set({ categoryId, updatedAt: now })
			.where(inArray(channelLineupItems.id, itemIds));

		if (result.changes > 0) {
			liveTvEvents.emitLineupUpdated();
		}
		return result.changes;
	}

	/**
	 * Apply cleaned names to lineup items that do not already have a custom name
	 */
	async bulkApplyCleanNames(itemIds: string[]): Promise<{
		updated: number;
		skippedExistingCustom: number;
		skippedUnchanged: number;
	}> {
		if (itemIds.length === 0) {
			return {
				updated: 0,
				skippedExistingCustom: 0,
				skippedUnchanged: 0
			};
		}

		const rows = await db
			.select({
				item: channelLineupItems,
				channel: livetvChannels
			})
			.from(channelLineupItems)
			.innerJoin(livetvChannels, eq(channelLineupItems.channelId, livetvChannels.id))
			.where(inArray(channelLineupItems.id, itemIds));

		const now = new Date().toISOString();
		let updated = 0;
		let skippedExistingCustom = 0;
		let skippedUnchanged = 0;

		for (const row of rows) {
			if (row.item.customName?.trim()) {
				skippedExistingCustom++;
				continue;
			}

			const cleanedName = normalizeLiveTvChannelName(
				row.channel.name,
				row.channel.providerType
			).trim();
			const rawName = row.channel.name.trim();

			if (!cleanedName || cleanedName === rawName) {
				skippedUnchanged++;
				continue;
			}

			await db
				.update(channelLineupItems)
				.set({ customName: cleanedName, updatedAt: now })
				.where(eq(channelLineupItems.id, row.item.id));

			updated++;
		}

		if (updated > 0) {
			liveTvEvents.emitLineupUpdated();
		}

		return {
			updated,
			skippedExistingCustom,
			skippedUnchanged
		};
	}

	// =========================================================================
	// BACKUP LINKS
	// =========================================================================

	/**
	 * Get all backup links for a lineup item
	 */
	async getBackups(lineupItemId: string): Promise<ChannelBackupLink[]> {
		const rows = await db
			.select({
				backup: channelLineupBackups,
				channel: livetvChannels,
				accountName: livetvAccounts.name,
				providerType: livetvAccounts.providerType,
				categoryTitle: livetvCategories.title
			})
			.from(channelLineupBackups)
			.innerJoin(livetvChannels, eq(channelLineupBackups.channelId, livetvChannels.id))
			.innerJoin(livetvAccounts, eq(channelLineupBackups.accountId, livetvAccounts.id))
			.leftJoin(livetvCategories, eq(livetvChannels.categoryId, livetvCategories.id))
			.where(eq(channelLineupBackups.lineupItemId, lineupItemId))
			.orderBy(asc(channelLineupBackups.priority));

		return rows.map((row) => ({
			id: row.backup.id,
			lineupItemId: row.backup.lineupItemId,
			accountId: row.backup.accountId,
			channelId: row.backup.channelId,
			priority: row.backup.priority,
			createdAt: row.backup.createdAt || new Date().toISOString(),
			updatedAt: row.backup.updatedAt || new Date().toISOString(),
			providerType: row.providerType as LiveTvProviderType,
			channel: toChannelResponse(row.channel, row.categoryTitle || null),
			accountName: row.accountName || 'Unknown Account'
		}));
	}

	/**
	 * Add a backup link to a lineup item
	 */
	async addBackup(
		lineupItemId: string,
		accountId: string,
		channelId: string
	): Promise<{ backup: ChannelBackupLink | null; error?: string }> {
		// Get the lineup item to check it exists and that we're not adding primary as backup
		const item = await this.getChannelById(lineupItemId);
		if (!item) {
			logger.warn(
				{
					lineupItemId
				},
				'[ChannelLineupService] Cannot add backup: lineup item not found'
			);
			return { backup: null, error: 'Lineup item not found' };
		}

		// Prevent adding the primary channel as a backup
		if (channelId === item.channelId) {
			logger.warn(
				{
					lineupItemId,
					channelId
				},
				'[ChannelLineupService] Cannot add primary channel as backup'
			);
			return { backup: null, error: 'Cannot add primary channel as backup' };
		}

		// Validate account exists and is enabled
		const account = await db
			.select({ id: livetvAccounts.id, enabled: livetvAccounts.enabled })
			.from(livetvAccounts)
			.where(eq(livetvAccounts.id, accountId))
			.limit(1)
			.then((rows) => rows[0]);

		if (!account) {
			logger.warn(
				{
					lineupItemId,
					accountId
				},
				'[ChannelLineupService] Cannot add backup: account not found'
			);
			return { backup: null, error: 'Account not found' };
		}

		if (!account.enabled) {
			logger.warn(
				{
					lineupItemId,
					accountId
				},
				'[ChannelLineupService] Cannot add backup: account is disabled'
			);
			return { backup: null, error: 'Account is disabled' };
		}

		// Validate channel exists and belongs to the specified account
		const channel = await db
			.select({ id: livetvChannels.id, accountId: livetvChannels.accountId })
			.from(livetvChannels)
			.where(eq(livetvChannels.id, channelId))
			.limit(1)
			.then((rows) => rows[0]);

		if (!channel) {
			logger.warn(
				{
					lineupItemId,
					channelId
				},
				'[ChannelLineupService] Cannot add backup: channel not found'
			);
			return { backup: null, error: 'Channel not found' };
		}

		if (channel.accountId !== accountId) {
			logger.warn(
				{
					lineupItemId,
					channelId,
					expectedAccountId: accountId,
					actualAccountId: channel.accountId
				},
				'[ChannelLineupService] Cannot add backup: channel does not belong to account'
			);
			return { backup: null, error: 'Channel does not belong to specified account' };
		}

		// Get next priority (max + 1)
		const maxPriorityResult = await db
			.select({ maxPriority: sql<number>`COALESCE(MAX(priority), 0)` })
			.from(channelLineupBackups)
			.where(eq(channelLineupBackups.lineupItemId, lineupItemId));
		const nextPriority = (maxPriorityResult[0]?.maxPriority || 0) + 1;

		const now = new Date().toISOString();
		const id = randomUUID();

		try {
			await db.insert(channelLineupBackups).values({
				id,
				lineupItemId,
				accountId,
				channelId,
				priority: nextPriority,
				createdAt: now,
				updatedAt: now
			});

			logger.info(
				{
					lineupItemId,
					channelId,
					priority: nextPriority
				},
				'[ChannelLineupService] Added backup link'
			);

			// Return the newly created backup with joined data
			const backups = await this.getBackups(lineupItemId);
			const backup = backups.find((b) => b.id === id) || null;
			liveTvEvents.emitLineupUpdated();
			return { backup };
		} catch (error) {
			// Unique constraint violation - backup already exists
			if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
				logger.warn(
					{
						lineupItemId,
						channelId
					},
					'[ChannelLineupService] Backup already exists'
				);
				return { backup: null, error: 'Backup already exists' };
			}
			throw error;
		}
	}

	/**
	 * Remove a backup link and renormalize remaining priorities
	 */
	async removeBackup(backupId: string): Promise<boolean> {
		// Get the backup first to know which lineup item it belongs to
		const backup = await db
			.select({ lineupItemId: channelLineupBackups.lineupItemId })
			.from(channelLineupBackups)
			.where(eq(channelLineupBackups.id, backupId))
			.limit(1)
			.then((rows) => rows[0]);

		if (!backup) {
			return false;
		}

		const result = await db
			.delete(channelLineupBackups)
			.where(eq(channelLineupBackups.id, backupId));

		if (result.changes > 0) {
			logger.info({ backupId }, '[ChannelLineupService] Removed backup link');

			// Renormalize priorities for remaining backups
			await this.normalizePriorities(backup.lineupItemId);
			liveTvEvents.emitLineupUpdated();

			return true;
		}
		return false;
	}

	/**
	 * Renormalize backup priorities to be sequential (1, 2, 3...)
	 */
	private async normalizePriorities(lineupItemId: string): Promise<void> {
		const backups = await db
			.select({ id: channelLineupBackups.id })
			.from(channelLineupBackups)
			.where(eq(channelLineupBackups.lineupItemId, lineupItemId))
			.orderBy(asc(channelLineupBackups.priority));

		if (backups.length === 0) return;

		const now = new Date().toISOString();
		for (let i = 0; i < backups.length; i++) {
			await db
				.update(channelLineupBackups)
				.set({ priority: i + 1, updatedAt: now })
				.where(eq(channelLineupBackups.id, backups[i].id));
		}
	}

	/**
	 * Reorder backup links for a lineup item
	 */
	async reorderBackups(lineupItemId: string, backupIds: string[]): Promise<void> {
		const now = new Date().toISOString();

		// Update priorities in order (1-based)
		for (let i = 0; i < backupIds.length; i++) {
			await db
				.update(channelLineupBackups)
				.set({ priority: i + 1, updatedAt: now })
				.where(
					and(
						eq(channelLineupBackups.id, backupIds[i]),
						eq(channelLineupBackups.lineupItemId, lineupItemId)
					)
				);
		}

		logger.info(
			{
				lineupItemId,
				count: backupIds.length
			},
			'[ChannelLineupService] Reordered backups'
		);
		liveTvEvents.emitLineupUpdated();
	}

	/**
	 * Get a lineup item with its backup links
	 */
	async getChannelWithBackups(id: string): Promise<ChannelLineupItemWithBackups | null> {
		const item = await this.getChannelById(id);
		if (!item) return null;

		const backups = await this.getBackups(id);

		return {
			...item,
			backups
		};
	}

	/**
	 * Get backup count for a lineup item
	 */
	async getBackupCount(lineupItemId: string): Promise<number> {
		const result = await db
			.select({ count: sql<number>`count(*)` })
			.from(channelLineupBackups)
			.where(eq(channelLineupBackups.lineupItemId, lineupItemId));
		return result[0]?.count || 0;
	}
}

// Singleton instance
let lineupServiceInstance: ChannelLineupService | null = null;

export function getChannelLineupService(): ChannelLineupService {
	if (!lineupServiceInstance) {
		lineupServiceInstance = new ChannelLineupService();
	}
	return lineupServiceInstance;
}

// Backward compatibility export
export const channelLineupService = getChannelLineupService();
