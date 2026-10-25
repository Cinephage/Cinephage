/**
 * IndexerManager - Central service for managing indexers.
 * YAML-only architecture: all indexers (torrent, usenet, streaming)
 * are defined by YAML files loaded from data/indexers/definitions.
 * Handles definition loading, indexer creation, and search orchestration.
 */

import { db } from '#lib/server/db/index.js';
import { indexers as indexersTable } from '#lib/server/db/schema.js';
import {
	type TorrentProtocolSettings,
	type UsenetProtocolSettings,
	type StreamingProtocolSettings
} from './types/index.js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '#lib/logging/index.js';
import {
	decryptSecretJsonValues,
	encryptSecretJsonValues
} from '#lib/server/crypto/secretFields.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });

/** AAD purpose for credentials inside indexers.settings. */
const INDEXER_SETTINGS_PURPOSE = 'indexer-settings';

/** Encrypt credential keys inside an indexer settings object (idempotent). */
function encryptIndexerSettings(
	indexerId: string,
	settings: Record<string, unknown>
): Record<string, unknown> {
	return encryptSecretJsonValues(INDEXER_SETTINGS_PURPOSE, indexerId, settings);
}

/** Decrypt credential envelopes inside an indexer settings object. */
function decryptIndexerSettings(
	indexerId: string,
	settings: Record<string, unknown>
): Record<string, unknown> {
	return decryptSecretJsonValues(INDEXER_SETTINGS_PURPOSE, indexerId, settings);
}

import type {
	IIndexer,
	IndexerConfig,
	SearchCriteria,
	SearchResult,
	IndexerCapabilities
} from './types';
import { YamlDefinitionLoader, YamlIndexerFactory } from './loader';
import type { YamlDefinition } from './schema/yamlDefinition';
import { buildCapabilitiesFromYaml } from './capabilities';
import {
	getSearchOrchestrator,
	clearSearchCache,
	type SearchOrchestratorOptions,
	type EnhancedSearchResult
} from './search/SearchOrchestrator';
import { getPersistentStatusTracker } from './status';
import { getRateLimitRegistry } from './ratelimit';
import { cleanupIndexerCookies } from './http/IndexerHttp';
import { CINEPHAGE_STREAM_DEFINITION_ID } from './types';
import { getCinephageModuleRegistry } from '#lib/server/cinephage/registry/CinephageModuleRegistry.js';
import type { CinephageModule } from '#lib/server/cinephage/modules/types.js';

/** Manager options */
export interface IndexerManagerOptions {
	/** Path(s) to YAML definitions directory */
	definitionsPath?: string | string[];
}

/**
 * Central service for managing indexers.
 */
export class IndexerManager {
	private definitionLoader: YamlDefinitionLoader;
	private indexerFactory: YamlIndexerFactory;
	private indexerInstances: Map<string, IIndexer> = new Map();
	private indexerCreationInFlight: Map<string, Promise<IIndexer | null>> = new Map();

	constructor(options: IndexerManagerOptions = {}) {
		const path = options.definitionsPath;
		const definitionsPath = typeof path === 'string' ? path : path?.[0];
		this.definitionLoader = new YamlDefinitionLoader(definitionsPath);
		this.indexerFactory = new YamlIndexerFactory(this.definitionLoader);
	}

	/** Initialize the manager - load definitions */
	async initialize(): Promise<void> {
		logger.info('Initializing IndexerManager');
		await this.definitionLoader.loadAll();

		// Allow registered Cinephage subsystem modules to seed/sync any
		// indexer rows they own (e.g. library-streaming owns cinephage-stream).
		// This replaces the old hard-coded seedStreamingIndexer() method.
		await this.syncBuiltinIndexers();

		logger.info(
			{
				definitionCount: this.definitionLoader.count,
				errors: this.definitionLoader.getErrors().length
			},
			'IndexerManager initialized'
		);

		// Log any errors
		for (const error of this.definitionLoader.getErrors()) {
			logger.warn(
				{
					file: error.filePath,
					error: error.error
				},
				'Definition load error'
			);
		}
	}

