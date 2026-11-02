import type { PageServerLoad } from './$types';
import { namingSettingsService } from '#lib/server/library/naming/NamingSettingsService.js';
import { DEFAULT_NAMING_CONFIG } from '#lib/server/library/naming/NamingService.js';
import {
	NAMING_DETAIL_PRESETS,
	NAMING_SERVER_PRESETS,
	NAMING_STYLE_PRESETS
} from '#lib/server/library/naming/presets.js';
import { buildTokensResponse } from '#lib/server/library/naming/token-reference.js';

export const load: PageServerLoad = async () => {
	const config = await namingSettingsService.getConfig();
	const presetSelection = await namingSettingsService.getPresetSelection();

	return {
		config,
		presetSelection,
		defaults: DEFAULT_NAMING_CONFIG,
		setupPresets: {
			servers: NAMING_SERVER_PRESETS,
			styles: NAMING_STYLE_PRESETS,
			details: NAMING_DETAIL_PRESETS
		},
		tokens: buildTokensResponse()
	};
};
