/**
 * Subtitle Provider Manager
 *
 * Central service for managing subtitle providers.
 * Handles CRUD operations, instance caching, and health tracking.
 */

import { db } from '#lib/server/db/index.js';
import { subtitleProviders } from '#lib/server/db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '#lib/logging/index.js';
import {
	decryptCredential,
	encryptCredential,
	isEncryptedCredential
} from '#lib/server/crypto/credentialsCrypto.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });

/** AAD purpose for subtitle-provider credentials at rest. */
const SUBTITLE_CRED_PURPOSE = 'subtitle-provider';

function encryptProviderCredential(providerId: string, value: string | null | undefined) {
	if (typeof value === 'string' && value && !isEncryptedCredential(value)) {
		return encryptCredential(SUBTITLE_CRED_PURPOSE, providerId, value);
	}
	return value ?? null;
}

function decryptProviderCredential(
	providerId: string,
	value: string | null | undefined,
	field: string
): string | undefined {
	if (typeof value === 'string' && isEncryptedCredential(value)) {
		return (
			decryptCredential(
				SUBTITLE_CRED_PURPOSE,
				providerId,
				value,
				`subtitle-provider:${providerId}:${field}`
			) ?? undefined
		);
	}
	return value ?? undefined;
}

import type {
	ISubtitleProvider,
	ProviderDefinition,
	ProviderHealth
} from '../providers/interfaces';
import { getSubtitleProviderFactory } from '../providers/SubtitleProviderFactory';
import type { SubtitleProviderConfig, ProviderImplementation } from '../types';
import {
	isThrottleableError,
	getErrorType,
	TooManyRequests,
	DownloadLimitExceeded,
	type ThrottleableError
} from '../errors/ProviderErrors';
import { getThrottleConfig, PROVIDER_RESET_CALCULATORS } from '../throttle/ThrottleMap';
import { RateLimiter } from '../providers/mixins';

/**
 * Transient error types that should use a sliding window gate before throttling.
 * These are temporary issues that may resolve on their own.
 * Based on Bazarr's throttled_count() pattern (5 errors in 120s).
 */
const TRANSIENT_ERROR_NAMES = new Set([
	'TooManyRequests',
	'ServiceUnavailable',
	'APIThrottled',
	'TimeoutError',
	'ConnectionError',
	'ParseResponseError'
]);

/**
 * Hard error types (DownloadLimitExceeded, SearchLimitReached, AuthenticationError,
 * IPAddressBlocked, ConfigurationError) are NOT in the transient set and therefore
 * throttle immediately on first occurrence.
 *
 * A success call must never clear one of these still-active throttles — they
 * only clear at their reset time (quota) or after reconfiguration (auth/config).
 */
const HARD_THROTTLE_ERROR_NAMES = new Set([
	'DownloadLimitExceeded',
	'SearchLimitReached',
	'AuthenticationError',
	'ConfigurationError',
	'IPAddressBlocked'
]);

/** Number of transient errors within the window before throttling */
const TRANSIENT_THROTTLE_COUNT = 5;

/** Sliding window duration in milliseconds (120 seconds) */
const TRANSIENT_WINDOW_MS = 120 * 1000;

/**
 * Central service for managing subtitle providers
 */
export class SubtitleProviderManager {
	private static instance: SubtitleProviderManager | null = null;
	private providerInstances: Map<string, ISubtitleProvider> = new Map();
	private initialized: boolean = false;

	/**
	 * Shared per-provider rate limiters keyed by provider id. A limiter is
	 * created lazily from the stored `requestsPerMinute` and reused for both
	 * search and download calls. Updated providers drop their limiter so the new
	 * rate takes effect.
	 */
	private rateLimiters: Map<string, RateLimiter> = new Map();

	/** The requests-per-minute a cached limiter was built with (for rebuilds). */
	private rateLimiterRpm: Map<string, number> = new Map();

	/**
	 * In-memory sliding window tracker for transient errors per provider.
	 * Key: provider ID, Value: array of error timestamps (epoch ms).
	 * Used to implement Bazarr's throttled_count() pattern:
	 * only throttle after TRANSIENT_THROTTLE_COUNT errors within TRANSIENT_WINDOW_MS.
	 */
	private transientErrorTimestamps: Map<string, number[]> = new Map();