	/**
	 * Consult the Cinephage module registry for modules that publish virtual
	 * indexer rows (capability: providesIndexer). Each such module owns its
	 * row's lifecycle — we ask it to sync, and it handles idempotent seeding.
	 */
	private async syncBuiltinIndexers(): Promise<void> {
		const registry = getCinephageModuleRegistry();
		const indexerProviders = registry.getByCapability('providesIndexer');
		if (indexerProviders.length === 0) {
			// No modules registered yet (e.g. during the Phase 1 foundation
			// window or in tests that don't load the cinephage subsystem).
			// Fall back to the legacy seedStreamingIndexer flow so we don't
			// lose the row on existing installs.
			await this.seedStreamingIndexerLegacy();
			return;
		}

		// Modules exposing the legacy syncIndexerRow() method (LibraryStreamingModule
		// implements it directly). Future indexer-providing modules do the same.
		for (const mod of indexerProviders) {
			const candidate = mod as CinephageModule & {
				syncIndexerRow?: () => Promise<void>;
			};
			if (typeof candidate.syncIndexerRow === 'function') {
				try {
					await candidate.syncIndexerRow();
				} catch (error) {
					logger.error(
						{ err: error, moduleId: mod.id },
						'Failed to sync indexer row for cinephage module'
					);
				}
			}
		}
	}

	/**
	 * Legacy fallback: seeds the cinephage-stream row directly. Used when the
	 * Cinephage subsystem hasn't registered any modules yet (Phase 1 boot or
	 * test environments without the subsystem loaded). The migration path
	 * guarantees any existing row is already marked isBuiltIn, so this mainly
	 * creates the row for first-time installs that bypass the subsystem.
	 */
	private async seedStreamingIndexerLegacy(): Promise<void> {
		const existing = await db
			.select()
			.from(indexersTable)
			.where(eq(indexersTable.definitionId, CINEPHAGE_STREAM_DEFINITION_ID));

		if (existing.length > 0) {
			const current = existing[0];
			if (!current.isBuiltIn) {
				await db
					.update(indexersTable)
					.set({ isBuiltIn: true, updatedAt: new Date().toISOString() })
					.where(eq(indexersTable.id, current.id));
			}
			return;
		}

		const def = this.definitionLoader.get(CINEPHAGE_STREAM_DEFINITION_ID);
		if (!def) {
			logger.warn({ id: CINEPHAGE_STREAM_DEFINITION_ID }, 'Streaming indexer definition not found');
			return;
		}

		const now = new Date().toISOString();
		await db.insert(indexersTable).values({
			name: def.name,
			definitionId: CINEPHAGE_STREAM_DEFINITION_ID,
			enabled: true,
			isBuiltIn: true,
			baseUrl: def.links[0] || 'http://localhost',
			priority: 50,
			enableAutomaticSearch: true,
			enableInteractiveSearch: true,
			createdAt: now,
			updatedAt: now
		});
		logger.info(
			{ definitionId: CINEPHAGE_STREAM_DEFINITION_ID, name: def.name },
			'Seeded built-in streaming indexer to database (legacy path)'
		);
	}

	/** Get all available YAML definitions */
	getDefinitions(): YamlDefinition[] {
		return this.definitionLoader.getAll();
	}

	/** Get all definitions converted to unified format for UI */
	getUnifiedDefinitions(): import('./loader').IndexerDefinition[] {
		return this.definitionLoader.getAllUnified();
	}

	/** Get a unified definition by ID */
	getUnifiedDefinition(id: string): import('./loader').IndexerDefinition | undefined {
		return this.definitionLoader.getUnified(id);
	}

	/** Get definition loading errors */
	getDefinitionErrors(): Array<{ filePath: string; error: string }> {
		return this.definitionLoader.getErrors();
	}

	/** Check if definitions have been loaded */
	isDefinitionsLoaded(): boolean {
		return this.definitionLoader.isLoaded();
	}

	/** Get a specific definition by ID (YAML-only) */
	getDefinition(id: string): YamlDefinition | undefined {
		return this.definitionLoader.get(id);
	}

	/** Check if a definition exists (YAML-only) */
	hasDefinition(id: string): boolean {
		return this.definitionLoader.hasDefinition(id);
	}

