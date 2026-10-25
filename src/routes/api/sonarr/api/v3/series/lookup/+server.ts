import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildSeriesLookup } from '#lib/server/arr/series.js';

/** GET /api/sonarr/api/v3/series/lookup?term=... */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const term = event.url.searchParams.get('term')?.trim();
	if (!term) return Response.json([]);

	return Response.json(await buildSeriesLookup(term));
};
