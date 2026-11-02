import type { RequestHandler } from './$types';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';

/**
 * GET /api/radarr/ping
 * Real Radarr/Sonarr expose this at the bare root (no /api/v3) and it
 * doesn't require an API key - a basic liveness probe for monitoring
 * tools. Exempted from the normal /api/* auth requirement in
 * hooks.server.ts to match; still gated on the compatibility layer being
 * enabled, so a disabled layer consistently looks entirely absent rather
 * than "up but everything else is off".
 */
export const GET: RequestHandler = async () => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	return Response.json({ status: 'OK' });
};
