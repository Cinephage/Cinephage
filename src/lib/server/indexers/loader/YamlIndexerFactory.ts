/**
 * YAML Indexer Factory
 * Creates UnifiedIndexer instances from database configs and YAML definitions.
 *
 * The UnifiedIndexer correctly handles all three protocols (torrent, usenet, streaming)
 * by reading the protocol from the YAML definition.
 */

import type { IIndexer, IIndexerFactory, IndexerConfig } from '../types';
import type { YamlDefinition } from '../schema/yamlDefinition';
import type { IndexerRecord } from '#lib/server/db/schema.js';
import { UnifiedIndexer } from '../runtime/UnifiedIndexer';
import { YamlDefinitionLoader, getYamlDefinitionLoader } from './YamlDefinitionLoader';
import { yamlToUnifiedDefinition } from './types';
import { createChildLogger } from '#lib/logging/index.js';
import {
	DEFAULT_CAPABILITIES,
	getNewznabCapabilitiesProvider
} from '../newznab/NewznabCapabilitiesProvider';

const log = createChildLogger({ module: 'YamlIndexerFactory' });

/** Definition IDs that use the Newznab protocol */
const NEWZNAB_DEFINITIONS = ['newznab', 'torznab'];

/**
 * Factory for creating YAML-based indexer instances.
 */
export class YamlIndexerFactory implements IIndexerFactory {
	private definitionLoader: YamlDefinitionLoader;
	private indexerCache: Map<string, UnifiedIndexer> = new Map();

	constructor(definitionLoader: YamlDefinitionLoader) {
		this.definitionLoader = definitionLoader;
	}

	/**
	 * Check if this factory can handle a definition.
	 */
	canHandle(definitionId: string): boolean {
		return this.definitionLoader.hasDefinition(definitionId);
	}

	/**
	 * Create an indexer instance from config.
	 * Uses UnifiedIndexer which correctly handles all protocols (torrent, usenet, streaming).
	 * For Newznab indexers, fetches live capabilities to filter unsupported params.
	 */
	async createIndexer(config: IndexerConfig): Promise<IIndexer> {
		// Check cache first
		const cached = this.indexerCache.get(config.id);
		if (cached) {
			return cached;
		}

		// Get definition
		const definition = this.definitionLoader.getDefinition(config.definitionId);
		if (!definition) {
			throw new Error(`Definition not found: ${config.definitionId}`);
		}

		// Build IndexerRecord from IndexerConfig
		// This adapts the IndexerConfig interface to what UnifiedIndexer expects
		// Filter out undefined values from settings (IndexerRecord doesn't allow undefined)
		const cleanSettings = config.settings
			? (Object.fromEntries(
					Object.entries(config.settings).filter(([, v]) => v !== undefined)
				) as Record<string, string | boolean | number>)
			: null;

		const record: IndexerRecord = {
			id: config.id,
			name: config.name,
			definitionId: config.definitionId,
			enabled: config.enabled,
			upstreamEnabled: config.upstreamEnabled ?? null,
			orphaned: config.orphaned ?? false,
			isBuiltIn: config.isBuiltIn ?? false,
			baseUrl: config.baseUrl,
			alternateUrls: config.alternateUrls ?? null,
			priority: config.priority ?? 25,
			rateLimitPerMinute: config.rateLimitPerMinute ?? null,
			enableAutomaticSearch: config.enableAutomaticSearch,
			enableInteractiveSearch: config.enableInteractiveSearch,
			settings: cleanSettings,
			protocolSettings: null, // Will be set below if needed
			cachedCategories: null,
			additionalCategories: config.additionalCategories ?? null,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		};

		// Build protocol settings from config (for torrent indexers)
		let protocolSettings = undefined;
		if (definition.protocol === 'torrent') {
			protocolSettings = {
				minimumSeeders: config.minimumSeeders ?? 1,
				seedRatio: config.seedRatio ?? null,
				seedTime: config.seedTime ?? null,
				packSeedTime: config.packSeedTime ?? null,
				rejectDeadTorrents: config.rejectDeadTorrents ?? true
			};
		}

		// For Newznab/Torznab, fetch live capabilities from the indexer's caps endpoint.
		// This allows us to filter out unsupported search params (e.g., tmdbid if not supported).
		// For torznab, auto-discover the correct endpoint first so bare host URLs work.
		let liveCapabilities;
		if (NEWZNAB_DEFINITIONS.includes(config.definitionId)) {
			try {
				const provider = getNewznabCapabilitiesProvider();
				const rawApiKey = cleanSettings?.apikey;
				const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : undefined;

				let resolvedBaseUrl = config.baseUrl;
				if (config.definitionId === 'torznab') {
					resolvedBaseUrl = await provider.resolveTorznabBaseUrl(config.baseUrl, apiKey);
					if (resolvedBaseUrl !== config.baseUrl) {
						record.baseUrl = resolvedBaseUrl;
					}
				}

				liveCapabilities = await provider.getCapabilities(resolvedBaseUrl, apiKey);
				log.info(
					{
						indexerId: config.id,
						baseUrl: resolvedBaseUrl,
						movieSearch: liveCapabilities.searching.movieSearch.supportedParams,
						tvSearch: liveCapabilities.searching.tvSearch.supportedParams
					},
					'Fetched Newznab/Torznab capabilities'
				);
			} catch (error) {
				// Log but don't fail - indexer will work, just without param filtering
				log.warn(
					{
						indexerId: config.id,
						error: error instanceof Error ? error.message : String(error)
					},
					'Failed to fetch Newznab/Torznab capabilities, using defaults'
				);
			}
		} else if (config.definitionId === 'prowlarr' && cleanSettings?.aggregate !== true) {
			// Each imported Prowlarr indexer exposes its tracker's real caps on
			// Prowlarr's per-indexer Newznab endpoint ({baseUrl}/api?t=caps). They decide
			// which IDs are sent as query tokens. The aggregate indexer has no single set
			// of caps and stays on the definition's text-only baseline.
			const rawApiKey = cleanSettings?.apikey;
			const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : undefined;
			const caps = await getNewznabCapabilitiesProvider().getCapabilities(config.baseUrl, apiKey);
			// getCapabilities() returns generic Newznab defaults when the fetch fails.
			// Those claim ID support the tracker may lack (and Prowlarr skips a tracker
			// asked for an unsupported ID), so keep the text-only baseline instead.
			if (caps !== DEFAULT_CAPABILITIES) {
				liveCapabilities = caps;
				log.info(
					{
						indexerId: config.id,
						movieSearch: caps.searching.movieSearch.supportedParams,
						tvSearch: caps.searching.tvSearch.supportedParams
					},
					'Fetched Prowlarr indexer capabilities'
				);
			} else {
				log.warn(
					{ indexerId: config.id },
					'Could not fetch Prowlarr indexer capabilities, searching by title only'
				);
			}
		}

		// Create indexer using UnifiedIndexer
		const indexer = new UnifiedIndexer({
			record,
			settings: cleanSettings ?? {},
			protocolSettings,
			definition,
			rateLimit: config.rateLimitPerMinute
				? { requests: config.rateLimitPerMinute, periodMs: 60_000 }
				: definition.requestdelay
					? { requests: 1, periodMs: definition.requestdelay * 1000 }
					: undefined,
			liveCapabilities,
			additionalCategories: config.additionalCategories
		});

		// Cache it
		this.indexerCache.set(config.id, indexer);

		log.debug(
			{
				id: config.id,
				definitionId: config.definitionId,
				protocol: definition.protocol
			},
			'Created indexer'
		);

		return indexer;
	}

