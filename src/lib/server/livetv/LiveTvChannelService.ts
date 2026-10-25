/**
 * Live TV Channel Service
 *
 * Manages Live TV channels for all provider types.
 * Provides query methods and channel synchronization.
 */

import { eq, and, like, inArray, or, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	livetvAccounts,
	livetvChannels,
	livetvCategories,
	type LivetvChannelRecord
} from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { getProvider } from './providers';
import type { BackgroundService, ServiceStatus } from '#lib/server/services/background-service.js';
import { NotFoundError } from '#lib/errors/index.js';
import type {
	LiveTvChannel,
	LiveTvCategory,
	CachedChannel,
	ChannelQueryOptions,
	PaginatedChannelResponse,
	AccountSyncStatus,
	ChannelSyncResult,
	LiveTvProviderType
} from '#lib/types/livetv.js';

const logger = createChildLogger({ module: 'LiveTvChannelService' });

/**
 * Convert database record to LiveTvChannel type
 */
function recordToChannel(record: LivetvChannelRecord): LiveTvChannel {
	return {
		id: record.id,
		accountId: record.accountId,
		providerType: record.providerType as LiveTvProviderType,
		externalId: record.externalId,
		name: record.name,
		number: record.number,
		logo: record.logo,
		categoryId: record.categoryId,
		providerCategoryId: record.providerCategoryId,
		stalker: record.stalkerData ?? undefined,
		xstream: record.xstreamData ?? undefined,
		m3u: record.m3uData ?? undefined,
		epgId: record.epgId,
		createdAt: record.createdAt ?? new Date().toISOString(),
		updatedAt: record.updatedAt ?? new Date().toISOString(),
		categoryTitle: null
	};
}

/**
 * Convert database record to CachedChannel type
 */
function recordToCachedChannel(
	record: LivetvChannelRecord,
	categoryTitle: string | null,
	accountName: string
): CachedChannel {
	return {
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
		stalker: record.stalkerData ?? undefined,
		xstream: record.xstreamData ?? undefined,
		m3u: record.m3uData ?? undefined,
		createdAt: record.createdAt ?? new Date().toISOString(),
		updatedAt: record.updatedAt ?? new Date().toISOString(),
		accountName
	};
}

