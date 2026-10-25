/**
 * Captcha Solver Settings Service
 *
 * Database-backed configuration for the Camoufox-based captcha solving system.
 */

import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });
import { db } from '#lib/server/db/index.js';
import { captchaSolverSettings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { DEFAULT_CONFIG, type CaptchaSolverConfig, type ProxyConfig } from './types';
import {
	decryptCaptchaSettingValue,
	encryptCaptchaSettingValue
} from '#lib/server/settings/secretSettings.js';

/**
 * Database key to config property mapping
 */
const KEY_MAP: Record<
	string,
	keyof CaptchaSolverConfig | 'proxy_url' | 'proxy_username' | 'proxy_password'
> = {
	enabled: 'enabled',
	timeout_seconds: 'timeoutSeconds',
	cache_ttl_seconds: 'cacheTtlSeconds',
	headless: 'headless',
	proxy_url: 'proxy_url',
	proxy_username: 'proxy_username',
	proxy_password: 'proxy_password'
};

/**
 * Reverse mapping from config property to database key
 */
const REVERSE_KEY_MAP: Record<string, string> = Object.fromEntries(
	Object.entries(KEY_MAP).map(([k, v]) => [v, k])
);

/**
 * Boolean settings that need special handling
 */
const BOOLEAN_KEYS = new Set(['enabled', 'headless']);

/**
 * Numeric settings that need parsing
 */
const NUMERIC_KEYS = new Set(['timeout_seconds', 'cache_ttl_seconds']);

/**
 * Captcha Solver Settings Service
 */
export class CaptchaSolverSettingsService {
	private static instance: CaptchaSolverSettingsService;
	private cachedConfig: CaptchaSolverConfig | null = null;

	private constructor() {}

	static getInstance(): CaptchaSolverSettingsService {
		if (!CaptchaSolverSettingsService.instance) {
			CaptchaSolverSettingsService.instance = new CaptchaSolverSettingsService();
		}
		return CaptchaSolverSettingsService.instance;
	}

	/**
	 * Get the current configuration
	 * Returns cached config if available, otherwise loads from database
	 */
	getConfig(): CaptchaSolverConfig {
		if (this.cachedConfig) {
			return { ...this.cachedConfig };
		}

		let settings: { key: string; value: string }[] = [];
		try {
			settings = db.select().from(captchaSolverSettings).all();
		} catch (error) {
			logger.warn(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'[CaptchaSolverSettings] Failed to load settings from DB (using defaults)'
			);
		}

		const settingsMap = new Map(
			settings.map((s) => [s.key, decryptCaptchaSettingValue(s.key, s.value) ?? ''])
		);

		// Build config from database settings, falling back to defaults
		const config: CaptchaSolverConfig = { ...DEFAULT_CONFIG };

		// Parse simple settings
		for (const [dbKey, configKey] of Object.entries(KEY_MAP)) {
			const value = settingsMap.get(dbKey);
			if (value === undefined) continue;

			if (BOOLEAN_KEYS.has(dbKey)) {
				if (configKey === 'enabled' || configKey === 'headless') {
					config[configKey] = value === 'true';
				}
			} else if (NUMERIC_KEYS.has(dbKey)) {
				const numValue = parseInt(value, 10);
				if (!isNaN(numValue)) {
					if (configKey === 'timeoutSeconds') {
						config.timeoutSeconds = numValue;
					} else if (configKey === 'cacheTtlSeconds') {
						config.cacheTtlSeconds = numValue;
					}
				}
			}
		}

		// Parse proxy settings
		const proxyUrl = settingsMap.get('proxy_url');
		if (proxyUrl && proxyUrl.trim()) {
			const proxy: ProxyConfig = { url: proxyUrl.trim() };
			const proxyUsername = settingsMap.get('proxy_username');
			const proxyPassword = settingsMap.get('proxy_password');
			if (proxyUsername) proxy.username = proxyUsername;
			if (proxyPassword) proxy.password = proxyPassword;
			config.proxy = proxy;
		}

		this.cachedConfig = config;
		return { ...config };
	}

	/**
	 * Update the configuration
	 * Only updates the provided fields, leaves others unchanged
	 */
	updateConfig(
		updates: Partial<
			CaptchaSolverConfig & { proxyUrl?: string; proxyUsername?: string; proxyPassword?: string }
		>
	): CaptchaSolverConfig {
		// Handle simple config keys
		for (const [configKey, value] of Object.entries(updates)) {
			if (configKey === 'proxy') {
				// Handle proxy object separately
				const proxy = value as ProxyConfig | undefined;
				if (proxy) {
					this.setSetting('proxy_url', proxy.url);
					if (proxy.username !== undefined) this.setSetting('proxy_username', proxy.username);
					if (proxy.password !== undefined) this.setSetting('proxy_password', proxy.password);
				} else {
					// Clear proxy settings
					this.deleteSetting('proxy_url');
					this.deleteSetting('proxy_username');
					this.deleteSetting('proxy_password');
				}
				continue;
			}

			// Handle flat proxy fields
			if (configKey === 'proxyUrl') {
				this.setSetting('proxy_url', String(value ?? ''));
				continue;
			}
			if (configKey === 'proxyUsername') {
				this.setSetting('proxy_username', String(value ?? ''));
				continue;
			}
			if (configKey === 'proxyPassword') {
				this.setSetting('proxy_password', String(value ?? ''));
				continue;
			}

			const dbKey = REVERSE_KEY_MAP[configKey];
			if (!dbKey) continue;

			// Convert value to string for storage
			let stringValue: string;
			if (value === undefined || value === null) {
				stringValue = '';
			} else if (typeof value === 'boolean') {
				stringValue = value.toString();
			} else if (typeof value === 'number') {
				stringValue = value.toString();
			} else {
				stringValue = String(value);
			}

			this.setSetting(dbKey, stringValue);
		}

		// Invalidate cache and return updated config
		this.invalidateCache();
		return this.getConfig();
	}

	/**
	 * Set a single setting value
	 */
	private setSetting(key: string, value: string): void {
		// Proxy credentials are encrypted at rest; other settings are plain.
		const storedValue = encryptCaptchaSettingValue(key, value);
		const existing = db
			.select()
			.from(captchaSolverSettings)
			.where(eq(captchaSolverSettings.key, key))
			.get();

		if (existing) {
			db.update(captchaSolverSettings)
				.set({ value: storedValue })
				.where(eq(captchaSolverSettings.key, key))
				.run();
		} else {
			db.insert(captchaSolverSettings).values({ key, value: storedValue }).run();
		}
	}

	/**
	 * Delete a setting
	 */
	private deleteSetting(key: string): void {
		db.delete(captchaSolverSettings).where(eq(captchaSolverSettings.key, key)).run();
	}

	/**
	 * Reset all settings to defaults
	 */
	resetToDefaults(): CaptchaSolverConfig {
		// Delete all settings
		db.delete(captchaSolverSettings).run();

		// Invalidate cache
		this.invalidateCache();

		return { ...DEFAULT_CONFIG };
	}

	/**
	 * Check if the solver is enabled
	 */
	isEnabled(): boolean {
		return this.getConfig().enabled;
	}

	/**
	 * Invalidate the cached configuration
	 */
	invalidateCache(): void {
		this.cachedConfig = null;
	}
}

/**
 * Singleton instance
 */
export const captchaSolverSettingsService = CaptchaSolverSettingsService.getInstance();
