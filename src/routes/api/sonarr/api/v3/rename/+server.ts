import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildSeriesRename } from '#lib/server/arr/rename.js';

/** GET /api/sonarr/api/v3/rename?seriesId=... */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const seriesId = Number.parseInt(event.url.searchParams.get('seriesId') ?? '', 10);
	if (Number.isNaN(seriesId)) return Response.json([]);

	return Response.json(await buildSeriesRename(seriesId));
};
