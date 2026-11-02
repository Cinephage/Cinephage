import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildQualityProfiles } from '#lib/server/arr/qualityProfiles.js';

/**
 * GET /api/sonarr/api/v3/qualityprofile
 * Returns Cinephage's scoring profiles in Sonarr's qualityprofile shape -
 * the same list as the Radarr tree, since scoring profiles aren't scoped
 * by media type (see buildQualityProfiles).
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	return Response.json(await buildQualityProfiles('Sonarr'));
};