	/** Reload all definitions */
	async reloadDefinitions(): Promise<void> {
		await this.definitionLoader.reload();

		// Recreate factory with new loader state
		this.indexerFactory = new YamlIndexerFactory(this.definitionLoader);

		// Clear cached indexer instances so they get recreated
		this.indexerInstances.clear();
	}

	/** Get all configured indexers from database */
	async getIndexers(): Promise<IndexerConfig[]> {
		const rows = await db.select().from(indexersTable);
		return rows.map((row) => this.rowToConfig(row));
	}

	/** Get a specific indexer config by ID */
	async getIndexer(id: string): Promise<IndexerConfig | undefined> {
		const rows = await db.select().from(indexersTable).where(eq(indexersTable.id, id));
		return rows[0] ? this.rowToConfig(rows[0]) : undefined;
	}

	/** Create a new indexer configuration */
	async createIndexer(config: Omit<IndexerConfig, 'id' | 'protocol'>): Promise<IndexerConfig> {
		// YAML-only architecture - all definitions come from YAML
		const yamlDef = this.definitionLoader.get(config.definitionId);

		if (!yamlDef) {
			throw new Error(`Unknown definition: ${config.definitionId}`);
		}

		// Get default URL from YAML definition
		const defaultUrl = yamlDef.links[0];

		// Prowlarr indexers store their actual protocol in settings so mixed
		// torrent/usenet indexers get the right protocol settings at creation time.
		const effectiveProtocol =
			(config.settings?.protocol as string | undefined) ?? yamlDef.protocol ?? 'torrent';

		// Build protocol settings from config
		const protocolSettings = this.buildProtocolSettings(config, effectiveProtocol);

		// Insert and return the generated ID. The id is generated client-side so
		// the settings' credential envelope can bind to it (AAD) before insert.
		const id = randomUUID();
		const result = await db
			.insert(indexersTable)
			.values({
				id,
				name: config.name,
				definitionId: config.definitionId,
				enabled: config.enabled,
				upstreamEnabled: config.upstreamEnabled ?? null,
				orphaned: config.orphaned ?? false,
				baseUrl: config.baseUrl ?? defaultUrl,
				alternateUrls: config.alternateUrls ?? null,
				priority: config.priority,
				rateLimitPerMinute: config.rateLimitPerMinute ?? null,
				settings: encryptIndexerSettings(
					id,
					(config.settings as Record<string, unknown>) ?? {}
				) as Record<string, string | number | boolean>,
				protocolSettings: protocolSettings ?? undefined,

				// Search capability toggles
				enableAutomaticSearch: config.enableAutomaticSearch,
				enableInteractiveSearch: config.enableInteractiveSearch
			})
			.returning({ id: indexersTable.id });

		if (!result[0]?.id) {
			throw new Error('Failed to create indexer: no ID returned');
		}

		const created = await this.getIndexer(id);
		if (!created) {
			throw new Error('Failed to create indexer');
		}

		return created;
	}

	/** Build protocol-specific settings from config */
	private buildProtocolSettings(
		config: Partial<IndexerConfig>,
		protocol: string
	): TorrentProtocolSettings | UsenetProtocolSettings | StreamingProtocolSettings | null {
		if (protocol === 'torrent') {
			return {
				minimumSeeders: config.minimumSeeders ?? 1,
				seedRatio: config.seedRatio ?? null,
				seedTime: config.seedTime ?? null,
				packSeedTime: config.packSeedTime ?? null,
				rejectDeadTorrents: config.rejectDeadTorrents ?? true
			};
		}
		if (protocol === 'usenet') {
			return {
				minimumRetention: null,
				maximumRetention: null,
				downloadPriority: 'normal',
				preferCompleteNzb: true,
				rejectPasswordProtected: config.rejectPasswordProtected ?? true,
				minimumCompletionPercentage: config.minimumCompletionPercentage ?? 95
			};
		}
		if (protocol === 'streaming') {
			return {
				baseUrl: null,
				preferredQuality: 'auto',
				includeInAutoSearch: true,
				blockedProviders: undefined
			};
		}
		return null;
	}