export class LiveTvChannelService implements BackgroundService {
	readonly name = 'LiveTvChannelService';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	/**
	 * Start the service (non-blocking)
	 * Implements BackgroundService.start()
	 */
	start(): void {
		if (this._status === 'ready' || this._status === 'starting') {
			logger.debug('LiveTvChannelService already running');
			return;
		}

		this._status = 'starting';
		logger.info('Starting LiveTvChannelService');

		// Service initialization is synchronous for this service
		setImmediate(() => {
			this._status = 'ready';
			logger.info('LiveTvChannelService ready');
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

		logger.info('Stopping LiveTvChannelService');
		this._status = 'pending';
		logger.info('LiveTvChannelService stopped');
	}

	/**
	 * Get channels with optional filtering
	 */
	async getChannels(options: ChannelQueryOptions = {}): Promise<PaginatedChannelResponse> {
		const {
			accountIds,
			categoryIds,
			providerTypes,
			search,
			page = 1,
			pageSize = 50,
			sortBy = 'name',
			sortOrder = 'asc'
		} = options;

		// Build query conditions
		const conditions = [];
		if (accountIds && accountIds.length > 0) {
			conditions.push(inArray(livetvChannels.accountId, accountIds));
		}
		if (categoryIds && categoryIds.length > 0) {
			// Primary filter by mapped categoryId, with fallback to providerCategoryId for
			// legacy rows that may not have categoryId populated yet.
			const selectedCategories = await db
				.select({
					accountId: livetvCategories.accountId,
					externalId: livetvCategories.externalId
				})
				.from(livetvCategories)
				.where(inArray(livetvCategories.id, categoryIds));

			const fallbackByAccount = new Map<string, Set<string>>();
			for (const category of selectedCategories) {
				if (!category.externalId) continue;
				if (!fallbackByAccount.has(category.accountId)) {
					fallbackByAccount.set(category.accountId, new Set());
				}
				fallbackByAccount.get(category.accountId)!.add(category.externalId);
			}

			const fallbackConditions = [];
			for (const [accountId, externalIds] of fallbackByAccount.entries()) {
				const values = Array.from(externalIds).filter(Boolean);
				if (values.length === 0) continue;
				fallbackConditions.push(
					and(
						eq(livetvChannels.accountId, accountId),
						inArray(livetvChannels.providerCategoryId, values)
					)
				);
			}

			if (fallbackConditions.length > 0) {
				conditions.push(or(inArray(livetvChannels.categoryId, categoryIds), ...fallbackConditions));
			} else {
				conditions.push(inArray(livetvChannels.categoryId, categoryIds));
			}
		}
		if (providerTypes && providerTypes.length > 0) {
			conditions.push(inArray(livetvChannels.providerType, providerTypes));
		}
		if (search) {
			// Sanitize search input to escape SQL LIKE special characters
			const sanitizedSearch = search.replace(/[%_\\]/g, '\\$&');
			conditions.push(like(livetvChannels.name, `%${sanitizedSearch}%`));
		}

		// Get total count with same conditions (using inner join with accounts)
		const countQuery = db
			.select({ count: sql<number>`count(*)` })
			.from(livetvChannels)
			.innerJoin(livetvAccounts, eq(livetvChannels.accountId, livetvAccounts.id))
			.where(conditions.length > 0 ? and(...conditions) : undefined);

		const countResult = await countQuery;
		const total = countResult[0]?.count ?? 0;

		// Build sorting clause
		const orderByClause =
			sortBy === 'number'
				? sortOrder === 'asc'
					? livetvChannels.number
					: sql`${livetvChannels.number} desc`
				: sortOrder === 'asc'
					? livetvChannels.name
					: sql`${livetvChannels.name} desc`;

		// Build and execute query
		const rows = await db
			.select({
				channel: livetvChannels,
				categoryTitle: livetvCategories.title,
				accountName: livetvAccounts.name
			})
			.from(livetvChannels)
			.leftJoin(livetvCategories, eq(livetvChannels.categoryId, livetvCategories.id))
			.innerJoin(livetvAccounts, eq(livetvChannels.accountId, livetvAccounts.id))
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderByClause)
			.limit(pageSize)
			.offset((page - 1) * pageSize);

		return {
			items: rows.map((row) =>
				recordToCachedChannel(row.channel, row.categoryTitle ?? null, row.accountName ?? 'Unknown')
			),
			total,
			page,
			pageSize,
			totalPages: Math.ceil(total / pageSize)
		};
	}

	/**
	 * Get a channel by ID
	 */
	async getChannel(id: string): Promise<LiveTvChannel | null> {
		const records = await db
			.select()
			.from(livetvChannels)
			.where(eq(livetvChannels.id, id))
			.limit(1);

		if (records.length === 0) {
			return null;
		}

		return recordToChannel(records[0]);
	}

	/**
	 * Get cached channels for use in lineup/backups
	 */
	async getCachedChannels(accountIds?: string[]): Promise<CachedChannel[]> {
		let rows: {
			channel: typeof livetvChannels.$inferSelect;
			categoryTitle: string | null;
			accountName: string | null;
		}[];

		if (accountIds && accountIds.length > 0) {
			rows = await db
				.select({
					channel: livetvChannels,
					categoryTitle: livetvCategories.title,
					accountName: livetvAccounts.name
				})
				.from(livetvChannels)
				.leftJoin(livetvCategories, eq(livetvChannels.categoryId, livetvCategories.id))
				.innerJoin(livetvAccounts, eq(livetvChannels.accountId, livetvAccounts.id))
				.where(inArray(livetvChannels.accountId, accountIds));
		} else {
			rows = await db
				.select({
					channel: livetvChannels,
					categoryTitle: livetvCategories.title,
					accountName: livetvAccounts.name
				})
				.from(livetvChannels)
				.leftJoin(livetvCategories, eq(livetvChannels.categoryId, livetvCategories.id))
				.innerJoin(livetvAccounts, eq(livetvChannels.accountId, livetvAccounts.id));
		}

		return rows.map((row) =>
			recordToCachedChannel(row.channel, row.categoryTitle ?? null, row.accountName ?? 'Unknown')
		);
	}

	/**
	 * Get channels by account ID
	 */
	async getChannelsByAccount(accountId: string): Promise<LiveTvChannel[]> {
		const records = await db
			.select()
			.from(livetvChannels)
			.where(eq(livetvChannels.accountId, accountId));

		return records.map(recordToChannel);
	}

	/**
	 * Get categories
	 */
	async getCategories(accountIds?: string[]): Promise<LiveTvCategory[]> {
		const normalizedAccountIds = accountIds?.filter(Boolean) ?? [];

		const categoryConditions = [];
		if (normalizedAccountIds.length > 0) {
			categoryConditions.push(inArray(livetvCategories.accountId, normalizedAccountIds));
		}

		const records = await db
			.select()
			.from(livetvCategories)
			.where(categoryConditions.length > 0 ? and(...categoryConditions) : undefined);

		if (records.length === 0) {
			return [];
		}

		const mappedCountRows = await db
			.select({
				categoryId: livetvChannels.categoryId,
				count: sql<number>`count(*)`
			})
			.from(livetvChannels)
			.where(
				and(
					normalizedAccountIds.length > 0
						? inArray(livetvChannels.accountId, normalizedAccountIds)
						: sql`1=1`,
					sql`${livetvChannels.categoryId} is not null`
				)
			)
			.groupBy(livetvChannels.categoryId);

		const mappedCounts = new Map<string, number>();
		for (const row of mappedCountRows) {
			if (row.categoryId) {
				mappedCounts.set(row.categoryId, row.count ?? 0);
			}
		}

		const legacyFallbackRows = await db
			.select({
				accountId: livetvChannels.accountId,
				providerCategoryId: livetvChannels.providerCategoryId,
				count: sql<number>`count(*)`
			})
			.from(livetvChannels)
			.where(
				and(
					normalizedAccountIds.length > 0
						? inArray(livetvChannels.accountId, normalizedAccountIds)
						: sql`1=1`,
					sql`${livetvChannels.categoryId} is null`,
					sql`${livetvChannels.providerCategoryId} is not null`
				)
			)
			.groupBy(livetvChannels.accountId, livetvChannels.providerCategoryId);

		const legacyFallbackCounts = new Map<string, number>();
		for (const row of legacyFallbackRows) {
			if (!row.providerCategoryId) continue;
			legacyFallbackCounts.set(`${row.accountId}:${row.providerCategoryId}`, row.count ?? 0);
		}

		return records.map((record) => ({
			id: record.id,
			accountId: record.accountId,
			providerType: record.providerType as LiveTvProviderType,
			externalId: record.externalId,
			title: record.title,
			alias: record.alias,
			censored: record.censored ?? false,
			channelCount:
				mappedCounts.get(record.id) ??
				legacyFallbackCounts.get(`${record.accountId}:${record.externalId}`) ??
				0,
			providerData: record.providerData ?? undefined,
			createdAt: record.createdAt ?? new Date().toISOString(),
			updatedAt: record.updatedAt ?? new Date().toISOString()
		}));
	}

	/**
	 * Get category by ID
	 */
	async getCategory(id: string): Promise<LiveTvCategory | null> {
		const records = await db
			.select()
			.from(livetvCategories)
			.where(eq(livetvCategories.id, id))
			.limit(1);

		if (records.length === 0) {
			return null;
		}

		const record = records[0];
		return {
			id: record.id,
			accountId: record.accountId,
			providerType: record.providerType as LiveTvProviderType,
			externalId: record.externalId,
			title: record.title,
			alias: record.alias,
			censored: record.censored ?? false,
			channelCount: record.channelCount ?? 0,
			providerData: record.providerData ?? undefined,
			createdAt: record.createdAt ?? new Date().toISOString(),
			updatedAt: record.updatedAt ?? new Date().toISOString()
		};
	}

	/**
	 * Get accounts with sync status
	 */
	async getAccountsWithSyncStatus(): Promise<AccountSyncStatus[]> {
		const records = await db.select().from(livetvAccounts);

		return records.map((record) => ({
			id: record.id,
			name: record.name,
			providerType: record.providerType as LiveTvProviderType,
			syncStatus: record.syncStatus ?? 'never',
			lastSyncAt: record.lastSyncAt ?? null,
			lastSyncError: record.lastSyncError ?? null,
			channelCount: record.channelCount ?? null,
			categoryCount: record.categoryCount ?? null
		}));
	}

	/**
	 * Search channels
	 */
	async searchChannels(query: string, limit = 20): Promise<CachedChannel[]> {
		const rows = await db
			.select({
				channel: livetvChannels,
				categoryTitle: livetvCategories.title,
				accountName: livetvAccounts.name
			})
			.from(livetvChannels)
			.leftJoin(livetvCategories, eq(livetvChannels.categoryId, livetvCategories.id))
			.innerJoin(livetvAccounts, eq(livetvChannels.accountId, livetvAccounts.id))
			.where(like(livetvChannels.name, `%${query}%`))
			.limit(limit);

		return rows.map((row) =>
			recordToCachedChannel(row.channel, row.categoryTitle ?? null, row.accountName ?? 'Unknown')
		);
	}

	/**
	 * Sync channels for an account
	 */
	async syncChannels(accountId: string): Promise<ChannelSyncResult> {
		const account = await db
			.select()
			.from(livetvAccounts)
			.where(eq(livetvAccounts.id, accountId))
			.limit(1)
			.then((rows) => rows[0]);

		if (!account) {
			throw new NotFoundError('Account', accountId);
		}

		const provider = getProvider(account.providerType as LiveTvProviderType);
		return provider.syncChannels(accountId);
	}

	/**
	 * Get sync status for all accounts
	 */
	async getSyncStatus(): Promise<AccountSyncStatus[]> {
		const records = await db.select().from(livetvAccounts);

		return records.map((record) => ({
			id: record.id,
			name: record.name,
			providerType: record.providerType as LiveTvProviderType,
			syncStatus: record.syncStatus ?? 'never',
			lastSyncAt: record.lastSyncAt ?? null,
			lastSyncError: record.lastSyncError ?? null,
			channelCount: record.channelCount ?? null,
			categoryCount: record.categoryCount ?? null
		}));
	}
}

// Singleton instance
let channelServiceInstance: LiveTvChannelService | null = null;

export function getLiveTvChannelService(): LiveTvChannelService {
	if (!channelServiceInstance) {
		channelServiceInstance = new LiveTvChannelService();
	}
	return channelServiceInstance;
}
