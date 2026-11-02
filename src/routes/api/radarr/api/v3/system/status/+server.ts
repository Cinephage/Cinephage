import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildSystemStatus } from '#lib/server/arr/systemStatus.js';

/**
 * GET /api/radarr/api/v3/system/status
 * Radarr-compatible connection check - the endpoint arr-satellite tools
 * (autobrr, Overseerr, ...) call first when validating a "Radarr" server.
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	return Response.json(buildSystemStatus('Radarr'));
};