	/** Update an indexer configuration */
	async updateIndexer(
		id: string,
		updates: Partial<Omit<IndexerConfig, 'id' | 'definitionId'>>
	): Promise<IndexerConfig> {
		const existing = await this.getIndexer(id);
		if (!existing) {
			throw new Error(`Indexer not found: ${id}`);
		}

		// Built-in indexers (e.g. cinephage-stream owned by the CinephageAPI
		// subsystem's library-streaming module) reject edits to fields the
		// owning subsystem manages. User can still toggle enable state,
		// search-mode toggles, and priority — those reflect search behavior
		// and don't conflict with subsystem-owned config.
		if (existing.isBuiltIn) {
			const restricted: Array<keyof typeof updates> = [
				'name',
				'baseUrl',
				'alternateUrls',
				'settings',
				'additionalCategories'
			];
			const attempted = restricted.filter((field) => updates[field] !== undefined);
			if (attempted.length > 0) {
				throw new Error(
					`Cannot edit restricted field(s) ${attempted.join(', ')} on built-in indexer '${existing.definitionId}'. Manage it via the Cinephage settings panel.`
				);
			}
		}

		const updateData: Record<string, unknown> = {};
		if (updates.name !== undefined) updateData.name = updates.name;
		if (updates.enabled !== undefined) updateData.enabled = updates.enabled ? 1 : 0;
		if (updates.upstreamEnabled !== undefined) updateData.upstreamEnabled = updates.upstreamEnabled;
		if (updates.orphaned !== undefined) updateData.orphaned = updates.orphaned ? 1 : 0;
		if (updates.baseUrl !== undefined) updateData.baseUrl = updates.baseUrl;
		if (updates.alternateUrls !== undefined) updateData.alternateUrls = updates.alternateUrls;
		if (updates.priority !== undefined) updateData.priority = updates.priority;
		if (updates.rateLimitPerMinute !== undefined)
			updateData.rateLimitPerMinute = updates.rateLimitPerMinute;
		if (updates.settings !== undefined) {
			updateData.settings = encryptIndexerSettings(
				id,
				(updates.settings as Record<string, unknown>) ?? {}
			);
		}
		if (updates.additionalCategories !== undefined)
			updateData.additionalCategories = updates.additionalCategories;

		// Search capability toggles
		if (updates.enableAutomaticSearch !== undefined)
			updateData.enableAutomaticSearch = updates.enableAutomaticSearch;
		if (updates.enableInteractiveSearch !== undefined)
			updateData.enableInteractiveSearch = updates.enableInteractiveSearch;

		// Update protocol settings if any protocol-specific fields are changed
		if (
			updates.minimumSeeders !== undefined ||
			updates.seedRatio !== undefined ||
			updates.seedTime !== undefined ||
			updates.packSeedTime !== undefined ||
			updates.rejectDeadTorrents !== undefined ||
			updates.rejectPasswordProtected !== undefined ||
			updates.minimumCompletionPercentage !== undefined
		) {
			// rowToConfig flattens protocolSettings into top-level config keys, so
			// rebuild the current snapshot from those. Reading `existing.protocolSettings`
			// (which is always undefined here) would discard every protocol field the
			// caller did not override.
			const currentSettings = {
				minimumSeeders: existing.minimumSeeders,
				seedRatio: existing.seedRatio,
				seedTime: existing.seedTime,
				packSeedTime: existing.packSeedTime,
				rejectDeadTorrents: existing.rejectDeadTorrents,
				rejectPasswordProtected: existing.rejectPasswordProtected,
				minimumCompletionPercentage: existing.minimumCompletionPercentage
			};
			updateData.protocolSettings = {
				...currentSettings,
				...(updates.minimumSeeders !== undefined && { minimumSeeders: updates.minimumSeeders }),
				...(updates.seedRatio !== undefined && { seedRatio: updates.seedRatio }),
				...(updates.seedTime !== undefined && { seedTime: updates.seedTime }),
				...(updates.packSeedTime !== undefined && { packSeedTime: updates.packSeedTime }),
				...(updates.rejectDeadTorrents !== undefined && {
					rejectDeadTorrents: updates.rejectDeadTorrents
				}),
				...(updates.rejectPasswordProtected !== undefined && {
					rejectPasswordProtected: updates.rejectPasswordProtected
				}),
				...(updates.minimumCompletionPercentage !== undefined && {
					minimumCompletionPercentage: updates.minimumCompletionPercentage
				})
			};
		}

		await db.update(indexersTable).set(updateData).where(eq(indexersTable.id, id));

		// Clear cached instances so they get recreated with new settings
		this.indexerInstances.delete(id);
		this.indexerFactory.removeIndexer(id);

		// Update status tracking.
		// The effective enabled state is: user `enabled` AND upstream not locked out.
		// Re-evaluate whenever either flag changes so health polling stays in sync.
		const statusTracker = getPersistentStatusTracker();
		const enabledChanged = updates.enabled !== undefined && updates.enabled !== existing.enabled;
		const upstreamChanged =
			updates.upstreamEnabled !== undefined && updates.upstreamEnabled !== existing.upstreamEnabled;
		const orphanedChanged =
			updates.orphaned !== undefined && updates.orphaned !== existing.orphaned;

		if (enabledChanged || upstreamChanged || orphanedChanged) {
			const newEnabled = updates.enabled ?? existing.enabled;
			const newUpstream =
				updates.upstreamEnabled !== undefined ? updates.upstreamEnabled : existing.upstreamEnabled;
			const newOrphaned = updates.orphaned !== undefined ? updates.orphaned : existing.orphaned;
			const effectiveEnabled = newEnabled && (newUpstream ?? true) && !newOrphaned;
			if (effectiveEnabled) {
				statusTracker.enable(id);
			} else {
				statusTracker.disable(id);
			}
			// Search results are cached without awareness of which indexers are enabled.
			// Clear so the next search reflects the new indexer set.
			clearSearchCache();
		}
		if (updates.priority !== undefined) {
			statusTracker.setPriority(id, updates.priority);
		}

		const updated = await this.getIndexer(id);
		if (!updated) {
			throw new Error('Failed to update indexer');
		}

		return updated;
	}

