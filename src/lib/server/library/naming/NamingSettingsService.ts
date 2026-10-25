/**
 * Naming Settings Service
 *
 * Database-backed configuration for the naming service.
 * Loads and saves naming preferences from the namingSettings table.
 */

import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'scans' as const });
import {
	DEFAULT_NAMING_PRESET_SELECTION,
	normalizeNamingPresetSelection,
	type NamingPresetSelection
} from '#lib/naming/editor-state.js';
import { db } from '#lib/server/db/index.js';
import { namingSettings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { DEFAULT_NAMING_CONFIG, type NamingConfig } from './NamingService';

/**
 * Database key to config property mapping
 */
const KEY_MAP: Record<string, keyof NamingConfig> = {
	movie_folder_format: 'movieFolderFormat',
	movie_file_format: 'movieFileFormat',
	series_folder_format: 'seriesFolderFormat',
	season_folder_format: 'seasonFolderFormat',
	episode_file_format: 'episodeFileFormat',
	daily_episode_format: 'dailyEpisodeFormat',
	anime_episode_format: 'animeEpisodeFormat',
	multi_episode_style: 'multiEpisodeStyle',
	colon_replacement: 'colonReplacement',
	replace_spaces_with: 'replaceSpacesWith',
	media_server_id_format: 'mediaServerIdFormat',
	include_quality: 'includeQuality',
	include_media_info: 'includeMediaInfo',
	include_release_group: 'includeReleaseGroup',
	use_specials_folder: 'useSpecialsFolder'
};

const PRESET_KEY_MAP = {
	selected_server_preset_id: 'selectedServerPresetId',
	selected_style_preset_id: 'selectedStylePresetId',
	selected_detail_preset_id: 'selectedDetailPresetId',
	selected_custom_preset_id: 'selectedCustomPresetId'
} as const satisfies Record<string, keyof NamingPresetSelection>;

/**
 * Reverse mapping from config property to database key
 */
const REVERSE_KEY_MAP: Record<keyof NamingConfig, string> = Object.fromEntries(
	Object.entries(KEY_MAP).map(([k, v]) => [v, k])
) as Record<keyof NamingConfig, string>;

const REVERSE_PRESET_KEY_MAP: Record<keyof NamingPresetSelection, string> = Object.fromEntries(
	Object.entries(PRESET_KEY_MAP).map(([k, v]) => [v, k])
) as Record<keyof NamingPresetSelection, string>;

/**
 * Boolean settings that need special handling
 */
const BOOLEAN_KEYS = new Set([
	'include_quality',
	'include_media_info',
	'include_release_group',
	'use_specials_folder'
]);

/**
 * Helper to set a config value by key
 */
function setConfigValue(
	config: NamingConfig,
	key: keyof NamingConfig,
	value: string | boolean | undefined
): void {
	// Use type assertion with explicit any to work around strict typing
	// This is safe because we control the key-value mapping
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(config as any)[key] = value;
}

/**
 * Naming Settings Service
 */
export class NamingSettingsService {
	private static instance: NamingSettingsService;
	private cachedConfig: NamingConfig | null = null;
	private cachedPresetSelection: NamingPresetSelection | null = null;

	private constructor() {}

	static getInstance(): NamingSettingsService {
		if (!NamingSettingsService.instance) {
			NamingSettingsService.instance = new NamingSettingsService();
		}
		return NamingSettingsService.instance;
	}

	/**
	 * Get the current naming configuration
	 * Returns cached config if available, otherwise loads from database
	 */
	async getConfig(): Promise<NamingConfig> {
		if (this.cachedConfig) {
			return { ...this.cachedConfig };
		}

		const { config } = this.loadCachedStateFromDb();
		return config;
	}

	async getPresetSelection(): Promise<NamingPresetSelection> {
		if (this.cachedPresetSelection) {
			return { ...this.cachedPresetSelection };
		}

		const { presetSelection } = this.loadCachedStateFromDb();
		return presetSelection;
	}

	/**
	 * Get the current config synchronously (uses cache or defaults)
	 * Use getConfig() for guaranteed up-to-date values
	 */
	getConfigSync(): NamingConfig {
		if (this.cachedConfig) {
			return { ...this.cachedConfig };
		}

		const { config } = this.loadCachedStateFromDb();
		return config;
	}

	getPresetSelectionSync(): NamingPresetSelection {
		if (this.cachedPresetSelection) {
			return { ...this.cachedPresetSelection };
		}

		const { presetSelection } = this.loadCachedStateFromDb();
		return presetSelection;
	}

	/**
	 * Update the naming configuration
	 * Only updates the provided fields, leaves others unchanged
	 */
	async updateConfig(updates: Partial<NamingConfig>): Promise<NamingConfig> {
		for (const [configKey, value] of Object.entries(updates)) {
			const dbKey = REVERSE_KEY_MAP[configKey as keyof NamingConfig];
			if (!dbKey) continue;

			// Convert value to string for storage
			let stringValue: string;
			if (value === undefined || value === null) {
				stringValue = '';
			} else if (typeof value === 'boolean') {
				stringValue = value.toString();
			} else {
				stringValue = String(value);
			}

			// Upsert the setting
			const existing = db.select().from(namingSettings).where(eq(namingSettings.key, dbKey)).get();

			if (existing) {
				db.update(namingSettings)
					.set({ value: stringValue })
					.where(eq(namingSettings.key, dbKey))
					.run();
			} else {
				db.insert(namingSettings).values({ key: dbKey, value: stringValue }).run();
			}
		}

		// Invalidate NamingSettingsService config cache and rename-preview cache.
		// A naming format change invalidates every computed path in the library.
		this.invalidateCache();
		const { renamePreviewCache } = await import('./RenamePreviewCache.js');
		renamePreviewCache.invalidateAll();
		return this.getConfig();
	}

	async updatePresetSelection(
		updates: Partial<NamingPresetSelection>
	): Promise<NamingPresetSelection> {
		const nextSelection = normalizeNamingPresetSelection({
			...this.getPresetSelectionSync(),
			...updates
		});

		for (const [selectionKey, value] of Object.entries(nextSelection)) {
			const dbKey = REVERSE_PRESET_KEY_MAP[selectionKey as keyof NamingPresetSelection];
			if (!dbKey) continue;

			const stringValue = value ? String(value) : '';
			const existing = db.select().from(namingSettings).where(eq(namingSettings.key, dbKey)).get();

			if (existing) {
				db.update(namingSettings)
					.set({ value: stringValue })
					.where(eq(namingSettings.key, dbKey))
					.run();
			} else {
				db.insert(namingSettings).values({ key: dbKey, value: stringValue }).run();
			}
		}

		this.invalidateCache();
		return this.getPresetSelection();
	}

	async updateSettings(options: {
		config: Partial<NamingConfig>;
		presetSelection: Partial<NamingPresetSelection>;
	}): Promise<{ config: NamingConfig; presetSelection: NamingPresetSelection }> {
		await this.updateConfig(options.config);
		const presetSelection = await this.updatePresetSelection(options.presetSelection);
		return {
			config: await this.getConfig(),
			presetSelection
		};
	}

	/**
	 * Reset all naming settings to defaults
	 */
	async resetToDefaults(): Promise<NamingConfig> {
		// Delete all naming settings
		db.delete(namingSettings).run();

		// Invalidate cache
		this.invalidateCache();

		// Restore-equivalent path: keep the rename-preview cache in sync the same
		// way updateConfig does.
		const { renamePreviewCache } = await import('./RenamePreviewCache.js');
		renamePreviewCache.invalidateAll();

		return { ...DEFAULT_NAMING_CONFIG };
	}

	/**
	 * Invalidate the cached configuration
	 * Call this when settings may have changed externally
	 */
	invalidateCache(): void {
		this.cachedConfig = null;
		this.cachedPresetSelection = null;
	}

	private loadCachedStateFromDb(): {
		config: NamingConfig;
		presetSelection: NamingPresetSelection;
	} {
		let settings: { key: string; value: string }[] = [];
		try {
			settings = db.select().from(namingSettings).all();
		} catch (error) {
			logger.warn(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'[NamingSettingsService] Failed to load settings from DB (using defaults)'
			);
			if (String(error).includes('no such table')) {
				logger.error(
					'[NamingSettingsService] CRITICAL: naming_settings table is missing! Please run migrations.'
				);
			}
		}

		const settingsMap = new Map(settings.map((setting) => [setting.key, setting.value]));
		const config: NamingConfig = { ...DEFAULT_NAMING_CONFIG };
		const presetSelection: NamingPresetSelection = { ...DEFAULT_NAMING_PRESET_SELECTION };

		for (const [dbKey, configKey] of Object.entries(KEY_MAP)) {
			const value = settingsMap.get(dbKey);
			if (value !== undefined) {
				if (BOOLEAN_KEYS.has(dbKey)) {
					setConfigValue(config, configKey, value === 'true');
				} else if (value === 'null' || value === '') {
					setConfigValue(config, configKey, undefined);
				} else {
					setConfigValue(config, configKey, value);
				}
			}
		}

		for (const [dbKey, selectionKey] of Object.entries(PRESET_KEY_MAP)) {
			const value = settingsMap.get(dbKey);
			if (value && value.trim().length > 0) {
				presetSelection[selectionKey] = value;
			}
		}

		const normalizedPresetSelection = normalizeNamingPresetSelection(presetSelection);
		this.cachedConfig = config;
		this.cachedPresetSelection = normalizedPresetSelection;

		return {
			config: { ...config },
			presetSelection: { ...normalizedPresetSelection }
		};
	}
}

/**
 * Singleton instance
 */
export const namingSettingsService = NamingSettingsService.getInstance();
