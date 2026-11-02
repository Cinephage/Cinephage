/**
 * External List Provider Registry
 *
 * Registry for managing external list providers
 */

import type { ExternalListProvider } from './types.js';
import { JsonListProvider } from './JsonListProvider.js';
import { ImdbListProvider } from './ImdbListProvider.js';
import { TmdbListProvider } from './TmdbListProvider.js';

class ProviderRegistry {
	private providers = new Map<string, ExternalListProvider>();

	constructor() {
		// Register built-in providers
		this.register(new JsonListProvider());
		this.register(new ImdbListProvider());
		this.register(new TmdbListProvider());
	}

	/**
	 * Register a provider
	 */
	register(provider: ExternalListProvider): void {
		this.providers.set(provider.type, provider);
		logger.debug(
			{
				type: provider.type,
				name: provider.name
			},
			'[ProviderRegistry] Registered provider'
		);
	}

	/**
	 * Get a provider by type
	 */
	get(type: string): ExternalListProvider | undefined {
		return this.providers.get(type);
	}

	/**
	 * Get all registered providers
	 */
	getAll(): ExternalListProvider[] {
		return Array.from(this.providers.values());
	}

	/**
	 * Check if a provider exists
	 */
	has(type: string): boolean {
		return this.providers.has(type);
	}

	/**
	 * Validate configuration for a provider type
	 */
	validateConfig(type: string, config: unknown): boolean {
		const provider = this.get(type);
		if (!provider) {
			return false;
		}
		return provider.validateConfig(config);
	}
}

// Singleton instance
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'monitoring' as const });
export const providerRegistry = new ProviderRegistry();
