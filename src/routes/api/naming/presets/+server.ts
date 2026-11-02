import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { namingPresets } from '#lib/server/db/schema.js';
import {
	BUILT_IN_PRESETS,
	NAMING_DETAIL_PRESETS,
	NAMING_SERVER_PRESETS,
	NAMING_STYLE_PRESETS,
	type NamingPreset
} from '#lib/server/library/naming/presets.js';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { namingPresetCreateSchema } from '#lib/validation/schemas.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'NamingPresetsApi', logDomain: 'scans' });

/**
 * GET /api/naming/presets
 * List all presets (built-in + custom)
 */
export const GET: RequestHandler = async () => {
	try {
		// Get custom presets from database
		const customPresets = await db.select().from(namingPresets);

		// Combine built-in and custom presets
		const allPresets: NamingPreset[] = [
			...BUILT_IN_PRESETS,
			...customPresets.map((p) => ({
				id: p.id,
				name: p.name,
				description: p.description || '',
				isBuiltIn: false,
				config: p.config as NamingPreset['config']
			}))
		];

		return Response.json({
			presets: allPresets,
			builtInIds: BUILT_IN_PRESETS.map((p) => p.id),
			setupPresets: {
				servers: NAMING_SERVER_PRESETS,
				styles: NAMING_STYLE_PRESETS,
				details: NAMING_DETAIL_PRESETS
			}
		});
	} catch (err) {
		logger.error({ err, component: 'NamingPresetsApi' }, 'Error fetching naming presets');
		return Response.json({ error: 'Failed to fetch presets' }, { status: 500 });
	}
};

/**
 * POST /api/naming/presets
 * Create a new custom preset
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	try {
		const parsed = namingPresetCreateSchema.safeParse(await request.json());
		if (!parsed.success) {
			return Response.json(
				{ success: false, error: parsed.error.issues[0].message },
				{ status: 400 }
			);
		}
		const { name, description, config } = parsed.data;

		// Check if name conflicts with built-in preset
		const builtInConflict = BUILT_IN_PRESETS.find(
			(p) => p.name.toLowerCase() === name.trim().toLowerCase()
		);
		if (builtInConflict) {
			return Response.json({ error: 'Cannot use a built-in preset name' }, { status: 400 });
		}

		// Check if name already exists in custom presets
		const existingCustom = await db
			.select()
			.from(namingPresets)
			.where(eq(namingPresets.name, name.trim()));

		if (existingCustom.length > 0) {
			return Response.json({ error: 'A preset with this name already exists' }, { status: 400 });
		}

		// Create the preset
		const [newPreset] = await db
			.insert(namingPresets)
			.values({
				name: name.trim(),
				description: description?.trim() || null,
				config,
				isBuiltIn: false
			})
			.returning();

		return Response.json({
			preset: {
				id: newPreset.id,
				name: newPreset.name,
				description: newPreset.description || '',
				isBuiltIn: false,
				config: newPreset.config as NamingPreset['config']
			}
		});
	} catch (err) {
		logger.error({ err, component: 'NamingPresetsApi' }, 'Error creating naming preset');
		return Response.json({ error: 'Failed to create preset' }, { status: 500 });
	}
};
