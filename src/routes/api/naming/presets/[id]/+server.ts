import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { namingPresets } from '#lib/server/db/schema.js';
import {
	BUILT_IN_PRESETS,
	getBuiltInPreset,
	type NamingPreset
} from '#lib/server/library/naming/presets.js';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { namingPresetUpdateSchema } from '#lib/validation/schemas.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'NamingPresetByIdApi', logDomain: 'scans' });

/**
 * GET /api/naming/presets/[id]
 * Get a specific preset by ID
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const { id } = params;

		// Check built-in presets first
		const builtIn = getBuiltInPreset(id);
		if (builtIn) {
			return Response.json({ preset: builtIn });
		}

		// Check custom presets
		const [customPreset] = await db.select().from(namingPresets).where(eq(namingPresets.id, id));

		if (!customPreset) {
			return Response.json({ error: 'Preset not found' }, { status: 404 });
		}

		return Response.json({
			preset: {
				id: customPreset.id,
				name: customPreset.name,
				description: customPreset.description || '',
				isBuiltIn: false,
				config: customPreset.config as NamingPreset['config']
			}
		});
	} catch (err) {
		logger.error({ err, component: 'NamingPresetByIdApi' }, 'Error fetching naming preset');
		return Response.json({ error: 'Failed to fetch preset' }, { status: 500 });
	}
};

/**
 * PUT /api/naming/presets/[id]
 * Update a custom preset (cannot update built-in presets)
 */
export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params, request } = event;
	try {
		const { id } = params;

		// Check if it's a built-in preset
		const builtIn = getBuiltInPreset(id);
		if (builtIn) {
			return Response.json({ error: 'Cannot modify built-in presets' }, { status: 400 });
		}

		// Check if custom preset exists
		const [existing] = await db.select().from(namingPresets).where(eq(namingPresets.id, id));

		if (!existing) {
			return Response.json({ error: 'Preset not found' }, { status: 404 });
		}

		const parsed = namingPresetUpdateSchema.safeParse(await request.json());
		if (!parsed.success) {
			return Response.json(
				{ success: false, error: parsed.error.issues[0].message },
				{ status: 400 }
			);
		}
		const { name, description, config } = parsed.data;

		if (name !== undefined) {
			const builtInConflict = BUILT_IN_PRESETS.find(
				(p) => p.name.toLowerCase() === name.trim().toLowerCase()
			);
			if (builtInConflict) {
				return Response.json({ error: 'Cannot use a built-in preset name' }, { status: 400 });
			}

			// Check if name already exists in other custom presets
			const existingCustom = await db
				.select()
				.from(namingPresets)
				.where(eq(namingPresets.name, name.trim()));

			if (existingCustom.length > 0 && existingCustom[0].id !== id) {
				return Response.json({ error: 'A preset with this name already exists' }, { status: 400 });
			}
		}

		// Update the preset
		const [updated] = await db
			.update(namingPresets)
			.set({
				...(name !== undefined && { name: name.trim() }),
				...(description !== undefined && { description: description?.trim() || null }),
				...(config !== undefined && { config })
			})
			.where(eq(namingPresets.id, id))
			.returning();

		return Response.json({
			preset: {
				id: updated.id,
				name: updated.name,
				description: updated.description || '',
				isBuiltIn: false,
				config: updated.config as NamingPreset['config']
			}
		});
	} catch (err) {
		logger.error({ err, component: 'NamingPresetByIdApi' }, 'Error updating naming preset');
		return Response.json({ error: 'Failed to update preset' }, { status: 500 });
	}
};

/**
 * DELETE /api/naming/presets/[id]
 * Delete a custom preset (cannot delete built-in presets)
 */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params } = event;
	try {
		const { id } = params;

		// Check if it's a built-in preset
		const builtIn = getBuiltInPreset(id);
		if (builtIn) {
			return Response.json({ error: 'Cannot delete built-in presets' }, { status: 400 });
		}

		// Delete the preset
		const deleted = await db.delete(namingPresets).where(eq(namingPresets.id, id)).returning();

		if (deleted.length === 0) {
			return Response.json({ error: 'Preset not found' }, { status: 404 });
		}

		return Response.json({ success: true });
	} catch (err) {
		logger.error({ err, component: 'NamingPresetByIdApi' }, 'Error deleting naming preset');
		return Response.json({ error: 'Failed to delete preset' }, { status: 500 });
	}
};
