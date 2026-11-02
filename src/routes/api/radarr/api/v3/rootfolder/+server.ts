import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildRootFolders } from '#lib/server/arr/rootFolders.js';

/**
 * GET /api/radarr/api/v3/rootfolder
 * Returns Cinephage's movie root folders in Radarr's rootfolder shape.
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	return Response.json(await buildRootFolders('movie'));
};
