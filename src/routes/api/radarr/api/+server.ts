import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';

/**
 * GET /api/radarr/api
 * Real Radarr's ApiInfo endpoint - confirmed against Radarr/Radarr's actual
 * openapi.json (ApiInfoResource: { current, deprecated }), NOT a copy of
 * system/status. Some arr-satellite clients (observed: NZBDav) hit this
 * bare, unversioned path as an initial reachability/version-discovery
 * check before calling the real /api/v3/system/status, and parse `current`
 * specifically - returning the wrong shape here (system/status) left that
 * field missing, which is what NZBDav reported as "empty API info".
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	return Response.json({ current: 'v3', deprecated: [] });
};