	private constructor() {}

	/**
	 * Get singleton instance
	 */
	static getInstance(): SubtitleProviderManager {
		if (!SubtitleProviderManager.instance) {
			SubtitleProviderManager.instance = new SubtitleProviderManager();
		}
		return SubtitleProviderManager.instance;
	}

	/**
	 * Initialize the manager
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;

		logger.info('Initializing SubtitleProviderManager');

		// Pre-load enabled providers
		const configs = await this.getProviders();
		for (const config of configs.filter((c) => c.enabled)) {
			try {
				await this.getProviderInstance(config.id);
			} catch (error) {
				logger.warn(
					{
						providerId: config.id,
						name: config.name,
						error: error instanceof Error ? error.message : String(error)
					},
					'Failed to initialize provider'
				);
			}
		}

		this.initialized = true;
		logger.info(
			{
				providerCount: configs.length,
				enabledCount: configs.filter((c) => c.enabled).length
			},
			'SubtitleProviderManager initialized'
		);
	}

	// =========================================================================
	// CRUD Operations
	// =========================================================================

	/**
	 * Get all configured providers
	 */
	async getProviders(): Promise<SubtitleProviderConfig[]> {
		const rows = await db.select().from(subtitleProviders);
		return rows.map((row) => this.rowToConfig(row));
	}

	/**
	 * Get a specific provider configuration
	 */
	async getProvider(id: string): Promise<SubtitleProviderConfig | undefined> {
		const rows = await db.select().from(subtitleProviders).where(eq(subtitleProviders.id, id));
		return rows[0] ? this.rowToConfig(rows[0]) : undefined;
	}

	/**
	 * Create a new provider configuration
	 */
	async createProvider(
		config: Omit<SubtitleProviderConfig, 'id' | 'consecutiveFailures'>
	): Promise<SubtitleProviderConfig> {
		const factory = getSubtitleProviderFactory();

		// Validate implementation
		if (!factory.canHandle(config.implementation)) {
			throw new Error(`Unknown provider implementation: ${config.implementation}`);
		}

		const id = randomUUID();

		await db.insert(subtitleProviders).values({
			id,
			name: config.name,
			implementation: config.implementation,
			enabled: config.enabled,
			priority: config.priority,
			apiKey: encryptProviderCredential(id, config.apiKey),
			username: encryptProviderCredential(id, config.username),
			password: encryptProviderCredential(id, config.password),
			settings: config.settings,
			requestsPerMinute: config.requestsPerMinute
		});

		const created = await this.getProvider(id);
		if (!created) {
			throw new Error('Failed to create provider');
		}

		logger.info({ id, name: config.name }, 'Created subtitle provider');
		return created;
	}

	/**
	 * Update a provider configuration
	 */
	async updateProvider(
		id: string,
		updates: Partial<Omit<SubtitleProviderConfig, 'id' | 'implementation'>>
	): Promise<SubtitleProviderConfig> {
		const existing = await this.getProvider(id);
		if (!existing) {
			throw new Error(`Provider not found: ${id}`);
		}

		const updateData: Record<string, unknown> = {
			updatedAt: new Date().toISOString()
		};

		if (updates.name !== undefined) updateData.name = updates.name;
		if (updates.enabled !== undefined) updateData.enabled = updates.enabled;
		if (updates.priority !== undefined) updateData.priority = updates.priority;
		if (updates.apiKey !== undefined)
			updateData.apiKey = encryptProviderCredential(id, updates.apiKey);
		if (updates.username !== undefined)
			updateData.username = encryptProviderCredential(id, updates.username);
		if (updates.password !== undefined)
			updateData.password = encryptProviderCredential(id, updates.password);
		if (updates.settings !== undefined) updateData.settings = updates.settings;
		if (updates.requestsPerMinute !== undefined)
			updateData.requestsPerMinute = updates.requestsPerMinute;

		await db.update(subtitleProviders).set(updateData).where(eq(subtitleProviders.id, id));

		// Clear cached instance so it gets recreated
		this.providerInstances.delete(id);
		this.dropRateLimiter(id);

		const updated = await this.getProvider(id);
		if (!updated) {
			throw new Error('Failed to update provider');
		}

		logger.info({ id, name: updated.name }, 'Updated subtitle provider');
		return updated;
	}

