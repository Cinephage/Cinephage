/**
 * Smart List Service
 *
 * Core service for managing TMDB-based smart lists.
 * Handles CRUD operations, refresh logic, and library integration.
 */

import { db } from '#lib/server/db/index.js';
import {
	smartLists,
	smartListItems,
	smartListRefreshHistory,
	movies,
	series,
	seasons,
	episodes,
	type SmartListFilters,
	type SmartListRecord,
	type SmartListItemRecord
} from '#lib/server/db/schema.js';
import { eq, and, desc, asc, sql, lt, inArray } from 'drizzle-orm';
import { tmdb, type DiscoverParams, type DiscoverItem } from '#lib/server/tmdb.js';
import { createChildLogger } from '#lib/logging/index.js';
import { todayDateString } from '#lib/utils/format.js';

const logger = createChildLogger({ logDomain: 'monitoring' as const });
import { ValidationError } from '#lib/errors/index.js';
import {
	validateRootFolder,
	getEffectiveScoringProfileId,
	fetchMovieDetails,
	fetchMovieExternalIds,
	fetchSeriesDetails,
	fetchSeriesExternalIds,
	triggerMovieSearch,
	triggerSeriesSearch
} from '#lib/server/library/LibraryAddService.js';
import { NamingService, type MediaNamingInfo } from '#lib/server/library/naming/NamingService.js';
import { namingSettingsService } from '#lib/server/library/naming/NamingSettingsService.js';
import { resolveLocalizedTitlesForFormats } from '#lib/server/library/naming/localization.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { getBlockedTmdbIdSet } from '#lib/server/library/status.js';
import type {
	CreateSmartListInput,
	UpdateSmartListInput,
	RefreshResult,
	ItemQueryOptions,
	BulkAddResult
} from './types.js';
import { providerRegistry } from './providers/ProviderRegistry.js';
import { externalIdResolver } from './ExternalIdResolver.js';
import { presetService } from './presets/PresetService.js';
import type { ExternalListItem } from './providers/types.js';

type SmartListExternalSourceConfig = {
	url?: string;
	headers?: Record<string, string>;
	listId?: string;
	username?: string;
};

export class SmartListService {
	private static instance: SmartListService | null = null;

	private constructor() {}

	static getInstance(): SmartListService {
		if (!SmartListService.instance) {
			SmartListService.instance = new SmartListService();
		}
		return SmartListService.instance;
	}

	// =========================================================================
	// CRUD Operations
	// =========================================================================

	async createSmartList(input: CreateSmartListInput): Promise<SmartListRecord> {
		const now = new Date().toISOString();
		const nextRefresh = new Date(
			Date.now() + (input.refreshIntervalHours ?? 24) * 60 * 60 * 1000
		).toISOString();

		const listSourceType = input.listSourceType ?? 'tmdb-discover';
		const externalSourceConfig = this.resolveExternalSourceConfig({
			listSourceType,
			presetId: input.presetId,
			inputConfig: input.externalSourceConfig as SmartListExternalSourceConfig | undefined
		});

		this.validateExternalSourceConfiguration({
			listSourceType,
			presetId: input.presetId,
			presetSettings: input.presetSettings,
			externalSourceConfig
		});

		const [result] = await db
			.insert(smartLists)
			.values({
				name: input.name,
				description: input.description,
				mediaType: input.mediaType,
				filters: input.filters,
				sortBy: input.sortBy ?? 'popularity.desc',
				itemLimit: input.itemLimit ?? 100,
				excludeInLibrary: input.excludeInLibrary ?? true,
				showUpgradeableOnly: input.showUpgradeableOnly ?? false,
				excludedTmdbIds: input.excludedTmdbIds ?? [],
				scoringProfileId: input.scoringProfileId,
				autoAddBehavior: input.autoAddBehavior ?? 'disabled',
				rootFolderId: input.rootFolderId,
				autoAddMonitored: input.autoAddMonitored ?? true,
				minimumAvailability: input.minimumAvailability ?? 'released',
				wantsSubtitles: input.wantsSubtitles ?? true,
				languageProfileId: input.languageProfileId,
				refreshIntervalHours: input.refreshIntervalHours ?? 24,
				enabled: input.enabled ?? true,
				listSourceType,
				externalSourceConfig,
				presetId: input.presetId,
				presetProvider: input.presetProvider,
				presetSettings: input.presetSettings,
				nextRefreshTime: nextRefresh,
				createdAt: now,
				updatedAt: now
			})
			.returning();

		logger.info({ id: result.id, name: result.name }, '[SmartListService] Created smart list');

		// Trigger initial refresh in the background so create/edit UX does not block on provider/network latency.
		void this.refreshSmartList(result.id, 'manual').catch((error) => {
			logger.error({ err: error, id: result.id }, '[SmartListService] Initial refresh failed');
		});

		return result;
	}

	async updateSmartList(id: string, input: UpdateSmartListInput): Promise<SmartListRecord | null> {
		const existing = await this.getSmartList(id);
		if (!existing) return null;

		const updates: Partial<SmartListRecord> = {
			updatedAt: new Date().toISOString()
		};

		if (input.name !== undefined) updates.name = input.name;
		if (input.description !== undefined) updates.description = input.description;
		if (input.filters !== undefined) updates.filters = input.filters;
		if (input.sortBy !== undefined) updates.sortBy = input.sortBy;
		if (input.itemLimit !== undefined) updates.itemLimit = input.itemLimit;
		if (input.excludeInLibrary !== undefined) updates.excludeInLibrary = input.excludeInLibrary;
		if (input.showUpgradeableOnly !== undefined)
			updates.showUpgradeableOnly = input.showUpgradeableOnly;
		if (input.excludedTmdbIds !== undefined) updates.excludedTmdbIds = input.excludedTmdbIds;
		if (input.scoringProfileId !== undefined) updates.scoringProfileId = input.scoringProfileId;
		if (input.autoAddBehavior !== undefined) updates.autoAddBehavior = input.autoAddBehavior;
		if (input.rootFolderId !== undefined) updates.rootFolderId = input.rootFolderId;
		if (input.autoAddMonitored !== undefined) updates.autoAddMonitored = input.autoAddMonitored;
		if (input.minimumAvailability !== undefined)
			updates.minimumAvailability = input.minimumAvailability;
		if (input.wantsSubtitles !== undefined) updates.wantsSubtitles = input.wantsSubtitles;
		if (input.languageProfileId !== undefined) updates.languageProfileId = input.languageProfileId;
		if (input.refreshIntervalHours !== undefined) {
			updates.refreshIntervalHours = input.refreshIntervalHours;
			// Recalculate next refresh time
			updates.nextRefreshTime = new Date(
				Date.now() + input.refreshIntervalHours * 60 * 60 * 1000
			).toISOString();
		}
		if (input.enabled !== undefined) updates.enabled = input.enabled;
		if (input.listSourceType !== undefined) updates.listSourceType = input.listSourceType;
		if (input.presetId !== undefined) updates.presetId = input.presetId;
		if (input.presetProvider !== undefined) updates.presetProvider = input.presetProvider;
		if (input.presetSettings !== undefined) updates.presetSettings = input.presetSettings;

		if (input.externalSourceConfig !== undefined) {
			updates.externalSourceConfig = this.resolveExternalSourceConfig({
				listSourceType: (input.listSourceType ?? existing.listSourceType) as string,
				presetId: input.presetId ?? existing.presetId ?? undefined,
				inputConfig: input.externalSourceConfig as SmartListExternalSourceConfig | undefined
			});
		} else if (input.presetId !== undefined && existing.listSourceType === 'external-json') {
			const resolved = this.resolveExternalSourceConfig({
				listSourceType: existing.listSourceType as string,
				presetId: input.presetId,
				inputConfig: existing.externalSourceConfig as SmartListExternalSourceConfig | undefined,
				fallbackToInput: false
			});
			if (resolved) {
				updates.externalSourceConfig = resolved;
			}
		}

		this.validateExternalSourceConfiguration({
			listSourceType: (updates.listSourceType ?? existing.listSourceType) as string,
			presetId: updates.presetId ?? existing.presetId ?? undefined,
			presetSettings:
				((updates.presetSettings ?? existing.presetSettings) as
					Record<string, unknown> | undefined) ?? undefined,
			externalSourceConfig:
				((updates.externalSourceConfig ?? existing.externalSourceConfig) as
					SmartListExternalSourceConfig | undefined) ?? undefined
		});

		const [result] = await db
			.update(smartLists)
			.set(updates)
			.where(eq(smartLists.id, id))
			.returning();

		logger.info({ id, updates: Object.keys(input) }, '[SmartListService] Updated smart list');

		return result;
	}