	/**
	 * Remove an indexer from the cache.
	 */
	removeIndexer(id: string): void {
		this.indexerCache.delete(id);
	}

	/**
	 * Clear all cached indexers.
	 */
	clearCache(): void {
		this.indexerCache.clear();
	}

	/**
	 * Get all available definition IDs.
	 */
	getAvailableDefinitions(): string[] {
		return this.definitionLoader.getAllIds();
	}

	/**
	 * Get definition metadata for UI display.
	 */
	getDefinitionMetadata(
		definitionId: string
	): { name: string; type: string; language?: string; description?: string } | null {
		const definition = this.definitionLoader.getDefinition(definitionId);
		if (!definition) return null;

		return {
			name: definition.name,
			type: definition.type,
			language: definition.language,
			description: definition.description
		};
	}

	/**
	 * Get all definition metadata.
	 */
	getAllDefinitionMetadata(): Array<{
		id: string;
		name: string;
		type: string;
		language?: string;
		description?: string;
	}> {
		return this.definitionLoader.getAllDefinitions().map((def) => ({
			id: def.id,
			name: def.name,
			type: def.type,
			language: def.language,
			description: def.description
		}));
	}

	/**
	 * Get required settings fields for a definition.
	 * Uses the unified conversion which handles login-based defaults.
	 */
	getRequiredSettings(definitionId: string): Array<{
		name: string;
		type: string;
		label: string;
		default?: string;
	}> {
		const definition = this.definitionLoader.getDefinition(definitionId);
		if (!definition) return [];

		// Use unified conversion which handles login defaults centrally
		const unified = yamlToUnifiedDefinition(definition);

		return unified.settings.map((s) => ({
			name: s.name,
			type: s.type ?? 'text',
			label: s.label ?? s.name,
			default: s.default !== undefined ? String(s.default) : undefined
		}));
	}

	/**
	 * Get the full definition for a given ID.
	 */
	getDefinition(definitionId: string): YamlDefinition | undefined {
		return this.definitionLoader.getDefinition(definitionId);
	}

	/**
	 * Reload all definitions.
	 */
	async reloadDefinitions(): Promise<void> {
		await this.definitionLoader.reloadAll();
		// Clear cache since definitions may have changed
		this.clearCache();
	}
}

/**
 * Singleton instance of the factory.
 */
let factoryInstance: YamlIndexerFactory | null = null;

/**
 * Gets the singleton factory instance, initializing if necessary.
 */
export async function getYamlIndexerFactory(
	definitionsPath?: string[]
): Promise<YamlIndexerFactory> {
	if (!factoryInstance) {
		const loader = await getYamlDefinitionLoader(definitionsPath);
		factoryInstance = new YamlIndexerFactory(loader);
	}

	return factoryInstance;
}

/**
 * Resets the singleton factory (useful for testing).
 */
export function resetYamlIndexerFactory(): void {
	factoryInstance = null;
}