	/**
	 * Delete a provider
	 */
	async deleteProvider(id: string): Promise<void> {
		await db.delete(subtitleProviders).where(eq(subtitleProviders.id, id));
		this.providerInstances.delete(id);
		this.dropRateLimiter(id);
		logger.info({ id }, 'Deleted subtitle provider');
	}

	// =========================================================================
	// Instance Management
	// =========================================================================

	/**
	 * Get or create a provider instance
	 */
	async getProviderInstance(id: string): Promise<ISubtitleProvider | undefined> {
		// Check cache
		let instance = this.providerInstances.get(id);
		if (instance) return instance;

		// Load config
		const config = await this.getProvider(id);
		if (!config) return undefined;

		// Create instance
		const factory = getSubtitleProviderFactory();
		try {
			instance = factory.createProvider(config);
			this.providerInstances.set(id, instance);
			// Prime the shared limiter with the provider's configured rate.
			this.ensureRateLimiter(id, this.resolveRequestsPerMinute(config));
			return instance;
		} catch (error) {
			logger.error(
				{
					providerId: id,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to create provider instance'
			);
			return undefined;
		}
	}

	/**
	 * Get all enabled provider instances
	 */
	async getEnabledProviders(): Promise<ISubtitleProvider[]> {
		const configs = await this.getProviders();
		const enabledConfigs = configs
			.filter((c) => c.enabled && !this.isThrottled(c))
			.sort((a, b) => a.priority - b.priority);

		const instances: ISubtitleProvider[] = [];
		for (const config of enabledConfigs) {
			const instance = await this.getProviderInstance(config.id);
			if (instance) {
				instances.push(instance);
			}
		}

		return instances;
	}

	// =========================================================================
	// Rate limiting
	// =========================================================================

	/**
	 * Resolve the effective requests-per-minute for a provider.
	 *
	 * Precedence: stored `requestsPerMinute` (when > 0) → the definition's
	 * `defaultRequestsPerMinute` → 60. A value <= 0 means "no limit" and callers
	 * skip acquisition.
	 */
	private resolveRequestsPerMinute(config: SubtitleProviderConfig): number {
		if (typeof config.requestsPerMinute === 'number' && config.requestsPerMinute > 0) {
			return config.requestsPerMinute;
		}
		const definitionDefault = this.getDefinition(config.implementation)?.defaultRequestsPerMinute;
		return definitionDefault && definitionDefault > 0 ? definitionDefault : 60;
	}

	/**
	 * Get (or lazily build) the shared rate limiter for a provider.
	 * Returns null when the effective rate is <= 0 (unlimited).
	 */
	private ensureRateLimiter(id: string, requestsPerMinute: number): RateLimiter | null {
		if (!(requestsPerMinute > 0)) {
			this.rateLimiters.delete(id);
			this.rateLimiterRpm.delete(id);
			return null;
		}

		const existing = this.rateLimiters.get(id);
		if (existing && this.rateLimiterRpm.get(id) === requestsPerMinute) {
			return existing;
		}

		const limiter = new RateLimiter(requestsPerMinute);
		this.rateLimiters.set(id, limiter);
		this.rateLimiterRpm.set(id, requestsPerMinute);
		return limiter;
	}

	/**
	 * Await a token from the provider's shared rate limiter before making a
	 * request. Used by search and download paths.
	 */
	async acquireRateLimit(id: string): Promise<void> {
		let limiter: RateLimiter | null | undefined = this.rateLimiters.get(id);
		if (!limiter) {
			const config = await this.getProvider(id);
			const rpm = config ? this.resolveRequestsPerMinute(config) : 60;
			limiter = this.ensureRateLimiter(id, rpm);
		}
		if (limiter) {
			await limiter.acquire();
		}
	}

	/** Drop a cached limiter so it is rebuilt with the current rate. */
	private dropRateLimiter(id: string): void {
		this.rateLimiters.delete(id);
		this.rateLimiterRpm.delete(id);
	}

	/** Test helper: clear all cached rate limiters. */
	clearRateLimitersForTests(): void {
		this.rateLimiters.clear();
		this.rateLimiterRpm.clear();
	}

	/** Test helper: whether the provider's cached limiter has a token ready. */
	canMakeRequestForTests(id: string): boolean {
		const limiter = this.rateLimiters.get(id);
		return limiter ? limiter.canMakeRequest() : false;
	}

	// =========================================================================
	// Health & Status
	// =========================================================================

	/**
	 * Check if a provider is currently throttled
	 */
	isThrottled(config: SubtitleProviderConfig): boolean {
		if (!config.throttledUntil) return false;
		return new Date(config.throttledUntil) > new Date();
	}

	/**
	 * Check if a transient error should trigger throttling based on the sliding window.
	 * Records the error timestamp and returns true if the threshold has been reached
	 * (TRANSIENT_THROTTLE_COUNT errors within TRANSIENT_WINDOW_MS).
	 *
	 * Based on Bazarr's throttled_count() pattern from get_providers.py.
	 */
	private shouldThrottleTransient(providerId: string): boolean {
		const now = Date.now();
		const cutoff = now - TRANSIENT_WINDOW_MS;

		// Get or initialize timestamps array
		let timestamps = this.transientErrorTimestamps.get(providerId);
		if (!timestamps) {
			timestamps = [];
			this.transientErrorTimestamps.set(providerId, timestamps);
		}

		// Prune timestamps outside the window
		const pruned = timestamps.filter((t) => t > cutoff);

		// Record this error
		pruned.push(now);
		this.transientErrorTimestamps.set(providerId, pruned);

		// Check if threshold reached
		return pruned.length >= TRANSIENT_THROTTLE_COUNT;
	}

	/**
	 * Clear transient error tracking for a provider (called on success)
	 */
	private clearTransientErrors(providerId: string): void {
		this.transientErrorTimestamps.delete(providerId);
	}

	/**
	 * Record a provider error with exception-specific throttling
	 *
	 * Hard errors (DownloadLimitExceeded, AuthenticationError, etc.) throttle immediately.
	 * Transient errors (TooManyRequests, ServiceUnavailable, TimeoutError, etc.) use a
	 * sliding window gate: only throttle after 5 errors within 120 seconds.
	 *
	 * @param id Provider ID
	 * @param error Error instance (typed errors get specific throttle durations)
	 */
	async recordError(id: string, error: Error | ThrottleableError | string): Promise<void> {
		const config = await this.getProvider(id);
		if (!config) return;

		// Atomic increment: read-modify-write loses increments when providers
		// fail concurrently (Promise.all tier searches), which under-counts
		// failures and never trips auto-disable.
		db.update(subtitleProviders)
			.set({
				consecutiveFailures: sql`${subtitleProviders.consecutiveFailures} + 1`,
				updatedAt: new Date().toISOString()
			})
			.where(eq(subtitleProviders.id, id))
			.run();
		const refreshed = await this.getProvider(id);
		const failures = refreshed?.consecutiveFailures ?? config.consecutiveFailures + 1;

		let throttledUntil: string | undefined;
		let errorType = 'UnknownError';
		let throttleDescription = 'unknown duration';
		let errorMessage: string;

		// Handle string errors (legacy support)
		if (typeof error === 'string') {
			errorMessage = error;
			// Use progressive backoff for string errors
			if (failures >= 2) {
				const minutes = failures === 2 ? 5 : failures === 3 ? 15 : failures === 4 ? 30 : 60;
				throttledUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
				throttleDescription = `${minutes} minutes (progressive backoff)`;
			}
		} else if (isThrottleableError(error)) {
			// Typed error - use exception-specific throttling
			errorType = error.name;
			errorMessage = error.message;

			const isTransient = TRANSIENT_ERROR_NAMES.has(error.name);

			if (isTransient && !this.shouldThrottleTransient(id)) {
				// Transient error but sliding window threshold not yet reached.
				// Record the failure count and error info but DON'T apply throttling yet.
				logger.debug(
					{
						providerId: id,
						providerName: config.name,
						errorType,
						windowCount: (this.transientErrorTimestamps.get(id) ?? []).length,
						threshold: TRANSIENT_THROTTLE_COUNT
					},
					'Transient error recorded but below throttle threshold'
				);
				// throttledUntil stays undefined - no throttling applied
			} else {
				// Hard error, or transient error that exceeded the sliding window threshold.
				// Apply throttling with appropriate duration.

				// Check for provider-specific reset calculator (e.g., midnight reset)
				const resetCalculator = PROVIDER_RESET_CALCULATORS[config.implementation];

				// Handle special cases where the error provides a reset time
				if (error instanceof DownloadLimitExceeded && error.resetTime) {
					throttledUntil = error.resetTime.toISOString();
					throttleDescription = `until ${error.resetTime.getHours().toString().padStart(2, '0')}:${error.resetTime.getMinutes().toString().padStart(2, '0')}:${error.resetTime.getSeconds().toString().padStart(2, '0')}`;
				} else if (error instanceof TooManyRequests && error.retryAfter) {
					throttledUntil = new Date(Date.now() + error.retryAfter * 1000).toISOString();
					throttleDescription = `${error.retryAfter} seconds`;
				} else if (
					resetCalculator &&
					(error.name === 'DownloadLimitExceeded' || error.name === 'SearchLimitReached')
				) {
					// Use provider's daily reset time
					const msUntilReset = resetCalculator();
					throttledUntil = new Date(Date.now() + msUntilReset).toISOString();
					throttleDescription = `until daily reset (~${Math.round(msUntilReset / 3600000)} hours)`;
				} else {
					// Use configured throttle duration from map
					const throttleConfig = getThrottleConfig(getErrorType(error), config.implementation);
					throttledUntil = new Date(Date.now() + throttleConfig.duration).toISOString();
					throttleDescription = throttleConfig.description;
				}

				if (isTransient) {
					throttleDescription += ` (after ${TRANSIENT_THROTTLE_COUNT} transient errors in ${TRANSIENT_WINDOW_MS / 1000}s)`;
				}
			}
		} else {
			// Generic Error - use progressive backoff
			errorMessage = error.message;
			if (failures >= 2) {
				const minutes = failures === 2 ? 5 : failures === 3 ? 15 : failures === 4 ? 30 : 60;
				throttledUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
				throttleDescription = `${minutes} minutes (progressive backoff)`;
			}
		}

		await db
			.update(subtitleProviders)
			.set({
				lastError: `${errorType}: ${errorMessage}`,
				lastErrorAt: new Date().toISOString(),
				// consecutiveFailures was incremented atomically above.
				throttledUntil,
				updatedAt: new Date().toISOString()
			})
			.where(eq(subtitleProviders.id, id));

		if (throttledUntil) {
			logger.warn(
				{
					providerId: id,
					providerName: config.name,
					implementation: config.implementation,
					errorType,
					errorMessage,
					failures,
					throttledUntil,
					throttleDescription
				},
				'Provider throttled'
			);
		} else {
			logger.debug(
				{
					providerId: id,
					providerName: config.name,
					implementation: config.implementation,
					errorType,
					errorMessage,
					failures
				},
				'Provider error recorded (not yet throttled)'
			);
		}
	}

	/**
	 * Record a successful operation (resets failure count and clears error state)
	 */
	async recordSuccess(id: string): Promise<void> {
		const config = await this.getProvider(id);
		const wasThrottled = config && this.isThrottled(config);
		const hadErrors = config && config.consecutiveFailures > 0;

		// A success must not clear a quota/auth throttle that is still active:
		// those clear at their reset time, not on the next successful call.
		// (`lastError` stores `${errorType}: ${message}`.)
		const activeErrorType = (config?.lastError ?? '').split(':')[0]?.trim() ?? '';
		const preserveHardThrottle = Boolean(
			wasThrottled && HARD_THROTTLE_ERROR_NAMES.has(activeErrorType)
		);

		// Clear transient error sliding window on success
		this.clearTransientErrors(id);

		await db
			.update(subtitleProviders)
			.set({
				consecutiveFailures: 0,
				...(preserveHardThrottle
					? {}
					: { throttledUntil: null, lastError: null, lastErrorAt: null }),
				updatedAt: new Date().toISOString()
			})
			.where(eq(subtitleProviders.id, id));

		if (preserveHardThrottle) {
			logger.debug(
				{
					providerId: id,
					providerName: config?.name,
					errorType: activeErrorType,
					throttledUntil: config?.throttledUntil
				},
				'Provider succeeded but a quota/auth throttle remains active'
			);
		}

		// Log recovery from error state
		if (wasThrottled || hadErrors) {
			logger.info(
				{
					providerId: id,
					providerName: config?.name,
					wasThrottled,
					previousFailures: config?.consecutiveFailures
				},
				'Provider recovered from error state'
			);
		}
	}

	/**
	 * Get health status for all providers
	 */
	async getHealthStatus(): Promise<ProviderHealth[]> {
		const configs = await this.getProviders();
		return configs.map((config) => {
			// Parse error type from lastError if available
			const errorMatch = config.lastError?.match(/^(\w+):/);
			const throttleErrorType = errorMatch?.[1] || undefined;

			return {
				providerId: config.id,
				providerName: config.name,
				implementation: config.implementation,
				isHealthy: config.consecutiveFailures === 0,
				lastCheck: config.lastErrorAt,
				lastError: config.lastError,
				consecutiveFailures: config.consecutiveFailures,
				isThrottled: this.isThrottled(config),
				throttledUntil: config.throttledUntil,
				throttleErrorType
			};
		});
	}

	/**
	 * Get throttle reason for a provider
	 */
	async getThrottleReason(id: string): Promise<{ errorType: string; description: string } | null> {
		const config = await this.getProvider(id);
		if (!config || !config.throttledUntil) return null;

		if (new Date(config.throttledUntil) <= new Date()) {
			return null; // Throttle expired
		}

		// Parse error type from lastError
		const errorMatch = config.lastError?.match(/^(\w+):/);
		const errorType = errorMatch?.[1] || 'UnknownError';

		return {
			errorType,
			description: config.lastError || 'Unknown reason'
		};
	}

	/**
	 * Reset throttle for a provider
	 */
	async resetThrottle(id: string): Promise<void> {
		await db
			.update(subtitleProviders)
			.set({
				consecutiveFailures: 0,
				throttledUntil: null,
				updatedAt: new Date().toISOString()
			})
			.where(eq(subtitleProviders.id, id));

		logger.info({ providerId: id }, 'Reset provider throttle');
	}

	// =========================================================================
	// Testing
	// =========================================================================

	/**
	 * Test a provider configuration
	 */
	async testProvider(
		config: Omit<SubtitleProviderConfig, 'id' | 'consecutiveFailures'>
	): Promise<void> {
		const factory = getSubtitleProviderFactory();

		if (!factory.canHandle(config.implementation)) {
			throw new Error(`Unknown provider implementation: ${config.implementation}`);
		}

		const tempConfig: SubtitleProviderConfig = {
			...config,
			id: 'test-' + randomUUID(),
			consecutiveFailures: 0
		};

		const instance = factory.createProvider(tempConfig);
		await instance.test();
	}

	// =========================================================================
	// Definitions
	// =========================================================================

	/**
	 * Get available provider definitions
	 */
	getDefinitions(): ProviderDefinition[] {
		return getSubtitleProviderFactory().getDefinitions();
	}

	/**
	 * Get a specific provider definition
	 */
	getDefinition(implementation: string): ProviderDefinition | undefined {
		return getSubtitleProviderFactory().getDefinition(implementation);
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Convert database row to config object
	 */
	private rowToConfig(row: typeof subtitleProviders.$inferSelect): SubtitleProviderConfig {
		return {
			id: row.id,
			name: row.name,
			implementation: row.implementation as ProviderImplementation,
			enabled: !!row.enabled,
			priority: row.priority ?? 25,
			apiKey: decryptProviderCredential(row.id, row.apiKey, 'apiKey'),
			username: decryptProviderCredential(row.id, row.username, 'username'),
			password: decryptProviderCredential(row.id, row.password, 'password'),
			settings: (row.settings as Record<string, unknown>) ?? undefined,
			requestsPerMinute: row.requestsPerMinute ?? 60,
			lastError: row.lastError ?? undefined,
			lastErrorAt: row.lastErrorAt ?? undefined,
			consecutiveFailures: row.consecutiveFailures ?? 0,
			throttledUntil: row.throttledUntil ?? undefined
		};
	}
}

/**
 * Get the singleton SubtitleProviderManager
 */
export function getSubtitleProviderManager(): SubtitleProviderManager {
	return SubtitleProviderManager.getInstance();
}

/**
 * Initialize and get the SubtitleProviderManager
 */
export async function initializeSubtitleProviderManager(): Promise<SubtitleProviderManager> {
	const manager = SubtitleProviderManager.getInstance();
	await manager.initialize();
	return manager;
}