	/** Delete an indexer */
	async deleteIndexer(id: string): Promise<void> {
		// Built-in indexers cannot be deleted — they are owned by a subsystem
		// (e.g. CinephageAPI library-streaming owns cinephage-stream). The
		// subsystem would re-seed the row on the next init anyway.
		const existing = await this.getIndexer(id);
		if (existing?.isBuiltIn) {
			throw new Error(
				`Cannot delete built-in indexer '${existing.definitionId}'. Disable it instead, or manage via the Cinephage settings panel.`
			);
		}

		await db.delete(indexersTable).where(eq(indexersTable.id, id));

		// Clean up all resources
		this.indexerInstances.delete(id);
		this.indexerFactory.removeIndexer(id);
		getPersistentStatusTracker().remove(id);
		getRateLimitRegistry().remove(id);
		cleanupIndexerCookies(id); // Clean up cookie jar to prevent memory leak
	}

	/** Create an indexer instance from config (YAML-only architecture) */
	private async createIndexerInstance(config: IndexerConfig): Promise<IIndexer | null> {
		const instance = await this.indexerFactory.createIndexer(config);
		if (instance) {
			logger.debug(
				{
					indexerId: config.id,
					definitionId: config.definitionId,
					protocol: config.protocol
				},
				'Created indexer instance'
			);
		}
		return instance;
	}

	/** Get or create an indexer instance */
	async getIndexerInstance(id: string): Promise<IIndexer | undefined> {
		// Check cache first
		let instance = this.indexerInstances.get(id);
		if (instance) return instance;

		// Load config
		const config = await this.getIndexer(id);
		if (!config) return undefined;

		// Create instance
		try {
			instance = (await this.createIndexerInstance(config)) ?? undefined;
			if (instance) {
				this.indexerInstances.set(id, instance);
			}
			return instance;
		} catch (error) {
			logger.error({ err: error, ...{ indexerId: id } }, 'Failed to create indexer instance');
			return undefined;
		}
	}

