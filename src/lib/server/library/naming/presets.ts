import type { NamingConfig } from './NamingService';
import {
	BUILT_IN_PRESETS,
	getBuiltInPreset,
	getBuiltInPresetIds,
	NAMING_DETAIL_PRESETS,
	NAMING_SERVER_PRESETS,
	NAMING_STYLE_PRESETS,
	type NamingDetailPreset,
	type NamingPreset,
	type NamingServerPreset,
	type NamingStylePreset
} from '#lib/naming/setup-presets.js';

export {
	BUILT_IN_PRESETS,
	getBuiltInPreset,
	getBuiltInPresetIds,
	NAMING_DETAIL_PRESETS,
	NAMING_SERVER_PRESETS,
	NAMING_STYLE_PRESETS
};

export type { NamingDetailPreset, NamingPreset, NamingServerPreset, NamingStylePreset };

export function buildConfigFromSetup(options: {
	serverId: string;
	styleId: string;
	detailId: string;
}): Partial<NamingConfig> {
	const server = NAMING_SERVER_PRESETS.find((preset) => preset.id === options.serverId);
	const style = NAMING_STYLE_PRESETS.find((preset) => preset.id === options.styleId);
	const detail = NAMING_DETAIL_PRESETS.find((preset) => preset.id === options.detailId);

	return {
		...server?.config,
		...style?.config,
		...detail?.config
	};
}
