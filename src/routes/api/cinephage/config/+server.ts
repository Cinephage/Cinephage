import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getCinephageSettingsService } from '#lib/server/cinephage/settings/CinephageSettingsService.js';
import { cinephageSubsystemUpdateSchema } from '#lib/validation/schemas.js';

/**
 * PUT /api/cinephage/config
 * Partial update of the CinephageAPI subsystem config (enabled, baseUrl,
 * versionOverride, commitOverride). Admin-gated. Zod-validated.
 */
export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const parsedResult = cinephageSubsystemUpdateSchema.safeParse(await event.request.json());
	if (!parsedResult.success) {
		return Response.json(
			{ error: 'Invalid request', details: parsedResult.error.flatten() },
			{ status: 400 }
		);
	}

	const settings = getCinephageSettingsService();
	await settings.updateConfig(parsedResult.data);

	const updated = await settings.getConfig();
	return Response.json({ success: true, config: updated });
};
