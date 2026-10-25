import {
	DEFAULT_SETUP_NAMING_CONFIG,
	type NamingConfigShape,
	type NamingPreset
} from '#lib/naming/setup-presets.js';

export interface NamingPresetSelection {
	selectedServerPresetId: string;
	selectedStylePresetId: string;
	selectedDetailPresetId: string;
	selectedCustomPresetId?: string;
}

export interface NamingEditorState<TConfig extends Partial<NamingConfigShape> = NamingConfigShape> {
	config: TConfig;
	presetSelection: NamingPresetSelection;
}

export const DEFAULT_NAMING_PRESET_SELECTION: NamingPresetSelection = {
	selectedServerPresetId: 'plex',
	selectedStylePresetId: 'recommended',
	selectedDetailPresetId: 'balanced'
};

export function normalizeNamingConfig<TConfig extends Partial<NamingConfigShape>>(
	config: TConfig
): TConfig {
	const normalized = {
		...config,
		replaceSpacesWith:
			typeof config.replaceSpacesWith === 'string' && config.replaceSpacesWith.trim() === ''
				? undefined
				: config.replaceSpacesWith
	};

	return normalized;
}

export function createNormalizedNamingConfig(
	config: Partial<NamingConfigShape>
): NamingConfigShape {
	return {
		...DEFAULT_SETUP_NAMING_CONFIG,
		...normalizeNamingConfig(config)
	};
}

export function normalizeNamingPresetSelection(
	selection?: Partial<NamingPresetSelection>
): NamingPresetSelection {
	return {
		...DEFAULT_NAMING_PRESET_SELECTION,
		...selection,
		selectedCustomPresetId: selection?.selectedCustomPresetId?.trim() || undefined
	};
}

export function serializeNamingEditorState(
	config: Partial<NamingConfigShape>,
	selection?: Partial<NamingPresetSelection>
): string {
	return JSON.stringify({
		config: createNormalizedNamingConfig(config),
		presetSelection: normalizeNamingPresetSelection(selection)
	});
}

export function getPresetLabelById(presets: NamingPreset[], presetId?: string): string | undefined {
	if (!presetId) return undefined;
	return presets.find((preset) => preset.id === presetId)?.name;
}
