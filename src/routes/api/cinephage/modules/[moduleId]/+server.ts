import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getCinephageSettingsService } from '#lib/server/cinephage/settings/CinephageSettingsService.js';
import { cinephageModuleUpdateSchema } from '#lib/validation/schemas.js';

/**
 * PUT /api/cinephage/modules/[moduleId]
 * Update a CinephageAPI module's enabled state and/or settings JSON.
 * Admin-gated. Zod-validated against cinephageModuleUpdateSchema.
 */
export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params, request } = event;

	const body = await request.json();
	const parsedResult = cinephageModuleUpdateSchema.safeParse(body);
	if (!parsedResult.success) {
		return Response.json(
			{ error: 'Invalid request', details: parsedResult.error.flatten() },
			{ status: 400 }
		);
	}

	if (parsedResult.data.moduleId !== params.moduleId) {
		return Response.json({ error: 'Module ID in body must match the URL path' }, { status: 400 });
	}

	const settings = getCinephageSettingsService();

	if (parsedResult.data.enabled !== undefined) {
		await settings.setModuleEnabled(params.moduleId, parsedResult.data.enabled);
	}

	if (parsedResult.data.settings !== undefined) {
		await settings.updateModuleSettings(params.moduleId, parsedResult.data.settings);
	}

	const updated = await settings.getModuleConfig(params.moduleId);
	return Response.json({ success: true, module: updated });
};
