import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildRootFolders } from '#lib/server/arr/rootFolders.js';

/**
 * GET /api/sonarr/api/v3/rootfolder
 * Returns Cinephage's tv root folders in Sonarr's rootfolder shape.
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	return Response.json(await buildRootFolders('tv'));
};