	/** Get all enabled indexer instances with batch optimization */
	async getEnabledIndexers(): Promise<IIndexer[]> {
		const configs = await this.getIndexers();
		// Effective enabled = user toggle AND upstream not locked out.
		// upstreamEnabled === null means no upstream constraint (Jackett / manual).
		const enabledConfigs = configs.filter(
			(c) => c.enabled && (c.upstreamEnabled ?? true) && !c.orphaned
		);

		// Separate cached from uncached for batch processing
		const cached: IIndexer[] = [];
		const needsCreation: IndexerConfig[] = [];

		for (const config of enabledConfigs) {
			const existing = this.indexerInstances.get(config.id);
			if (existing) {
				cached.push(existing);
			} else {
				needsCreation.push(config);
			}
		}

		// Create uncached instances in parallel with in-flight dedup
		const created: IIndexer[] = [];
		const creationPromises = needsCreation.map(async (config) => {
			const existing = this.indexerInstances.get(config.id);
			if (existing) return existing;

			let promise = this.indexerCreationInFlight.get(config.id);
			if (!promise) {
				promise = this.createIndexerInstance(config)
					.then((instance) => {
						if (instance) {
							this.indexerInstances.set(config.id, instance);
						}
						this.indexerCreationInFlight.delete(config.id);
						return instance;
					})
					.catch((error) => {
						logger.error({ err: error, indexerId: config.id }, 'Failed to create indexer instance');
						this.indexerCreationInFlight.delete(config.id);
						return null;
					});
				this.indexerCreationInFlight.set(config.id, promise);
			}
			return promise;
		});

		const creationResults = await Promise.allSettled(creationPromises);

		for (const result of creationResults) {
			if (result.status === 'fulfilled' && result.value) {
				created.push(result.value);
			}
		}

		logger.debug(
			{
				total: enabledConfigs.length,
				cached: cached.length,
				newlyCreated: created.length
			},
			'getEnabledIndexers batch result'
		);

		return [...cached, ...created];
	}

	/** Search across all enabled indexers */
	async search(
		criteria: SearchCriteria,
		options?: SearchOrchestratorOptions
	): Promise<SearchResult> {
		const indexers = await this.getEnabledIndexers();
		const orchestrator = getSearchOrchestrator();
		return orchestrator.search(indexers, criteria, options);
	}

	/**
	 * Enhanced search with quality filtering and optional TMDB matching.
	 * Returns enriched releases with parsed metadata and quality scores.
	 */
	async searchEnhanced(
		criteria: SearchCriteria,
		options?: SearchOrchestratorOptions
	): Promise<EnhancedSearchResult> {
		const indexers = await this.getEnabledIndexers();
		const orchestrator = getSearchOrchestrator();
		return orchestrator.searchEnhanced(indexers, criteria, options);
	}

	/** Test an indexer's connectivity (YAML-only) */
	async testIndexer(config: Omit<IndexerConfig, 'id'>, statusIndexerId?: string): Promise<void> {
		const definition = this.definitionLoader.get(config.definitionId);
		if (!definition) {
			throw new Error(`Unknown definition: ${config.definitionId}`);
		}

		const tempConfig: IndexerConfig = {
			...config,
			id: 'test-' + randomUUID()
		};

		const instance = await this.createIndexerInstance(tempConfig);
		if (!instance) {
			throw new Error(`Failed to create indexer instance for: ${config.definitionId}`);
		}

		const startedAt = Date.now();
		await instance.test();

		// If this test is for an existing saved indexer, update health status on success.
		if (statusIndexerId) {
			await getPersistentStatusTracker().recordSuccess(statusIndexerId, Date.now() - startedAt);
		}
	}

	/** Get capabilities for a definition (YAML-only) */
	getDefinitionCapabilities(definitionId: string): IndexerCapabilities | undefined {
		const definition = this.definitionLoader.get(definitionId);
		if (!definition) return undefined;

		return this.buildCapabilities(definition);
	}

	/** Get required settings fields for a definition (YAML-only) */
	getDefinitionSettings(
		definitionId: string
	): Array<{ name: string; type: string; label: string; default?: string }> {
		return this.indexerFactory.getRequiredSettings(definitionId);
	}

	/** Get all available definitions with metadata (YAML-only) */
	getAvailableDefinitions(): Array<{
		id: string;
		name: string;
		type: string;
		language?: string;
		description?: string;
		protocol?: string;
	}> {
		return this.indexerFactory.getAllDefinitionMetadata();
	}