	async deleteSmartList(id: string): Promise<boolean> {
		const result = await db.delete(smartLists).where(eq(smartLists.id, id));
		logger.info({ id }, '[SmartListService] Deleted smart list');
		return result.changes > 0;
	}

	async getSmartList(id: string): Promise<SmartListRecord | null> {
		const result = await db.query.smartLists.findFirst({
			where: eq(smartLists.id, id)
		});
		return result ?? null;
	}

	async getAllSmartLists(): Promise<SmartListRecord[]> {
		return db.query.smartLists.findMany({
			orderBy: [desc(smartLists.createdAt)]
		});
	}

	async getEnabledSmartLists(): Promise<SmartListRecord[]> {
		return db.query.smartLists.findMany({
			where: eq(smartLists.enabled, true),
			orderBy: [desc(smartLists.createdAt)]
		});
	}

	private resolveExternalSourceConfig(params: {
		listSourceType: string;
		presetId?: string;
		inputConfig?: SmartListExternalSourceConfig;
		fallbackToInput?: boolean;
	}): SmartListExternalSourceConfig | undefined {
		const { listSourceType, presetId, inputConfig, fallbackToInput = true } = params;

		if (listSourceType === 'external-json' && presetId) {
			const presetUrl = presetService.getListUrl(presetId, inputConfig?.url);
			if (presetUrl) {
				return {
					url: presetUrl,
					headers: inputConfig?.headers,
					listId: inputConfig?.listId,
					username: inputConfig?.username
				};
			}
		}

		if (fallbackToInput && inputConfig) {
			return {
				url: inputConfig.url,
				headers: inputConfig.headers,
				listId: inputConfig.listId,
				username: inputConfig.username
			};
		}

		return undefined;
	}

	private validateExternalSourceConfiguration({
		listSourceType,
		presetId,
		presetSettings,
		externalSourceConfig
	}: {
		listSourceType: string;
		presetId?: string;
		presetSettings?: Record<string, unknown>;
		externalSourceConfig?: SmartListExternalSourceConfig;
	}): void {
		if (listSourceType !== 'external-json') {
			return;
		}

		let providerType = 'external-json';
		let providerConfig: Record<string, unknown> = { ...(externalSourceConfig ?? {}) };

		if (presetId) {
			const preset = presetService.getPreset(presetId);
			if (!preset) {
				throw new ValidationError('Selected external list preset was not found', { presetId });
			}

			providerType = preset.provider;
			providerConfig = {
				...(preset.config ?? {}),
				...providerConfig,
				...(presetSettings ?? {})
			};

			if (preset.url) {
				providerConfig.url = preset.url;
			}
		}

		if (providerType === 'external-json') {
			const rawUrl = typeof providerConfig.url === 'string' ? providerConfig.url.trim() : '';
			if (!rawUrl) {
				throw new ValidationError('JSON URL is required for custom external lists');
			}

			try {
				new URL(rawUrl);
			} catch {
				throw new ValidationError('JSON URL must be a valid URL', { url: rawUrl });
			}

			providerConfig.url = rawUrl;
		}

		if (providerType === 'imdb-list') {
			const listId = typeof providerConfig.listId === 'string' ? providerConfig.listId.trim() : '';
			if (!listId) {
				throw new ValidationError('IMDb list ID is required');
			}
		}

		if (providerType === 'tmdb-list') {
			const listId = typeof providerConfig.listId === 'string' ? providerConfig.listId.trim() : '';
			if (!listId) {
				throw new ValidationError('TMDb list ID is required');
			}
		}

		const provider = providerRegistry.get(providerType);
		if (!provider) {
			throw new ValidationError(`External provider '${providerType}' is not available`, {
				providerType
			});
		}

		if (!provider.validateConfig(providerConfig)) {
			if (providerType === 'imdb-list') {
				throw new ValidationError(
					"IMDb list ID must look like 'ls060044601' (or an IMDb list URL containing it)"
				);
			}

			if (providerType === 'tmdb-list') {
				throw new ValidationError(
					"TMDb list ID must be a numeric ID, slug (e.g. '12345-my-list'), or a TMDb list URL"
				);
			}

			throw new ValidationError(`Invalid configuration for external provider '${providerType}'`, {
				providerType
			});
		}
	}

	// =========================================================================
	// Refresh Operations
	// =========================================================================

	async refreshSmartList(id: string, refreshType: 'automatic' | 'manual'): Promise<RefreshResult> {
		const list = await this.getSmartList(id);

		if (!list) {
			throw new Error(`Smart list not found: ${id}`);
		}

		// Route to appropriate refresh method based on source type
		if (list.listSourceType === 'tmdb-discover') {
			return this.refreshTmdbDiscoverList(list, refreshType);
		} else if (list.listSourceType === 'external-json') {
			return this.syncExternalList(list, refreshType);
		}

		throw new Error(`Unsupported list source type: ${list.listSourceType}`);
	}

	/**
	 * Refresh a TMDB Discover-based list
	 */
	private async refreshTmdbDiscoverList(
		list: SmartListRecord,
		refreshType: 'automatic' | 'manual'
	): Promise<RefreshResult> {
		const startTime = Date.now();
		const id = list.id;

		// Create history entry
		const [historyEntry] = await db
			.insert(smartListRefreshHistory)
			.values({
				smartListId: id,
				refreshType,
				status: 'running',
				startedAt: new Date().toISOString()
			})
			.returning();

		try {
			// Build discover params from filters
			const params = await this.buildDiscoverParams(list.filters, list.sortBy ?? 'popularity.desc');

			// Fetch from TMDB (paginated to get itemLimit items)
			const items = await this.fetchDiscoverItems(
				list.mediaType as 'movie' | 'tv',
				params,
				list.itemLimit
			);

			// Get existing items for this list
			const existingItems = await db.query.smartListItems.findMany({
				where: eq(smartListItems.smartListId, id)
			});
			const existingTmdbIds = new Set(existingItems.map((item) => item.tmdbId));

			// Process items
			let itemsNew = 0;
			let itemsRemoved = 0;
			const newTmdbIds = new Set(items.map((item) => item.id));

			// Add new items
			const itemsToInsert: Array<typeof smartListItems.$inferInsert> = [];
			const now = new Date().toISOString();

			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (!existingTmdbIds.has(item.id)) {
					itemsNew++;
					const title = list.mediaType === 'movie' ? item.title : item.name;
					const releaseDate = list.mediaType === 'movie' ? item.release_date : item.first_air_date;
					const year = releaseDate ? parseInt(releaseDate.substring(0, 4), 10) : undefined;

					itemsToInsert.push({
						smartListId: id,
						mediaType: list.mediaType as 'movie' | 'tv',
						tmdbId: item.id,
						title: title ?? 'Unknown',
						originalTitle: list.mediaType === 'movie' ? item.original_title : item.original_name,
						overview: item.overview,
						posterPath: item.poster_path,
						backdropPath: item.backdrop_path,
						releaseDate,
						year,
						voteAverage: String(item.vote_average),
						voteCount: item.vote_count,
						popularity: String(item.popularity),
						genreIds: item.genre_ids,
						originalLanguage: item.original_language,
						position: i,
						firstSeenAt: now,
						lastSeenAt: now,
						updatedAt: now
					});
				}
			}

			// Insert new items in batches
			if (itemsToInsert.length > 0) {
				const batchSize = 50;
				for (let i = 0; i < itemsToInsert.length; i += batchSize) {
					const batch = itemsToInsert.slice(i, i + batchSize);
					await db.insert(smartListItems).values(batch);
				}
			}

			// Update positions for existing items
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (existingTmdbIds.has(item.id)) {
					await db
						.update(smartListItems)
						.set({
							position: i,
							lastSeenAt: now,
							updatedAt: now
						})
						.where(and(eq(smartListItems.smartListId, id), eq(smartListItems.tmdbId, item.id)));
				}
			}

