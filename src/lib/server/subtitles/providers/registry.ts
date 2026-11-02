/**
 * Provider Auto-Discovery and Registration
 *
 * Automatically discovers and registers subtitle providers from the providers directory.
 * Based on Bazarr's provider discovery pattern.
 *
 * Each provider directory should export:
 * - A provider class implementing ISubtitleProvider
 * - A PROVIDER_INFO object with metadata
 */

import type { ISubtitleProvider, ProviderDefinition } from './interfaces';
import type { SubtitleProviderConfig } from '../types';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });

/** Provider constructor type */
export type ProviderConstructor = new (config: SubtitleProviderConfig) => ISubtitleProvider;

/**
 * Provider info exported by each provider module
 */
export interface ProviderInfo {
	/** Unique implementation identifier */
	implementation: string;
	/** Provider class constructor */
	providerClass: ProviderConstructor;
	/** Provider definition/metadata */
	definition: ProviderDefinition;
}

/**
 * Provider Registry - stores discovered providers
 */
class ProviderRegistry {
	private readonly providers = new Map<string, ProviderConstructor>();
	private readonly definitions = new Map<string, ProviderDefinition>();
	private initialized = false;

	/**
	 * Register a provider
	 */
	register(info: ProviderInfo): void {
		const { implementation, providerClass, definition } = info;

		if (this.providers.has(implementation)) {
			logger.warn(`Provider ${implementation} already registered, skipping`);
			return;
		}

		this.providers.set(implementation, providerClass);
		this.definitions.set(implementation, definition);

		logger.debug(`Registered provider: ${implementation}`);
	}

	/**
	 * Get a provider constructor
	 */
	getProvider(implementation: string): ProviderConstructor | undefined {
		return this.providers.get(implementation);
	}

	/**
	 * Get a provider definition
	 */
	getDefinition(implementation: string): ProviderDefinition | undefined {
		return this.definitions.get(implementation);
	}

	/**
	 * Get all registered implementations
	 */
	getImplementations(): string[] {
		return Array.from(this.providers.keys());
	}

	/**
	 * Get all definitions
	 */
	getAllDefinitions(): ProviderDefinition[] {
		return Array.from(this.definitions.values());
	}

	/**
	 * Check if a provider is registered
	 */
	has(implementation: string): boolean {
		return this.providers.has(implementation);
	}

	/**
	 * Create a provider instance
	 */
	createProvider(config: SubtitleProviderConfig): ISubtitleProvider {
		const ProviderClass = this.providers.get(config.implementation as string);

		if (!ProviderClass) {
			throw new Error(`Unknown provider implementation: ${config.implementation}`);
		}

		return new ProviderClass(config);
	}

	/**
	 * Mark as initialized
	 */
	setInitialized(): void {
		this.initialized = true;
	}

	/**
	 * Check if initialized
	 */
	isInitialized(): boolean {
		return this.initialized;
	}

	/**
	 * Get provider count
	 */
	get count(): number {
		return this.providers.size;
	}
}

/** Global provider registry instance */
export const providerRegistry = new ProviderRegistry();

/**
 * Register all built-in providers
 *
 * Called during application startup to register all known providers.
 * This is the manual registration approach - each provider exports its info.
 */
