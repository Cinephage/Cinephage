import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { namingPresets } from '#lib/server/db/schema.js';
import { getBuiltInPreset, type NamingPreset } from '#lib/server/library/naming/presets.js';
import { namingSettingsService } from '#lib/server/library/naming/NamingSettingsService.js';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'NamingPresetApplyApi', logDomain: 'scans' });

/**
 * POST /api/naming/presets/[id]/apply
 * Apply a preset's config to the current naming settings
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params } = event;
	try {
		const { id } = params;
		let presetConfig: NamingPreset['config'];

		// Check built-in presets first
		const builtIn = getBuiltInPreset(id);
		if (builtIn) {
			presetConfig = builtIn.config;
		} else {
			// Check custom presets
			const [customPreset] = await db.select().from(namingPresets).where(eq(namingPresets.id, id));

			if (!customPreset) {
				return Response.json({ error: 'Preset not found' }, { status: 404 });
			}

			presetConfig = customPreset.config as NamingPreset['config'];
		}

		// Apply the preset config to naming settings
		await namingSettingsService.updateConfig(presetConfig);

		// Get the updated config to return
		const updatedConfig = await namingSettingsService.getConfig();

		return Response.json({
			success: true,
			config: updatedConfig
		});
	} catch (err) {
		logger.error({ err, component: 'NamingPresetApplyApi' }, 'Error applying naming preset');
		return Response.json({ error: 'Failed to apply preset' }, { status: 500 });
	}
};