	/** Search definitions by name */
	searchDefinitions(query: string): YamlDefinition[] {
		return this.definitionLoader.searchByName(query);
	}

	/** Get definitions by type */
	getDefinitionsByType(type: 'public' | 'private' | 'semi-private'): YamlDefinition[] {
		return this.definitionLoader.getByType(type);
	}

	/** Convert database row to IndexerConfig */
	private rowToConfig(row: typeof indexersTable.$inferSelect): IndexerConfig {
		// Get protocol from YAML definition, but allow settings.protocol to override
		// (used by prowlarr indexers which can be torrent or usenet per-indexer).
		const definition = this.definitionLoader.get(row.definitionId);
		const settingsProtocol = (row.settings as Record<string, unknown> | null)?.protocol;
		const protocol =
			settingsProtocol === 'usenet' || settingsProtocol === 'torrent'
				? (settingsProtocol as 'usenet' | 'torrent')
				: (definition?.protocol ?? 'torrent');

		// Extract torrent-specific settings from protocolSettings JSON
		const protocolSettings = row.protocolSettings as {
			minimumSeeders?: number;
			seedRatio?: string | null; // Stored as string (e.g., "1.5")
			seedTime?: number | null;
			packSeedTime?: number | null;
			rejectDeadTorrents?: boolean;
			rejectPasswordProtected?: boolean;
			minimumCompletionPercentage?: number;
		} | null;

		return {
			id: row.id,
			name: row.name,
			definitionId: row.definitionId,
			enabled: !!row.enabled,
			upstreamEnabled: row.upstreamEnabled ?? null,
			orphaned: !!row.orphaned,
			isBuiltIn: !!row.isBuiltIn,
			baseUrl: row.baseUrl,
			alternateUrls: row.alternateUrls ?? [],
			priority: row.priority ?? 25,
			rateLimitPerMinute: row.rateLimitPerMinute ?? null,
			protocol,
			// Note: cinephage-stream's settings JSON is no longer used as a
			// source of truth after migration 103 — its config lives in the
			// CinephageAPI subsystem tables. The row's settings are null/empty.
			settings: decryptIndexerSettings(
				row.id,
				(row.settings as Record<string, unknown> | null) ?? {}
			) as Record<string, string>,

			// Search capability toggles
			enableAutomaticSearch: row.enableAutomaticSearch ?? true,
			enableInteractiveSearch: row.enableInteractiveSearch ?? true,

			// Torrent seeding settings (from protocolSettings JSON)
			minimumSeeders: protocolSettings?.minimumSeeders ?? 1,
			seedRatio: protocolSettings?.seedRatio ?? null,
			seedTime: protocolSettings?.seedTime ?? null,
			packSeedTime: protocolSettings?.packSeedTime ?? null,
			rejectDeadTorrents: protocolSettings?.rejectDeadTorrents ?? true,

			// Usenet settings (from protocolSettings JSON)
			rejectPasswordProtected: protocolSettings?.rejectPasswordProtected ?? true,
			minimumCompletionPercentage: protocolSettings?.minimumCompletionPercentage ?? 95,

			// Newznab/Torznab category data
			cachedCategories: row.cachedCategories ?? undefined,
			additionalCategories: row.additionalCategories ?? undefined
		};
	}

	/** Build capabilities from YAML definition */
	private buildCapabilities(definition: YamlDefinition): IndexerCapabilities {
		return buildCapabilitiesFromYaml({
			modes: definition.caps.modes ?? {},
			categories: definition.caps.categories,
			categorymappings: definition.caps.categorymappings,
			supportsInfoHash: true
		});
	}
}

/** Singleton instance */
let managerInstance: IndexerManager | null = null;

/** Get the singleton IndexerManager */
export async function getIndexerManager(): Promise<IndexerManager> {
	if (!managerInstance) {
		managerInstance = new IndexerManager();
		await managerInstance.initialize();
	}
	return managerInstance;
}

/** Reset the singleton (for testing) */
export function resetIndexerManager(): void {
	managerInstance = null;
}
