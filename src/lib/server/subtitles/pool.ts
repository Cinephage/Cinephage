/**
 * Subtitle Provider Pool - Based on Bazarr/Subliminal architecture
 *
 * Manages multiple provider instances with:
 * - Lazy initialization
 * - Lifecycle management (auto-terminate after timeout)
 * - Discarded providers tracking
 * - Pre/post download hooks
 * - Blacklist integration
 */

import type { ISubtitleProvider } from './providers/interfaces';
import type { SubtitleProviderConfig, LanguageCode } from './types';
import type { Subtitle } from './subtitle';
import type { Video } from './video';
import type { LanguageEquivalencePair } from './language';
import { BaseSubtitleProvider } from './providers/BaseProvider';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });

/**
 * Pool configuration
 */
export interface ProviderPoolConfig {
	/** Provider configurations */
	providerConfigs: Map<string, SubtitleProviderConfig>;

	/** Provider factory function */
	createProvider: (config: SubtitleProviderConfig) => ISubtitleProvider;

	/** Blacklisted subtitle IDs */
	blacklist?: Set<string>;

	/** Ban list for release groups/uploaders */
	banList?: BanList;

	/** Maximum pool lifetime in milliseconds (default: 12 hours) */
	maxLifetime?: number;

	/** Callback when provider is throttled */
	throttleCallback?: ThrottleCallback;

	/** Hook called before downloading */
	preDownloadHook?: PreDownloadHook;

	/** Hook called after downloading */
	postDownloadHook?: PostDownloadHook;

	/** Language equivalence pairs */
	languageEquivalences?: LanguageEquivalencePair[];
}

/**
 * Ban list for filtering unwanted releases
 */
export interface BanList {
	/** Banned release groups */
	releaseGroups?: string[];
	/** Banned uploaders */
	uploaders?: string[];
	/** Banned keywords in release name */
	keywords?: string[];
}

/**
 * Throttle callback type
 */
export type ThrottleCallback = (providerName: string, error: Error, throttleUntil: Date) => void;

/**
 * Pre-download hook type
 */
export type PreDownloadHook = (subtitle: Subtitle, video: Video) => Promise<boolean>; // Return false to cancel download

/**
 * Post-download hook type
 */
export type PostDownloadHook = (
	subtitle: Subtitle,
	video: Video,
	content: Buffer
) => Promise<Buffer>; // Can modify content

/**
 * Provider Pool - manages multiple subtitle providers
 *
 * Based on Bazarr's subliminal_patch/core.py SZProviderPool
 */
export class SubtitleProviderPool {
	/** Available provider names */
	private readonly providers: Set<string>;

	/** Provider configurations */
	private readonly providerConfigs: Map<string, SubtitleProviderConfig>;

	/** Factory function for creating providers */
	private readonly createProvider: (config: SubtitleProviderConfig) => ISubtitleProvider;

	/** Initialized provider instances */
	private readonly initializedProviders: Map<string, ISubtitleProvider> = new Map();

	/** Providers that failed and were discarded */
	private readonly discardedProviders: Set<string> = new Set();

	/** Blacklisted subtitle IDs */
	private readonly blacklist: Set<string>;

	/** Ban list */
	private readonly banList: BanList;

	/** Pool creation time */
	private readonly createdAt: Date;

	/** Maximum lifetime in milliseconds */
	private readonly maxLifetime: number;

	/** Throttle callback */
	private readonly throttleCallback?: ThrottleCallback;

	/** Pre-download hook */
	private readonly preDownloadHook?: PreDownloadHook;

	/** Post-download hook */
	private readonly postDownloadHook?: PostDownloadHook;

	/** Language equivalences */
	private readonly languageEquivalences: Map<string, Set<string>> = new Map();

