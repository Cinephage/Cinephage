import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getLanguageSettingsService } from '#lib/server/subtitles/services/LanguageSettingsService.js';
import { languageSettingsUpdateSchema } from '#lib/server/validation/schemas.js';
import { parseBody } from '#lib/server/api/validate.js';
import { tmdb } from '#lib/server/tmdb.js';

/**
 * GET /api/subtitles/language-settings
 * Get the global language settings singleton.
 */
export const GET: RequestHandler = async () => {
	const settings = await getLanguageSettingsService().get();
	return Response.json(settings);
};

/**
 * PUT /api/subtitles/language-settings
 * Update the global language settings singleton. Admin-gated like the other
 * settings routes (global hooks only enforce authentication, not role).
 */
export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const patch = await parseBody(event.request, languageSettingsUpdateSchema);
	const settings = await getLanguageSettingsService().update(patch);

	// locale/region changes must reach TMDB immediately, not after the 5-minute
	// settings cache TTL.
	tmdb.invalidateSettings();

	return Response.json(settings);
};
