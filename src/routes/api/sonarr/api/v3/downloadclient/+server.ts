import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildDownloadClients } from '#lib/server/arr/downloadClients.js';

/**
 * GET /api/sonarr/api/v3/downloadclient
 * See downloadClients.ts - not just Sonarr-web-UI config surface, arr
 * clients (Seerr) use this to interpret queue/completion state.
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	return Response.json(await buildDownloadClients());
};