	constructor(config: ProviderPoolConfig) {
		this.providers = new Set(config.providerConfigs.keys());
		this.providerConfigs = config.providerConfigs;
		this.createProvider = config.createProvider;
		this.blacklist = config.blacklist ?? new Set();
		this.banList = config.banList ?? {};
		this.maxLifetime = config.maxLifetime ?? 12 * 60 * 60 * 1000; // 12 hours
		this.throttleCallback = config.throttleCallback;
		this.preDownloadHook = config.preDownloadHook;
		this.postDownloadHook = config.postDownloadHook;
		this.createdAt = new Date();

		// Build language equivalence map
		if (config.languageEquivalences) {
			for (const pair of config.languageEquivalences) {
				if (!this.languageEquivalences.has(pair.from)) {
					this.languageEquivalences.set(pair.from, new Set());
				}
				this.languageEquivalences.get(pair.from)!.add(pair.to);
			}
		}
	}

	/**
	 * Get a provider instance (lazy initialization)
	 */
	async getProvider(name: string): Promise<ISubtitleProvider> {
		// Check if provider exists
		if (!this.providers.has(name)) {
			throw new Error(`Unknown provider: ${name}`);
		}

		// Check if discarded
		if (this.discardedProviders.has(name)) {
			throw new Error(`Provider ${name} has been discarded`);
		}

		// Check if already initialized
		if (this.initializedProviders.has(name)) {
			return this.initializedProviders.get(name)!;
		}

		// Lazy initialize
		const config = this.providerConfigs.get(name)!;
		logger.info(`Initializing provider: ${name}`);

		try {
			const provider = this.createProvider(config);

			// Initialize if it's a BaseSubtitleProvider
			if (provider instanceof BaseSubtitleProvider) {
				await provider.initialize();
			}

			this.initializedProviders.set(name, provider);
			return provider;
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				`Failed to initialize provider ${name}`
			);
			this.discardedProviders.add(name);
			throw error;
		}
	}

	/**
	 * Get all available (non-discarded) provider names
	 */
	getAvailableProviders(): string[] {
		return [...this.providers].filter((name) => !this.discardedProviders.has(name));
	}

	/**
	 * Get all initialized provider names
	 */
	getInitializedProviders(): string[] {
		return [...this.initializedProviders.keys()];
	}

	/**
	 * Check if a provider is available
	 */
	isProviderAvailable(name: string): boolean {
		return this.providers.has(name) && !this.discardedProviders.has(name);
	}

	/**
	 * Discard a provider (remove from active use)
	 */
	async discardProvider(name: string, reason?: string): Promise<void> {
		logger.warn({ reason }, `Discarding provider: ${name}`);

		this.discardedProviders.add(name);

		// Terminate if initialized
		const provider = this.initializedProviders.get(name);
		if (provider && provider instanceof BaseSubtitleProvider) {
			await provider.terminate();
		}
		this.initializedProviders.delete(name);
	}

	/**
	 * Handle provider throttling
	 */
	handleThrottle(name: string, error: Error, throttleUntil: Date): void {
		logger.warn(`Provider ${name} throttled until ${throttleUntil.toISOString()}`);

		if (this.throttleCallback) {
			this.throttleCallback(name, error, throttleUntil);
		}
	}

	/**
	 * Check if a subtitle is blacklisted
	 */
	isBlacklisted(subtitleId: string): boolean {
		return this.blacklist.has(subtitleId);
	}

	/**
	 * Add subtitle to blacklist
	 */
	addToBlacklist(subtitleId: string): void {
		this.blacklist.add(subtitleId);
	}

	/**
	 * Check if a release should be banned
	 */
	isBanned(subtitle: Subtitle): boolean {
		const releaseName = subtitle.releaseInfo?.toLowerCase() ?? '';
		const uploader = subtitle.uploader?.toLowerCase() ?? '';

		// Check release groups
		if (this.banList.releaseGroups) {
			for (const group of this.banList.releaseGroups) {
				if (releaseName.includes(group.toLowerCase())) {
					return true;
				}
			}
		}

		// Check uploaders
		if (this.banList.uploaders) {
			for (const banned of this.banList.uploaders) {
				if (uploader === banned.toLowerCase()) {
					return true;
				}
			}
		}

		// Check keywords
		if (this.banList.keywords) {
			for (const keyword of this.banList.keywords) {
				if (releaseName.includes(keyword.toLowerCase())) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Get equivalent languages for a given language code
	 */
	getEquivalentLanguages(language: LanguageCode): LanguageCode[] {
		const equivalents = this.languageEquivalences.get(language);
		if (equivalents) {
			return [language, ...equivalents];
		}
		return [language];
	}

	/**
	 * Execute pre-download hook
	 */
	async executePreDownloadHook(subtitle: Subtitle, video: Video): Promise<boolean> {
		if (this.preDownloadHook) {
			return await this.preDownloadHook(subtitle, video);
		}
		return true;
	}

	/**
	 * Execute post-download hook
	 */
	async executePostDownloadHook(
		subtitle: Subtitle,
		video: Video,
		content: Buffer
	): Promise<Buffer> {
		if (this.postDownloadHook) {
			return await this.postDownloadHook(subtitle, video, content);
		}
		return content;
	}

	/**
	 * Check if pool has expired (exceeded max lifetime)
	 */
	isExpired(): boolean {
		const age = Date.now() - this.createdAt.getTime();
		return age > this.maxLifetime;
	}

	/**
	 * Get pool age in milliseconds
	 */
	getAge(): number {
		return Date.now() - this.createdAt.getTime();
	}

	/**
	 * Terminate all initialized providers
	 */
	async terminate(): Promise<void> {
		logger.debug('Terminating provider pool');

		const terminatePromises: Promise<void>[] = [];

		for (const [name, provider] of this.initializedProviders) {
			if (provider instanceof BaseSubtitleProvider) {
				terminatePromises.push(
					provider.terminate().catch((error) => {
						logger.warn(
							{
								error: error instanceof Error ? error.message : String(error)
							},
							`Error terminating provider ${name}`
						);
					})
				);
			}
		}

		await Promise.all(terminatePromises);
		this.initializedProviders.clear();
	}
}

/**
 * Pool Manager - manages multiple pools (e.g., per profile or media type)
 *
 * Based on Bazarr's pool management in subtitles/pool.py
 */
export class PoolManager {
	private readonly pools: Map<string, SubtitleProviderPool> = new Map();
	private readonly createPoolConfig: () => ProviderPoolConfig;
	private cleanupInterval?: ReturnType<typeof setInterval>;

	constructor(createPoolConfig: () => ProviderPoolConfig) {
		this.createPoolConfig = createPoolConfig;

		// Start cleanup interval (every 30 minutes)
		this.cleanupInterval = setInterval(
			() => {
				this.cleanupExpiredPools();
			},
			30 * 60 * 1000
		);
	}

	/**
	 * Get or create a pool for a given key
	 */
	getPool(key: string): SubtitleProviderPool {
		let pool = this.pools.get(key);

		// Create new pool if doesn't exist or expired
		if (!pool || pool.isExpired()) {
			if (pool) {
				// Terminate expired pool
				pool.terminate().catch(() => {});
			}

			pool = new SubtitleProviderPool(this.createPoolConfig());
			this.pools.set(key, pool);
		}

		return pool;
	}

	/**
	 * Get default pool (key: 'default')
	 */
	getDefaultPool(): SubtitleProviderPool {
		return this.getPool('default');
	}

	/**
	 * Cleanup expired pools
	 */
	private cleanupExpiredPools(): void {
		for (const [key, pool] of this.pools) {
			if (pool.isExpired()) {
				logger.debug(`Cleaning up expired pool: ${key}`);
				pool.terminate().catch(() => {});
				this.pools.delete(key);
			}
		}
	}

	/**
	 * Terminate all pools
	 */
	async terminateAll(): Promise<void> {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
		}

		const terminatePromises: Promise<void>[] = [];

		for (const pool of this.pools.values()) {
			terminatePromises.push(pool.terminate());
		}

		await Promise.all(terminatePromises);
		this.pools.clear();
	}
}
