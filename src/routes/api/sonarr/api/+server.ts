import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';

/**
 * GET /api/sonarr/api
 * Sonarr's ApiInfo endpoint - same shape as Radarr's confirmed
 * ApiInfoResource ({ current, deprecated }), not a copy of system/status.
 * See /api/radarr/api/+server.ts for more information.
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	return Response.json({ current: 'v3', deprecated: [] });
};
