/**
 * Smart List Presets API
 * GET /api/smartlists/presets - List all available external list presets
 */

import type { RequestHandler } from './$types';
import { presetService } from '#lib/server/smartlists/presets/PresetService.js';

export const GET: RequestHandler = async () => {
	try {
		const presets = presetService.getAllPresets();
		return Response.json(presets);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return Response.json({ error: message }, { status: 500 });
	}
};
