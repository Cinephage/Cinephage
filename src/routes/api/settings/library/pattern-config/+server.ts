/**
 * Library Pattern Config API
 *
 * GET  /api/settings/library/pattern-config?libraryId=X
 * PUT  /api/settings/library/pattern-config
 *
 * Manages per-library and global pattern recognition settings (Phase 1).
 * Ignore/bonus patterns are glob strings; structure uses folder_depth or regex mode.
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { z } from 'zod';
import {
	getOrCreateGlobalPatternConfig,
	getLibraryPatternConfig,
	saveLibraryPatternConfig,
	updateGlobalPatternConfig
} from '#lib/server/library/patterns/PatternConfigService.js';

const updateSchema = z.object({
	libraryId: z.string().optional(), // null/absent = global
	ignoreDefaultsEnabled: z.boolean().optional(),
	ignoreUserPatterns: z.array(z.string()).optional(),
	bonusPatterns: z.array(z.string()).optional(),
	structureMode: z.enum(['none', 'folder_depth', 'regex']).nullable().optional(),
	structureConfig: z.record(z.string(), z.unknown()).nullable().optional()
});

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const libraryId = event.url.searchParams.get('libraryId') || null;

	if (libraryId) {
		const config = await getLibraryPatternConfig(libraryId);
		return Response.json(config);
	}

	const global = await getOrCreateGlobalPatternConfig();
	return Response.json(global);
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json();
	const parsed = updateSchema.safeParse(body);
	if (!parsed.success) throw error(400, 'Invalid pattern config');

	const { libraryId, ...input } = parsed.data;

	// Convert 'none' structureMode to null for storage
	if (input.structureMode === 'none') {
		input.structureMode = null;
		input.structureConfig = null;
	}

	if (libraryId) {
		const config = await saveLibraryPatternConfig(libraryId, input);
		return Response.json(config);
	}

	const config = await updateGlobalPatternConfig(input);
	return Response.json(config);
};