			// Mark items not in new results as removed (but don't delete them)
			for (const existing of existingItems) {
				if (!newTmdbIds.has(existing.tmdbId)) {
					itemsRemoved++;
					// We keep the items but they won't appear in position-based queries
					await db
						.update(smartListItems)
						.set({
							position: 9999, // Push to end
							updatedAt: now
						})
						.where(eq(smartListItems.id, existing.id));
				}
			}

			// Update library status for all items
			await this.updateLibraryStatus(id, list.mediaType as 'movie' | 'tv');

			// Handle auto-add if enabled
			let itemsAutoAdded = 0;
			if (list.autoAddBehavior !== 'disabled' && list.rootFolderId) {
				const result = await this.autoAddItems(list);
				itemsAutoAdded = result.added;
			}

			// Update list stats
			const finalItemCount = await db
				.select({ count: sql<number>`count(*)` })
				.from(smartListItems)
				.where(and(eq(smartListItems.smartListId, id), lt(smartListItems.position, 9999)));

			const inLibraryCount = await db
				.select({ count: sql<number>`count(*)` })
				.from(smartListItems)
				.where(and(eq(smartListItems.smartListId, id), eq(smartListItems.inLibrary, true)));

			const completedAt = new Date().toISOString();
			const durationMs = Date.now() - startTime;

			await db
				.update(smartLists)
				.set({
					lastRefreshTime: completedAt,
					lastRefreshStatus: 'success',
					lastRefreshError: null,
					nextRefreshTime: new Date(
						Date.now() + list.refreshIntervalHours * 60 * 60 * 1000
					).toISOString(),
					cachedItemCount: finalItemCount[0]?.count ?? 0,
					itemsInLibrary: inLibraryCount[0]?.count ?? 0,
					itemsAutoAdded: (list.itemsAutoAdded ?? 0) + itemsAutoAdded,
					updatedAt: completedAt
				})
				.where(eq(smartLists.id, id));

			// Update history
			await db
				.update(smartListRefreshHistory)
				.set({
					status: 'success',
					itemsFound: items.length,
					itemsNew,
					itemsRemoved,
					itemsAutoAdded,
					completedAt,
					durationMs
				})
				.where(eq(smartListRefreshHistory.id, historyEntry.id));

			logger.info(
				{
					id,
					itemsFound: items.length,
					itemsNew,
					itemsRemoved,
					itemsAutoAdded,
					durationMs
				},
				'[SmartListService] Refresh completed'
			);

