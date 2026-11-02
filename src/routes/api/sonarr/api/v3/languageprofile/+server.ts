import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildLanguageProfiles } from '#lib/server/arr/languageProfiles.js';

/**
 * GET /api/sonarr/api/v3/languageprofile
 * Sonarr-only - see languageProfiles.ts for why this isn't an empty-array
 * skeleton.
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	return Response.json(await buildLanguageProfiles());
};
