/**
 * Preset Loader
 *
 * Loads and parses external list preset definitions from YAML files
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'monitoring' as const });
import type { PresetProvider, ExternalListPreset } from './types.js';

const DEFAULT_PRESETS_DIR = join(process.cwd(), 'data', 'external-lists', 'presets');
const PRESETS_DIR = process.env.EXTERNAL_LISTS_PRESETS_PATH ?? DEFAULT_PRESETS_DIR;
const CUSTOM_PRESETS_DIR =
	process.env.EXTERNAL_LISTS_CUSTOM_PRESETS_PATH ?? join(PRESETS_DIR, 'custom');
const PRESET_DIRS = [PRESETS_DIR, CUSTOM_PRESETS_DIR];

export class PresetLoader {
	private presets: Map<string, ExternalListPreset> = new Map();
	private providers: Map<string, PresetProvider> = new Map();
	private loaded = false;

	/**
	 * Load all preset definitions from YAML files
	 */
	loadPresets(): void {
		if (this.loaded) return;

		logger.info({ dirs: PRESET_DIRS }, '[PresetLoader] Loading external list presets');

		try {
			for (const dir of PRESET_DIRS) {
				if (!existsSync(dir)) {
					if (dir === PRESETS_DIR) {
						logger.warn({ dir }, '[PresetLoader] Presets directory not found');
					}
					continue;
				}

				const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

				for (const file of files) {
					try {
						const content = readFileSync(join(dir, file), 'utf-8');
						const provider = load(content) as PresetProvider;

						// Store provider
						this.providers.set(provider.provider, provider);

						// Create individual presets from provider
						for (const preset of provider.presets) {
							const fullPreset: ExternalListPreset = {
								id: `${provider.provider}:${preset.id}`,
								provider: provider.provider,
								providerName: provider.name,
								name: preset.name,
								description: preset.description,
								icon: provider.icon,
								url: preset.url,
								config: preset.config,
								isDefault: preset.default ?? false,
								settings: provider.settings
							};

							this.presets.set(fullPreset.id, fullPreset);
							logger.debug(
								{
									id: fullPreset.id,
									name: fullPreset.name
								},
								'[PresetLoader] Loaded preset'
							);
						}

						// Create a "custom" preset for providers that allow user-defined lists
						if (provider.settings.length > 0 && provider.presets.length === 0) {
							const customPreset: ExternalListPreset = {
								id: `${provider.provider}:custom`,
								provider: provider.provider,
								providerName: provider.name,
								name: `Custom ${provider.name}`,
								description: `Create a custom ${provider.name} with your own settings`,
								icon: provider.icon,
								isDefault: false,
								settings: provider.settings
							};

							this.presets.set(customPreset.id, customPreset);
							logger.debug(
								{
									id: customPreset.id,
									provider: provider.provider
								},
								'[PresetLoader] Loaded custom preset'
							);
						}

						logger.info(
							{
								provider: provider.provider,
								presetCount: provider.presets.length
							},
							'[PresetLoader] Loaded provider'
						);
					} catch (error) {
						logger.error({ file, error }, '[PresetLoader] Failed to load preset file');
					}
				}
			}

			this.loaded = true;
			logger.info({ count: this.presets.size }, '[PresetLoader] Finished loading presets');
		} catch (error) {
			logger.error({ error }, '[PresetLoader] Failed to load presets directory');
		}
	}

	/**
	 * Get all available presets
	 */
	getAllPresets(): ExternalListPreset[] {
		this.loadPresets();
		return Array.from(this.presets.values());
	}

	/**
	 * Get a specific preset by ID
	 */
	getPreset(id: string): ExternalListPreset | undefined {
		this.loadPresets();
		return this.presets.get(id);
	}

	/**
	 * Get all presets for a specific provider
	 */
	getPresetsByProvider(provider: string): ExternalListPreset[] {
		this.loadPresets();
		return Array.from(this.presets.values()).filter((p) => p.provider === provider);
	}

	/**
	 * Get all available providers
	 */
	getProviders(): PresetProvider[] {
		this.loadPresets();
		return Array.from(this.providers.values());
	}

	/**
	 * Get the default preset (first one marked as default, or first available)
	 */
	getDefaultPreset(): ExternalListPreset | undefined {
		this.loadPresets();
		const presets = Array.from(this.presets.values());
		return presets.find((p) => p.isDefault) ?? presets[0];
	}

	/**
	 * Reload presets (useful for hot-reloading in development)
	 */
	reload(): void {
		this.presets.clear();
		this.providers.clear();
		this.loaded = false;
		this.loadPresets();
	}
}

// Singleton instance
export const presetLoader = new PresetLoader();
