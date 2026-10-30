import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getCinephageSettingsService } from '#lib/server/cinephage/settings/CinephageSettingsService.js';
import { cinephageSubsystemUpdateSchema } from '#lib/validation/schemas.js';
import { isBlankOrRedacted } from '#lib/shared/sensitiveSettings.js';

/**
 * PUT /api/cinephage/config
 * Partial update of the CinephageAPI subsystem config (enabled, baseUrl,
 * versionOverride, commitOverride, manual install-key paste). Admin-gated.
 * Zod-validated. The stored install key is never echoed: blank/[REDACTED]
 * keeps the existing key, a real `ck_...` value replaces it.
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
	const { apiKey, ...configUpdates } = parsedResult.data;

	if (apiKey !== undefined && !isBlankOrRedacted(apiKey)) {
		if (!apiKey.startsWith('ck_')) {
			return Response.json({ error: 'Install keys start with "ck_"' }, { status: 400 });
		}
		const existing = await settings.getConfig();
		await settings.storeInstallApiKey(
			apiKey,
			apiKey.slice(0, 10),
			existing.installKey.registrationEmail
		);
	}

	await settings.updateConfig(configUpdates);

	const updated = await settings.getConfig();
	return Response.json({ success: true, config: updated });
};