			return {
				smartListId: id,
				status: 'success',
				itemsFound: items.length,
				itemsNew,
				itemsRemoved,
				itemsAutoAdded,
				itemsFailed: 0,
				durationMs
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const durationMs = Date.now() - startTime;

			await db
				.update(smartLists)
				.set({
					lastRefreshStatus: 'failed',
					lastRefreshError: errorMessage,
					updatedAt: new Date().toISOString()
				})
				.where(eq(smartLists.id, id));

			await db
				.update(smartListRefreshHistory)
				.set({
					status: 'failed',
					errorMessage,
					completedAt: new Date().toISOString(),
					durationMs
				})
				.where(eq(smartListRefreshHistory.id, historyEntry.id));

			logger.error({ err: error, ...{ id } }, '[SmartListService] Refresh failed');

			return {
				smartListId: id,
				status: 'failed',
				itemsFound: 0,
				itemsNew: 0,
				itemsRemoved: 0,
				itemsAutoAdded: 0,
				itemsFailed: 0,
				durationMs,
				errorMessage
			};
		}
	}

	async refreshAllDueLists(): Promise<RefreshResult[]> {
		const now = new Date().toISOString();
		const dueLists = await db.query.smartLists.findMany({
			where: and(eq(smartLists.enabled, true), sql`${smartLists.nextRefreshTime} <= ${now}`)
		});

		logger.info({ count: dueLists.length }, '[SmartListService] Refreshing due lists');

		const results: RefreshResult[] = [];
		for (const list of dueLists) {
			try {
				const result = await this.refreshSmartList(list.id, 'automatic');
				results.push(result);
			} catch (error) {
				logger.error(
					{ err: error, ...{ listId: list.id } },
					'[SmartListService] Failed to refresh list'
				);
			}
		}

		return results;
	}

	// =========================================================================
	// Item Operations
	// =========================================================================

	async getSmartListItems(
		id: string,
		options: ItemQueryOptions = {}
	): Promise<{
		items: SmartListItemRecord[];
		page: number;
		totalPages: number;
		totalItems: number;
	}> {
		const {
			page = 1,
			limit = 50,
			inLibrary,
			isExcluded = false,
			includeExcluded = false,
			query
		} = options;
		const offset = (page - 1) * limit;

		const conditions = [eq(smartListItems.smartListId, id)];

		if (!includeExcluded) {
			conditions.push(eq(smartListItems.isExcluded, isExcluded));
		}

		if (inLibrary === true) {
			conditions.push(eq(smartListItems.inLibrary, true));
		} else if (inLibrary === false) {
			conditions.push(eq(smartListItems.inLibrary, false));
		}

		const trimmedQuery = query?.trim();
		if (trimmedQuery) {
			const pattern = `%${trimmedQuery}%`;
			conditions.push(
				sql`(${smartListItems.title} LIKE ${pattern} OR ${smartListItems.originalTitle} LIKE ${pattern})`
			);
		}

		const whereCondition = and(...conditions);

		const [items, countResult] = await Promise.all([
			db.query.smartListItems.findMany({
				where: whereCondition,
				orderBy: [asc(smartListItems.position)],
				limit,
				offset
			}),
			db
				.select({ count: sql<number>`count(*)` })
				.from(smartListItems)
				.where(whereCondition)
		]);

		const totalItems = countResult[0]?.count ?? 0;
		const totalPages = Math.ceil(totalItems / limit);

		return {
			items,
			page,
			totalPages,
			totalItems
		};
	}

	async excludeItem(smartListId: string, tmdbId: number): Promise<void> {
		await db
			.update(smartListItems)
			.set({
				isExcluded: true,
				excludedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			})
			.where(and(eq(smartListItems.smartListId, smartListId), eq(smartListItems.tmdbId, tmdbId)));

		// Also add to list's excludedTmdbIds
		const list = await this.getSmartList(smartListId);
		if (list) {
			const excluded = list.excludedTmdbIds ?? [];
			if (!excluded.includes(tmdbId)) {
				await db
					.update(smartLists)
					.set({
						excludedTmdbIds: [...excluded, tmdbId],
						updatedAt: new Date().toISOString()
					})
					.where(eq(smartLists.id, smartListId));
			}
		}
	}

	async includeItem(smartListId: string, tmdbId: number): Promise<void> {
		await db
			.update(smartListItems)
			.set({
				isExcluded: false,
				excludedAt: null,
				updatedAt: new Date().toISOString()
			})
			.where(and(eq(smartListItems.smartListId, smartListId), eq(smartListItems.tmdbId, tmdbId)));

		// Remove from list's excludedTmdbIds
		const list = await this.getSmartList(smartListId);
		if (list) {
			const excluded = (list.excludedTmdbIds ?? []).filter((id) => id !== tmdbId);
			await db
				.update(smartLists)
				.set({
					excludedTmdbIds: excluded,
					updatedAt: new Date().toISOString()
				})
				.where(eq(smartLists.id, smartListId));
		}
	}

	async addItemToLibrary(
		smartListId: string,
		itemId: string,
		_searchOnAdd = false
	): Promise<{ success: boolean; error?: string }> {
		const item = await db.query.smartListItems.findFirst({
			where: and(eq(smartListItems.id, itemId), eq(smartListItems.smartListId, smartListId))
		});

		if (!item) {
			return { success: false, error: 'Item not found' };
		}

		if (item.inLibrary) {
			return { success: false, error: 'Item already in library' };
		}

		const blockedIds = await getBlockedTmdbIdSet((item.mediaType as 'movie' | 'tv') ?? 'all');
		if (blockedIds.has(item.tmdbId)) {
			return { success: false, error: 'Media is blocked' };
		}

		const list = await this.getSmartList(smartListId);
		if (!list) {
			return { success: false, error: 'Smart list not found' };
		}

		try {
			if (!list.rootFolderId) {
				return { success: false, error: 'Smart list root folder is not configured' };
			}

			const monitored = list.autoAddMonitored ?? true;
			const wantsSubtitles = list.wantsSubtitles ?? true;
			const shouldSearch = _searchOnAdd && monitored;
			const owningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
				list.rootFolderId,
				item.mediaType === 'movie' ? 'movie' : 'tv'
			);
			const scoringProfileId = await getEffectiveScoringProfileId(
				list.scoringProfileId ?? undefined,
				owningLibrary
			);

			if (item.mediaType === 'movie') {
				await validateRootFolder(list.rootFolderId, 'movie');

				// Check if movie already exists
				const existing = await db.query.movies.findFirst({
					where: eq(movies.tmdbId, item.tmdbId)
				});

				if (existing) {
					await db
						.update(smartListItems)
						.set({
							inLibrary: true,
							movieId: existing.id,
							seriesId: null,
							wasAutoAdded: false,
							autoAddedAt: null,
							updatedAt: new Date().toISOString()
						})
						.where(eq(smartListItems.id, itemId));
					return { success: true };
				}

				// Fetch movie details from TMDB
				await validateRootFolder(list.rootFolderId, 'movie', { requireWritable: true });
				const movieDetails = await fetchMovieDetails(item.tmdbId);
				const year = movieDetails.release_date
					? new Date(movieDetails.release_date).getFullYear()
					: undefined;

				const { imdbId } = await fetchMovieExternalIds(item.tmdbId);

				const localizedTitles = await resolveLocalizedTitlesForFormats('movie', item.tmdbId);
				const config = namingSettingsService.getConfigSync();
				const namingService = new NamingService(config);
				const folderName = namingService.generateMovieFolderName({
					title: movieDetails.title,
					originalTitle: movieDetails.original_title,
					year,
					tmdbId: item.tmdbId,
					imdbId,
					collectionName: movieDetails.belongs_to_collection?.name ?? undefined,
					localizedTitles
				} as MediaNamingInfo);

				// Honor the list's language profile; otherwise inherit (NULL) — the
				// instance default is resolved at read time, never stamped here.
				const languageProfileId = wantsSubtitles ? (list.languageProfileId ?? null) : null;
				const owningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
					list.rootFolderId,
					'movie'
				);

				const [insertedMovie] = await db
					.insert(movies)
					.values({
						tmdbId: item.tmdbId,
						imdbId,
						title: movieDetails.title,
						originalLanguage: movieDetails.original_language,
						originalTitle: movieDetails.original_title,
						year,
						overview: movieDetails.overview,
						posterPath: movieDetails.poster_path,
						backdropPath: movieDetails.backdrop_path,
						runtime: movieDetails.runtime,
						genres: movieDetails.genres?.map((g) => g.name) ?? [],
						path: folderName,
						libraryId: owningLibrary.id,
						rootFolderId: list.rootFolderId,
						scoringProfileId,
						monitored,
						minimumAvailability: list.minimumAvailability ?? 'released',
						hasFile: false,
						wantsSubtitles,
						languageProfileId
					})
					.onConflictDoNothing()
					.returning();
				const newMovie =
					insertedMovie ??
					(await db
						.select()
						.from(movies)
						.where(eq(movies.tmdbId, item.tmdbId))
						.then((rows) => rows[0]));

				await db
					.update(smartListItems)
					.set({
						inLibrary: true,
						movieId: newMovie.id,
						seriesId: null,
						wasAutoAdded: false,
						autoAddedAt: null,
						updatedAt: new Date().toISOString()
					})
					.where(eq(smartListItems.id, itemId));

				if (shouldSearch) {
					await triggerMovieSearch({
						movieId: newMovie.id,
						tmdbId: item.tmdbId,
						imdbId,
						title: movieDetails.title,
						year,
						scoringProfileId
					});
				}

				return { success: true };
			} else {
				await validateRootFolder(list.rootFolderId, 'tv');

				const existing = await db.query.series.findFirst({
					where: eq(series.tmdbId, item.tmdbId)
				});

				if (existing) {
					await db
						.update(smartListItems)
						.set({
							inLibrary: true,
							movieId: null,
							seriesId: existing.id,
							wasAutoAdded: false,
							autoAddedAt: null,
							updatedAt: new Date().toISOString()
						})
						.where(eq(smartListItems.id, itemId));
					return { success: true };
				}

				// Fetch series details from TMDB
				await validateRootFolder(list.rootFolderId, 'tv', { requireWritable: true });
				const seriesDetails = await fetchSeriesDetails(item.tmdbId);
				const year = seriesDetails.first_air_date
					? new Date(seriesDetails.first_air_date).getFullYear()
					: undefined;

				const { tvdbId, imdbId } = await fetchSeriesExternalIds(item.tmdbId);

				const localizedTitles = await resolveLocalizedTitlesForFormats('series', item.tmdbId);
				const config = namingSettingsService.getConfigSync();
				const namingService = new NamingService(config);
				const folderName = namingService.generateSeriesFolderName({
					title: seriesDetails.name,
					originalTitle: seriesDetails.original_name,
					year,
					tvdbId,
					tmdbId: item.tmdbId,
					imdbId,
					localizedTitles
				} as MediaNamingInfo);

				// Honor the list's language profile; otherwise inherit (NULL) — the
				// instance default is resolved at read time, never stamped here.
				const languageProfileId = wantsSubtitles ? (list.languageProfileId ?? null) : null;
				const owningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
					list.rootFolderId,
					'tv'
				);

				const [insertedSeries] = await db
					.insert(series)
					.values({
						tmdbId: item.tmdbId,
						tvdbId,
						imdbId,
						title: seriesDetails.name,
						originalLanguage: seriesDetails.original_language,
						originalTitle: seriesDetails.original_name,
						year,
						overview: seriesDetails.overview,
						posterPath: seriesDetails.poster_path,
						backdropPath: seriesDetails.backdrop_path,
						status: seriesDetails.status,
						network:
							seriesDetails.networks && seriesDetails.networks.length > 0
								? seriesDetails.networks[0].name
								: null,
						genres: seriesDetails.genres?.map((g) => g.name) ?? [],
						path: folderName,
						libraryId: owningLibrary.id,
						rootFolderId: list.rootFolderId,
						scoringProfileId,
						monitored,
						seasonFolder: true,
						seriesType: 'standard',
						monitorNewItems: 'all',
						monitorSpecials: false,
						episodeCount: 0,
						episodeFileCount: 0,
						wantsSubtitles,
						languageProfileId
					})
					.onConflictDoNothing()
					.returning();
				const newSeries =
					insertedSeries ??
					(await db
						.select()
						.from(series)
						.where(eq(series.tmdbId, item.tmdbId))
						.then((rows) => rows[0]));

				await this.createSeasonsAndEpisodes(newSeries.id, item.tmdbId, monitored);

				await db
					.update(smartListItems)
					.set({
						inLibrary: true,
						movieId: null,
						seriesId: newSeries.id,
						wasAutoAdded: false,
						autoAddedAt: null,
						updatedAt: new Date().toISOString()
					})
					.where(eq(smartListItems.id, itemId));

				if (shouldSearch) {
					await triggerSeriesSearch({
						seriesId: newSeries.id,
						tmdbId: item.tmdbId,
						title: seriesDetails.name
					});
				}

				return { success: true };
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return { success: false, error: errorMessage };
		}
	}

	async bulkAddToLibrary(smartListId: string, itemIds: string[]): Promise<BulkAddResult> {
		const result: BulkAddResult = {
			added: 0,
			failed: 0,
			alreadyInLibrary: 0,
			errors: []
		};

		for (const itemId of itemIds) {
			const addResult = await this.addItemToLibrary(smartListId, itemId);
			if (addResult.success) {
				result.added++;
			} else if (addResult.error === 'Item already in library') {
				result.alreadyInLibrary++;
			} else {
				result.failed++;
				const item = await db.query.smartListItems.findFirst({
					where: eq(smartListItems.id, itemId)
				});
				if (item) {
					result.errors.push({
						tmdbId: item.tmdbId,
						title: item.title,
						error: addResult.error ?? 'Unknown error'
					});
				}
			}
		}

		if (result.added > 0 || result.alreadyInLibrary > 0) {
			await this.refreshItemsInLibraryCount(smartListId);
		}

		return result;
	}

	async bulkAddToLibraryByTmdbIds(smartListId: string, tmdbIds: number[]): Promise<BulkAddResult> {
		const result: BulkAddResult = {
			added: 0,
			failed: 0,
			alreadyInLibrary: 0,
			errors: []
		};

		const uniqueTmdbIds = [...new Set(tmdbIds)];
		if (uniqueTmdbIds.length === 0) {
			return result;
		}

		const items = await db.query.smartListItems.findMany({
			where: and(
				eq(smartListItems.smartListId, smartListId),
				inArray(smartListItems.tmdbId, uniqueTmdbIds)
			)
		});

		const itemByTmdbId = new Map(items.map((item) => [item.tmdbId, item]));
		const itemIds: string[] = [];

		for (const tmdbId of uniqueTmdbIds) {
			const item = itemByTmdbId.get(tmdbId);
			if (!item) {
				result.failed++;
				result.errors.push({
					tmdbId,
					title: `TMDB ${tmdbId}`,
					error: 'Item not found in smart list'
				});
				continue;
			}
			itemIds.push(item.id);
		}

		if (itemIds.length > 0) {
			const bulkResult = await this.bulkAddToLibrary(smartListId, itemIds);
			result.added += bulkResult.added;
			result.failed += bulkResult.failed;
			result.alreadyInLibrary += bulkResult.alreadyInLibrary;
			result.errors.push(...bulkResult.errors);
		}

		return result;
	}

	private async refreshItemsInLibraryCount(smartListId: string): Promise<void> {
		const inLibraryCount = await db
			.select({ count: sql<number>`count(*)` })
			.from(smartListItems)
			.where(and(eq(smartListItems.smartListId, smartListId), eq(smartListItems.inLibrary, true)));

		await db
			.update(smartLists)
			.set({
				itemsInLibrary: inLibraryCount[0]?.count ?? 0,
				updatedAt: new Date().toISOString()
			})
			.where(eq(smartLists.id, smartListId));
	}

	// =========================================================================
	// Helper Methods
	// =========================================================================

	private async buildDiscoverParams(
		filters: SmartListFilters,
		sortBy: string
	): Promise<DiscoverParams> {
		const params: DiscoverParams = {
			sort_by: sortBy
		};

		// Genres
		if (filters.withGenres?.length) {
			params.with_genres =
				filters.genreMode === 'and' ? filters.withGenres.join(',') : filters.withGenres.join('|');
		}
		if (filters.withoutGenres?.length) {
			params.without_genres = filters.withoutGenres.join(',');
		}

		// Year/Date
		if (filters.yearMin) {
			params['primary_release_date.gte'] = `${filters.yearMin}-01-01`;
			params['first_air_date.gte'] = `${filters.yearMin}-01-01`;
		}
		if (filters.yearMax) {
			params['primary_release_date.lte'] = `${filters.yearMax}-12-31`;
			params['first_air_date.lte'] = `${filters.yearMax}-12-31`;
		}
		if (filters.releaseDateMin) {
			params['primary_release_date.gte'] = filters.releaseDateMin;
			params['first_air_date.gte'] = filters.releaseDateMin;
		}
		if (filters.releaseDateMax) {
			params['primary_release_date.lte'] = filters.releaseDateMax;
			params['first_air_date.lte'] = filters.releaseDateMax;
		}

		// Rating
		if (filters.voteAverageMin !== undefined) {
			params['vote_average.gte'] = filters.voteAverageMin;
		}
		if (filters.voteAverageMax !== undefined) {
			params['vote_average.lte'] = filters.voteAverageMax;
		}
		if (filters.voteCountMin !== undefined) {
			params['vote_count.gte'] = filters.voteCountMin;
		}

		// Popularity
		if (filters.popularityMin !== undefined) {
			params['popularity.gte'] = filters.popularityMin;
		}
		if (filters.popularityMax !== undefined) {
			params['popularity.lte'] = filters.popularityMax;
		}

		// People
		if (filters.withCast?.length) {
			params.with_cast = filters.withCast.join(',');
		}
		if (filters.withCrew?.length) {
			params.with_crew = filters.withCrew.join(',');
		}

		// Keywords
		if (filters.withKeywords?.length) {
			params.with_keywords = filters.withKeywords.join(',');
		}
		if (filters.withoutKeywords?.length) {
			params.without_keywords = filters.withoutKeywords.join(',');
		}

		// Watch Providers
		if (filters.withWatchProviders?.length) {
			params.with_watch_providers = filters.withWatchProviders.join('|');
			if (filters.watchRegion) {
				params.watch_region = filters.watchRegion;
			}
		}

		// Certification
		if (filters.certification) {
			params.certification = filters.certification;
			if (filters.certificationCountry) {
				params.certification_country = filters.certificationCountry;
			}
		}

		// Runtime
		if (filters.runtimeMin !== undefined) {
			params['with_runtime.gte'] = filters.runtimeMin;
		}
		if (filters.runtimeMax !== undefined) {
			params['with_runtime.lte'] = filters.runtimeMax;
		}

		// Language
		if (filters.withOriginalLanguage) {
			params.with_original_language = filters.withOriginalLanguage;
		}

		// TV-specific
		if (filters.withStatus) {
			params.with_status = filters.withStatus;
		}

		// Movie-specific
		if (filters.withReleaseType?.length) {
			params.with_release_type = filters.withReleaseType.join('|');
		}

		return params;
	}

	private async fetchDiscoverItems(
		mediaType: 'movie' | 'tv',
		params: DiscoverParams,
		limit: number
	): Promise<DiscoverItem[]> {
		const items: DiscoverItem[] = [];
		let page = 1;
		const maxPages = Math.ceil(limit / 20); // TMDB returns 20 per page

		while (items.length < limit && page <= maxPages) {
			const response =
				mediaType === 'movie'
					? await tmdb.discoverMovies({ ...params, page })
					: await tmdb.discoverTv({ ...params, page });

			items.push(...response.results);

			if (page >= response.total_pages) break;
			page++;
		}

		return items.slice(0, limit);
	}

	private async updateLibraryStatus(smartListId: string, mediaType: 'movie' | 'tv'): Promise<void> {
		const items = await db.query.smartListItems.findMany({
			where: eq(smartListItems.smartListId, smartListId)
		});

		if (items.length === 0) return;

		const tmdbIds = [...new Set(items.map((i) => i.tmdbId))];

		// Batch-fetch all library entries for these tmdbIds in one query
		const libraryMap = new Map<number, string>();
		if (mediaType === 'movie') {
			const libraryMovies = await db.query.movies.findMany({
				where: inArray(movies.tmdbId, tmdbIds)
			});
			for (const movie of libraryMovies) {
				libraryMap.set(movie.tmdbId, movie.id);
			}
		} else {
			const librarySeries = await db.query.series.findMany({
				where: inArray(series.tmdbId, tmdbIds)
			});
			for (const show of librarySeries) {
				libraryMap.set(show.tmdbId, show.id);
			}
		}

		// Update items with in-memory lookup
		for (const item of items) {
			const libraryId = libraryMap.get(item.tmdbId) ?? null;
			const inLibrary = libraryId !== null;

			if (item.inLibrary !== inLibrary) {
				await db
					.update(smartListItems)
					.set({
						inLibrary,
						movieId: mediaType === 'movie' ? libraryId : null,
						seriesId: mediaType === 'tv' ? libraryId : null,
						updatedAt: new Date().toISOString()
					})
					.where(eq(smartListItems.id, item.id));
			}
		}
	}

	private async autoAddItems(list: SmartListRecord): Promise<{ added: number }> {
		if (!list.rootFolderId) {
			logger.warn(
				{
					listId: list.id
				},
				'[SmartListService] Auto-add skipped: no root folder configured'
			);
			return { added: 0 };
		}

		const mediaType = list.mediaType as 'movie' | 'tv';

		// Validate root folder exists and matches media type
		try {
			await validateRootFolder(list.rootFolderId, mediaType);
		} catch (error) {
			logger.error(
				{
					err: error,
					...{
						listId: list.id,
						rootFolderId: list.rootFolderId
					}
				},
				'[SmartListService] Auto-add failed: invalid root folder'
			);
			return { added: 0 };
		}

		// Get items not in library, ordered by position (highest ranked first)
		const itemsToAdd = await db.query.smartListItems.findMany({
			where: and(
				eq(smartListItems.smartListId, list.id),
				eq(smartListItems.inLibrary, false),
				lt(smartListItems.position, 9999) // exclude removed items
			),
			orderBy: asc(smartListItems.position),
			limit: 10 // Add max 10 items per refresh to avoid overwhelming the system
		});

		if (itemsToAdd.length === 0) {
			return { added: 0 };
		}

		const blockedIds = await getBlockedTmdbIdSet(mediaType);
		const safeItems =
			blockedIds.size > 0 ? itemsToAdd.filter((item) => !blockedIds.has(item.tmdbId)) : itemsToAdd;

		if (safeItems.length === 0) {
			return { added: 0 };
		}

		logger.info(
			{
				listId: list.id,
				listName: list.name,
				itemCount: safeItems.length,
				mediaType
			},
			'[SmartListService] Auto-adding items from smart list'
		);

		// Get effective scoring profile
		const autoAddOwningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
			list.rootFolderId,
			mediaType
		);
		const effectiveProfileId = await getEffectiveScoringProfileId(
			list.scoringProfileId ?? undefined,
			autoAddOwningLibrary
		);
		const shouldSearch = list.autoAddBehavior === 'add_and_search';
		const monitored = list.autoAddMonitored ?? true;
		const wantsSubtitles = list.wantsSubtitles ?? true;

		let addedCount: number;

		if (mediaType === 'movie') {
			addedCount = await this.autoAddMovies(
				safeItems,
				list,
				effectiveProfileId,
				monitored,
				shouldSearch,
				wantsSubtitles
			);
		} else {
			addedCount = await this.autoAddSeries(
				safeItems,
				list,
				effectiveProfileId,
				monitored,
				shouldSearch,
				wantsSubtitles
			);
		}

		return { added: addedCount };
	}

	private async autoAddMovies(
		items: SmartListItemRecord[],
		list: SmartListRecord,
		scoringProfileId: string,
		monitored: boolean,
		shouldSearch: boolean,
		wantsSubtitles: boolean
	): Promise<number> {
		let added = 0;

		// Batch check which items already exist in library (N+1 fix)
		const tmdbIds = items.map((i) => i.tmdbId);
		const existingMovies = await db.query.movies.findMany({
			where: inArray(movies.tmdbId, tmdbIds)
		});
		const existingMovieIds = new Map(existingMovies.map((m) => [m.tmdbId, m.id]));

		// Update items that already exist (in-memory lookup, no per-item DB call)
		const alreadyExisting = items.filter((i) => existingMovieIds.has(i.tmdbId));
		try {
			for (const item of alreadyExisting) {
				await db
					.update(smartListItems)
					.set({
						inLibrary: true,
						movieId: existingMovieIds.get(item.tmdbId) ?? null,
						updatedAt: new Date().toISOString()
					})
					.where(eq(smartListItems.id, item.id));
			}
		} catch (error) {
			logger.error(
				{ err: error, listId: list.id },
				'[SmartListService] Failed to update existing items'
			);
		}

		// Process only new items
		const newItems = items.filter((i) => !existingMovieIds.has(i.tmdbId));
		if (newItems.length > 0) {
			await validateRootFolder(list.rootFolderId!, 'movie', { requireWritable: true });
		}

		for (const item of newItems) {
			try {
				// Fetch movie details from TMDB
				const movieDetails = await fetchMovieDetails(item.tmdbId);

				// Generate folder path using database naming configuration
				const year = movieDetails.release_date
					? new Date(movieDetails.release_date).getFullYear()
					: undefined;
				// Extract external IDs before folder name so all tokens are available
				const { imdbId } = await fetchMovieExternalIds(item.tmdbId);

				const localizedTitles = await resolveLocalizedTitlesForFormats('movie', item.tmdbId);
				const config = namingSettingsService.getConfigSync();
				const namingService = new NamingService(config);
				const folderName = namingService.generateMovieFolderName({
					title: movieDetails.title,
					originalTitle: movieDetails.original_title,
					year,
					tmdbId: item.tmdbId,
					imdbId,
					collectionName: movieDetails.belongs_to_collection?.name ?? undefined,
					localizedTitles
				} as MediaNamingInfo);

				// Get the language profile if subtitles wanted
				// Honor the list's language profile; otherwise inherit (NULL) — the
				// instance default is resolved at read time, never stamped here.
				const languageProfileId = wantsSubtitles ? (list.languageProfileId ?? null) : null;
				const owningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
					list.rootFolderId!,
					'movie'
				);

				// Insert movie into database
				const [insertedMovie] = await db
					.insert(movies)
					.values({
						tmdbId: item.tmdbId,
						imdbId,
						title: movieDetails.title,
						originalLanguage: movieDetails.original_language,
						originalTitle: movieDetails.original_title,
						year,
						overview: movieDetails.overview,
						posterPath: movieDetails.poster_path,
						backdropPath: movieDetails.backdrop_path,
						runtime: movieDetails.runtime,
						genres: movieDetails.genres?.map((g) => g.name) ?? [],
						path: folderName,
						libraryId: owningLibrary.id,
						rootFolderId: list.rootFolderId!,
						scoringProfileId,
						monitored,
						minimumAvailability: list.minimumAvailability ?? 'released',
						hasFile: false,
						wantsSubtitles,
						languageProfileId
					})
					.onConflictDoNothing()
					.returning();
				const newMovie =
					insertedMovie ??
					(await db
						.select()
						.from(movies)
						.where(eq(movies.tmdbId, item.tmdbId))
						.then((rows) => rows[0]));

				// Update smart list item
				await db
					.update(smartListItems)
					.set({
						inLibrary: true,
						movieId: newMovie.id,
						wasAutoAdded: true,
						autoAddedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					})
					.where(eq(smartListItems.id, item.id));

				added++;

				logger.info(
					{
						listId: list.id,
						movieId: newMovie.id,
						tmdbId: item.tmdbId,
						title: movieDetails.title
					},
					'[SmartListService] Auto-added movie'
				);

				// Trigger search if requested and movie is monitored
				if (shouldSearch && monitored) {
					await triggerMovieSearch({
						movieId: newMovie.id,
						tmdbId: item.tmdbId,
						imdbId,
						title: movieDetails.title,
						year,
						scoringProfileId
					});
				}
			} catch (error) {
				logger.error(
					{
						err: error,
						...{
							listId: list.id,
							tmdbId: item.tmdbId,
							title: item.title
						}
					},
					'[SmartListService] Failed to auto-add movie'
				);
			}
		}

		return added;
	}

	private async autoAddSeries(
		items: SmartListItemRecord[],
		list: SmartListRecord,
		scoringProfileId: string,
		monitored: boolean,
		shouldSearch: boolean,
		wantsSubtitles: boolean
	): Promise<number> {
		let added = 0;

		// Batch check which items already exist in library (N+1 fix)
		const tmdbIds = items.map((i) => i.tmdbId);
		const existingSeries = await db.query.series.findMany({
			where: inArray(series.tmdbId, tmdbIds)
		});
		const existingSeriesIds = new Map(existingSeries.map((s) => [s.tmdbId, s.id]));

		// Update items that already exist (in-memory lookup, no per-item DB call)
		const alreadyExisting = items.filter((i) => existingSeriesIds.has(i.tmdbId));
		try {
			for (const item of alreadyExisting) {
				await db
					.update(smartListItems)
					.set({
						inLibrary: true,
						seriesId: existingSeriesIds.get(item.tmdbId) ?? null,
						updatedAt: new Date().toISOString()
					})
					.where(eq(smartListItems.id, item.id));
			}
		} catch (error) {
			logger.error(
				{ err: error, listId: list.id },
				'[SmartListService] Failed to update existing items'
			);
		}

		// Process only new items
		const newItems = items.filter((i) => !existingSeriesIds.has(i.tmdbId));
		if (newItems.length > 0) {
			await validateRootFolder(list.rootFolderId!, 'tv', { requireWritable: true });
		}

		for (const item of newItems) {
			try {
				// Fetch series details from TMDB
				const seriesDetails = await fetchSeriesDetails(item.tmdbId);

				// Generate folder path using database naming configuration
				const year = seriesDetails.first_air_date
					? new Date(seriesDetails.first_air_date).getFullYear()
					: undefined;

				// Get external IDs
				const { tvdbId, imdbId } = await fetchSeriesExternalIds(item.tmdbId);

				const localizedTitles = await resolveLocalizedTitlesForFormats('series', item.tmdbId);
				const config = namingSettingsService.getConfigSync();
				const namingService = new NamingService(config);
				const folderName = namingService.generateSeriesFolderName({
					title: seriesDetails.name,
					originalTitle: seriesDetails.original_name,
					year,
					tvdbId,
					tmdbId: item.tmdbId,
					imdbId,
					localizedTitles
				} as MediaNamingInfo);

				// Get the language profile if subtitles wanted
				// Honor the list's language profile; otherwise inherit (NULL) — the
				// instance default is resolved at read time, never stamped here.
				const languageProfileId = wantsSubtitles ? (list.languageProfileId ?? null) : null;
				const owningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
					list.rootFolderId!,
					'tv'
				);

				// Insert series into database
				const [insertedSeries] = await db
					.insert(series)
					.values({
						tmdbId: item.tmdbId,
						tvdbId,
						imdbId,
						title: seriesDetails.name,
						originalLanguage: seriesDetails.original_language,
						originalTitle: seriesDetails.original_name,
						year,
						overview: seriesDetails.overview,
						posterPath: seriesDetails.poster_path,
						backdropPath: seriesDetails.backdrop_path,
						status: seriesDetails.status,
						network:
							seriesDetails.networks && seriesDetails.networks.length > 0
								? seriesDetails.networks[0].name
								: null,
						genres: seriesDetails.genres?.map((g) => g.name) ?? [],
						path: folderName,
						libraryId: owningLibrary.id,
						rootFolderId: list.rootFolderId!,
						scoringProfileId,
						monitored,
						seasonFolder: true,
						seriesType: 'standard',
						monitorNewItems: 'all',
						monitorSpecials: false,
						episodeCount: 0,
						episodeFileCount: 0,
						wantsSubtitles,
						languageProfileId
					})
					.onConflictDoNothing()
					.returning();
				const newSeries =
					insertedSeries ??
					(await db
						.select()
						.from(series)
						.where(eq(series.tmdbId, item.tmdbId))
						.then((rows) => rows[0]));

				// Create seasons and episodes
				await this.createSeasonsAndEpisodes(newSeries.id, item.tmdbId, monitored);

				// Update smart list item
				await db
					.update(smartListItems)
					.set({
						inLibrary: true,
						seriesId: newSeries.id,
						wasAutoAdded: true,
						autoAddedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					})
					.where(eq(smartListItems.id, item.id));

				added++;

				logger.info(
					{
						listId: list.id,
						seriesId: newSeries.id,
						tmdbId: item.tmdbId,
						title: seriesDetails.name
					},
					'[SmartListService] Auto-added series'
				);

				// Trigger search if requested and series is monitored
				if (shouldSearch && monitored) {
					await triggerSeriesSearch({
						seriesId: newSeries.id,
						tmdbId: item.tmdbId,
						title: seriesDetails.name
					});
				}
			} catch (error) {
				logger.error(
					{
						err: error,
						...{
							listId: list.id,
							tmdbId: item.tmdbId,
							title: item.title
						}
					},
					'[SmartListService] Failed to auto-add series'
				);
			}
		}

		return added;
	}

	private async createSeasonsAndEpisodes(
		seriesId: string,
		tmdbId: number,
		monitored: boolean
	): Promise<void> {
		try {
			const seriesDetails = await tmdb.getTVShow(tmdbId);
			if (!seriesDetails.seasons) return;

			for (const seasonInfo of seriesDetails.seasons) {
				// Skip specials (season 0) by default
				const isSpecials = seasonInfo.season_number === 0;
				const seasonMonitored = monitored && !isSpecials;

				// Create season (episodeCount will be recalculated after episodes are inserted)
				const [insertedSeason] = await db
					.insert(seasons)
					.values({
						seriesId,
						seasonNumber: seasonInfo.season_number,
						name: seasonInfo.name,
						overview: seasonInfo.overview ?? null,
						posterPath: seasonInfo.poster_path ?? null,
						airDate: seasonInfo.air_date ?? null,
						episodeCount: 0, // Will be recalculated to only aired episodes
						monitored: seasonMonitored
					})
					.onConflictDoNothing()
					.returning();
				const newSeason =
					insertedSeason ??
					(await db
						.select()
						.from(seasons)
						.where(
							and(
								eq(seasons.seriesId, seriesId),
								eq(seasons.seasonNumber, seasonInfo.season_number)
							)
						)
						.then((rows) => rows[0]));

				// Fetch season details for episodes
				try {
					const seasonDetails = await tmdb.getSeason(tmdbId, seasonInfo.season_number);
					if (seasonDetails.episodes) {
						const episodesToInsert = seasonDetails.episodes.map((ep) => ({
							seriesId,
							seasonId: newSeason.id,
							tmdbId: ep.id,
							seasonNumber: seasonInfo.season_number,
							episodeNumber: ep.episode_number,
							title: ep.name,
							overview: ep.overview ?? null,
							airDate: ep.air_date ?? null,
							runtime: ep.runtime ?? null,
							monitored: seasonMonitored,
							hasFile: false
						}));

						if (episodesToInsert.length > 0) {
							await db.insert(episodes).values(episodesToInsert).onConflictDoNothing();
							// Only count aired episodes (exclude specials and unaired)
							const today = todayDateString();
							const airedCount = episodesToInsert.filter(
								(ep) =>
									ep.seasonNumber !== 0 && ep.airDate && ep.airDate !== '' && ep.airDate <= today
							).length;

							// Update season episodeCount to only aired episodes
							await db
								.update(seasons)
								.set({ episodeCount: airedCount })
								.where(eq(seasons.id, newSeason.id));
						}
					}
				} catch (_err) {
					logger.warn(
						{
							tmdbId,
							seasonNumber: seasonInfo.season_number
						},
						'[SmartListService] Failed to fetch season details'
					);
				}
			}

			// Update series episode count (only count aired episodes)
			const today = todayDateString();
			const isAired = (ep: typeof episodes.$inferSelect) =>
				Boolean(ep.airDate && ep.airDate !== '' && ep.airDate <= today);

			const allSeriesEpisodes = await db
				.select()
				.from(episodes)
				.where(eq(episodes.seriesId, seriesId));
			const airedEpisodes = allSeriesEpisodes.filter((e) => e.seasonNumber !== 0 && isAired(e));

			await db
				.update(series)
				.set({
					episodeCount: airedEpisodes.length
				})
				.where(eq(series.id, seriesId));
		} catch (error) {
			logger.error(
				{
					err: error,
					...{
						seriesId,
						tmdbId
					}
				},
				'[SmartListService] Failed to create seasons/episodes'
			);
		}
	}

	// =========================================================================
	// External List Operations
	// =========================================================================

	/**
	 * Sync an external list (JSON URL, Trakt, etc.)
	 */
	private async syncExternalList(
		list: SmartListRecord,
		refreshType: 'automatic' | 'manual'
	): Promise<RefreshResult> {
		const startTime = Date.now();
		const id = list.id;

		// Build external source config from preset and user settings
		let externalSourceConfig = list.externalSourceConfig ?? {};
		let providerType = list.presetProvider ?? list.listSourceType;
		if (list.presetId) {
			const preset = presetService.getPreset(list.presetId);
			if (preset) {
				providerType = preset.provider;

				// Start with preset config (for providers like tmdb-popular)
				externalSourceConfig = {
					...preset.config,
					...externalSourceConfig
				};

				// Merge user settings from presetSettings (for custom presets like tmdb-list:custom)
				if (list.presetSettings) {
					externalSourceConfig = {
						...externalSourceConfig,
						...list.presetSettings
					};
				}

				// Add URL if preset has one (for external-json provider)
				if (preset.url) {
					externalSourceConfig.url = preset.url;
				}

				logger.info(
					{
						presetId: list.presetId,
						config: externalSourceConfig
					},
					'[SmartListService] Using preset config'
				);
			}
		}

		logger.info(
			{
				id,
				sourceType: list.listSourceType,
				providerType,
				url: externalSourceConfig?.url,
				presetId: list.presetId
			},
			'[SmartListService] Starting external list sync'
		);

		// Create history entry
		const [historyEntry] = await db
			.insert(smartListRefreshHistory)
			.values({
				smartListId: id,
				refreshType,
				status: 'running',
				startedAt: new Date().toISOString()
			})
			.returning();

		try {
			// Get the appropriate provider
			const provider = providerRegistry.get(providerType);
			if (!provider) {
				throw new Error(`No provider registered for source type: ${providerType}`);
			}

			// Validate config
			if (!provider.validateConfig(externalSourceConfig)) {
				throw new Error('Invalid external source configuration');
			}

			// Fetch items from external source
			// For external lists, we pass empty string to show all content types (movies and TV)
			const externalResult = await provider.fetchItems(externalSourceConfig, '');

			if (externalResult.error) {
				throw new Error(`External fetch failed: ${externalResult.error}`);
			}

			logger.info(
				{
					id,
					totalCount: externalResult.totalCount,
					failedCount: externalResult.failedCount
				},
				'[SmartListService] Fetched external items'
			);

			// Resolve external items to TMDB items
			const resolvedItems = await this.resolveExternalItems(
				externalResult.items,
				list.mediaType as 'movie' | 'tv',
				id
			);

			logger.info(
				{
					id,
					resolvedCount: resolvedItems.length,
					totalExternal: externalResult.items.length
				},
				'[SmartListService] Resolved external items to TMDB'
			);

			// Get existing items for this list
			const existingItems = await db.query.smartListItems.findMany({
				where: eq(smartListItems.smartListId, id)
			});
			const existingTmdbIds = new Set(existingItems.map((item) => item.tmdbId));

			// Process items
			let itemsNew = 0;
			let itemsRemoved = 0;
			const itemsFailed = 0;
			const newTmdbIds = new Set(resolvedItems.map((item) => item.tmdbId));

			// Add new items
			const itemsToInsert: Array<typeof smartListItems.$inferInsert> = [];
			const now = new Date().toISOString();

			for (let i = 0; i < resolvedItems.length; i++) {
				const item = resolvedItems[i];
				if (!existingTmdbIds.has(item.tmdbId)) {
					itemsNew++;
					itemsToInsert.push({
						smartListId: id,
						mediaType: list.mediaType as 'movie' | 'tv',
						tmdbId: item.tmdbId,
						title: item.title,
						originalTitle: item.title,
						overview: item.overview,
						posterPath: item.posterPath,
						releaseDate: item.releaseDate,
						year: item.year,
						voteAverage: item.voteAverage ? String(item.voteAverage) : null,
						voteCount: item.voteCount,
						popularity: null,
						genreIds: item.genreIds,
						originalLanguage: item.originalLanguage,
						position: i,
						firstSeenAt: now,
						lastSeenAt: now,
						updatedAt: now
					});
				}
			}

			// Insert new items in batches
			if (itemsToInsert.length > 0) {
				const batchSize = 50;
				for (let i = 0; i < itemsToInsert.length; i += batchSize) {
					const batch = itemsToInsert.slice(i, i + batchSize);
					await db.insert(smartListItems).values(batch);
				}
			}

			// Update positions for existing items
			for (let i = 0; i < resolvedItems.length; i++) {
				const item = resolvedItems[i];
				if (existingTmdbIds.has(item.tmdbId)) {
					await db
						.update(smartListItems)
						.set({
							position: i,
							lastSeenAt: now,
							updatedAt: now
						})
						.where(and(eq(smartListItems.smartListId, id), eq(smartListItems.tmdbId, item.tmdbId)));
				}
			}

			// Mark items not in new results as removed
			for (const existing of existingItems) {
				if (!newTmdbIds.has(existing.tmdbId)) {
					itemsRemoved++;
					await db
						.update(smartListItems)
						.set({
							position: 9999,
							updatedAt: now
						})
						.where(eq(smartListItems.id, existing.id));
				}
			}

			// Update library status for all items
			await this.updateLibraryStatus(id, list.mediaType as 'movie' | 'tv');

			// Handle auto-add if enabled
			let itemsAutoAdded = 0;
			if (list.autoAddBehavior !== 'disabled' && list.rootFolderId) {
				const result = await this.autoAddItems(list);
				itemsAutoAdded = result.added;
			}

			// Update list stats
			const finalItemCount = await db
				.select({ count: sql<number>`count(*)` })
				.from(smartListItems)
				.where(and(eq(smartListItems.smartListId, id), lt(smartListItems.position, 9999)));

			const inLibraryCount = await db
				.select({ count: sql<number>`count(*)` })
				.from(smartListItems)
				.where(and(eq(smartListItems.smartListId, id), eq(smartListItems.inLibrary, true)));

			const completedAt = new Date().toISOString();
			const durationMs = Date.now() - startTime;

			await db
				.update(smartLists)
				.set({
					lastRefreshTime: completedAt,
					lastRefreshStatus: 'success',
					lastRefreshError: null,
					lastExternalSyncTime: completedAt,
					externalSyncError: null,
					nextRefreshTime: new Date(
						Date.now() + list.refreshIntervalHours * 60 * 60 * 1000
					).toISOString(),
					cachedItemCount: finalItemCount[0]?.count ?? 0,
					itemsInLibrary: inLibraryCount[0]?.count ?? 0,
					itemsAutoAdded: (list.itemsAutoAdded ?? 0) + itemsAutoAdded,
					updatedAt: completedAt
				})
				.where(eq(smartLists.id, id));

			// Update history
			await db
				.update(smartListRefreshHistory)
				.set({
					status: 'success',
					itemsFound: resolvedItems.length,
					itemsNew,
					itemsRemoved,
					itemsAutoAdded,
					itemsFailed,
					completedAt,
					durationMs
				})
				.where(eq(smartListRefreshHistory.id, historyEntry.id));

			logger.info(
				{
					id,
					itemsFound: resolvedItems.length,
					itemsNew,
					itemsRemoved,
					itemsAutoAdded,
					durationMs
				},
				'[SmartListService] External sync completed'
			);

			return {
				smartListId: id,
				status: 'success',
				itemsFound: resolvedItems.length,
				itemsNew,
				itemsRemoved,
				itemsAutoAdded,
				itemsFailed,
				durationMs
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const durationMs = Date.now() - startTime;

			await db
				.update(smartLists)
				.set({
					lastRefreshStatus: 'failed',
					lastRefreshError: errorMessage,
					externalSyncError: errorMessage,
					updatedAt: new Date().toISOString()
				})
				.where(eq(smartLists.id, id));

			await db
				.update(smartListRefreshHistory)
				.set({
					status: 'failed',
					errorMessage,
					completedAt: new Date().toISOString(),
					durationMs
				})
				.where(eq(smartListRefreshHistory.id, historyEntry.id));

			logger.error({ err: error, ...{ id } }, '[SmartListService] External sync failed');

			return {
				smartListId: id,
				status: 'failed',
				itemsFound: 0,
				itemsNew: 0,
				itemsRemoved: 0,
				itemsAutoAdded: 0,
				itemsFailed: 0,
				durationMs,
				errorMessage
			};
		}
	}

	/**
	 * Resolve external list items to TMDB items
	 * Uses concurrent batch processing for much faster resolution
	 */
	private async resolveExternalItems(
		items: ExternalListItem[],
		mediaType: 'movie' | 'tv',
		listId: string
	): Promise<
		Array<{
			tmdbId: number;
			title: string;
			overview?: string;
			posterPath?: string | null;
			releaseDate?: string;
			year?: number;
			voteAverage?: number;
			voteCount?: number;
			genreIds?: number[];
			originalLanguage?: string;
		}>
	> {
		logger.info(
			{
				listId,
				itemCount: items.length,
				mediaType
			},
			'[SmartListService] Starting external item resolution'
		);

		const startTime = Date.now();

		// Use batch resolution with concurrency for much faster processing
		const results = await externalIdResolver.resolveItemsBatch(items, mediaType, 10);

		const resolved: ReturnType<typeof this.resolveExternalItems> extends Promise<infer T>
			? T
			: never = [];

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const result = results[i];

			if (result.success && result.tmdbId) {
				resolved.push({
					tmdbId: result.tmdbId,
					title: result.title || item.title,
					overview: item.overview,
					posterPath: item.posterPath ?? result.posterPath,
					year: result.year ?? item.year,
					voteAverage: item.voteAverage,
					voteCount: item.voteCount,
					genreIds: item.genreIds,
					originalLanguage: item.originalLanguage
				});
			} else {
				logger.warn(
					{
						listId,
						index: i,
						title: item.title,
						error: result.error
					},
					'[SmartListService] Failed to resolve external item'
				);
			}
		}

		const duration = Date.now() - startTime;
		logger.info(
			{
				listId,
				totalItems: items.length,
				resolvedCount: resolved.length,
				failedCount: items.length - resolved.length,
				durationMs: duration
			},
			'[SmartListService] External item resolution complete'
		);

		return resolved;
	}
}

// Singleton getter
export function getSmartListService(): SmartListService {
	return SmartListService.getInstance();
}