export async function registerBuiltinProviders(): Promise<void> {
	if (providerRegistry.isInitialized()) {
		return;
	}

	try {
		// Import and register OpenSubtitles
		const opensubtitles = await import('./opensubtitles');
		if (opensubtitles.PROVIDER_INFO) {
			providerRegistry.register(opensubtitles.PROVIDER_INFO);
		}
	} catch (error) {
		logger.warn({ error }, 'Failed to register opensubtitles provider');
	}

	try {
		// Import and register OpenSubtitles.org (legacy)
		const opensubtitlesorg = await import('./opensubtitlesorg');
		if (opensubtitlesorg.PROVIDER_INFO) {
			providerRegistry.register(opensubtitlesorg.PROVIDER_INFO);
		}
	} catch (error) {
		logger.warn({ error }, 'Failed to register opensubtitlesorg provider');
	}

	try {
		// Import and register Addic7ed
		const addic7ed = await import('./addic7ed');
		if (addic7ed.PROVIDER_INFO) {
			providerRegistry.register(addic7ed.PROVIDER_INFO);
		}
	} catch (error) {
		logger.warn({ error }, 'Failed to register addic7ed provider');
	}

	try {
		// Import and register SubDL
		const subdl = await import('./subdl');
		if (subdl.PROVIDER_INFO) {
			providerRegistry.register(subdl.PROVIDER_INFO);
		}
	} catch (error) {
		logger.warn({ error }, 'Failed to register subdl provider');
	}

	try {
		// Import and register YIFY Subtitles
		const yifysubtitles = await import('./yifysubtitles');
		if (yifysubtitles.PROVIDER_INFO) {
			providerRegistry.register(yifysubtitles.PROVIDER_INFO);
		}
	} catch (error) {
		logger.warn({ error }, 'Failed to register yifysubtitles provider');
	}

	try {
		// Import and register Gestdown
		const gestdown = await import('./gestdown');
		if (gestdown.PROVIDER_INFO) {
			providerRegistry.register(gestdown.PROVIDER_INFO);
		}
	} catch (error) {
		logger.warn({ error }, 'Failed to register gestdown provider');
	}

	try {
		// Import and register Subf2m
		const subf2m = await import('./subf2m');
		if (subf2m.PROVIDER_INFO) {
			providerRegistry.register(subf2m.PROVIDER_INFO);
		}
	} catch (error) {
		logger.warn({ error }, 'Failed to register subf2m provider');
	}

	try {
		// Import and register Super Subtitles (feliratok.eu)
		const supersubtitles = await import('./supersubtitles');
		if (supersubtitles.PROVIDER_INFO) {
			providerRegistry.register(supersubtitles.PROVIDER_INFO);
		}
	} catch (error) {
		logger.warn({ error }, 'Failed to register supersubtitles provider');
	}

	try {
		// Import and register Podnapisi (Slovenian)
		const podnapisi = await import('./podnapisi');
		if (podnapisi.PROVIDER_INFO) {
			providerRegistry.register(podnapisi.PROVIDER_INFO);
		}
	} catch (error) {
		logger.warn({ error }, 'Failed to register podnapisi provider');
	}

	// Regional providers
	try {
		// Import and register Napiprojekt (Polish)
		const napiprojekt = await import('./napiprojekt');
		if (napiprojekt.PROVIDER_INFO) {
			providerRegistry.register(napiprojekt.PROVIDER_INFO);
		}
	} catch (error) {
		logger.warn({ error }, 'Failed to register napiprojekt provider');
	}

	try {
		// Import and register Legendasdivx (Portuguese)
		const legendasdivx = await import('./legendasdivx');
		if (legendasdivx.PROVIDER_INFO) {
			providerRegistry.register(legendasdivx.PROVIDER_INFO);
		}
	} catch (error) {
		logger.warn({ error }, 'Failed to register legendasdivx provider');
	}

	try {
		// Import and register Betaseries (French)
		const betaseries = await import('./betaseries');
		if (betaseries.PROVIDER_INFO) {
			providerRegistry.register(betaseries.PROVIDER_INFO);
		}
	} catch (error) {
		logger.warn({ error }, 'Failed to register betaseries provider');
	}

	try {
		// Import and register Assrt (Chinese)
		const assrt = await import('./assrt');
		if (assrt.PROVIDER_INFO) {
			providerRegistry.register(assrt.PROVIDER_INFO);
		}
	} catch (error) {
		logger.warn({ error }, 'Failed to register assrt provider');
	}

	providerRegistry.setInitialized();

	logger.info(`Provider registry initialized with ${providerRegistry.count} providers`);
}

/**
 * Ensure providers are registered (lazy initialization)
 */
export async function ensureProvidersRegistered(): Promise<void> {
	if (!providerRegistry.isInitialized()) {
		await registerBuiltinProviders();
	}
}
