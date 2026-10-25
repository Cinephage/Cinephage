import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildQualityProfiles } from '#lib/server/arr/qualityProfiles.js';

/**
 * GET /api/radarr/api/v3/qualityprofile
 * Returns Cinephage's scoring profiles in Radarr's qualityprofile shape
 * (id + name only - see buildQualityProfiles for why this is intentionally
 * lossy).
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	return Response.json(await buildQualityProfiles('Radarr'));
};
