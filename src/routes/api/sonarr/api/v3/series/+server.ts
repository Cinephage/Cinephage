import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildSeries } from '#lib/server/arr/series.js';
import { addSeriesFromArr, updateSeriesFromArr } from '#lib/server/arr/libraryWrite.js';
import { withForwardedApiKey } from '#lib/server/arr/internalFetch.js';

/** GET /api/sonarr/api/v3/series */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	return Response.json(await buildSeries());
};

/**
 * POST /api/sonarr/api/v3/series - the actual "Request" action: add a
 * series to the library. See libraryWrite.ts for the real add flow this
 * reuses.
 */
export const POST: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json().catch(() => ({}));
	const result = await addSeriesFromArr(withForwardedApiKey(event), body);
	return Response.json(result.body, { status: result.status });
};

/**
 * PUT /api/sonarr/api/v3/series - real Sonarr accepts an update at the
 * collection root (id in the body, not the URL): Seerr's addSeries() PUTs
 * here directly (not /series/{id}) whenever getSeriesByTvdbId finds the
 * series already exists, to update monitoring/seasons instead of
 * re-adding it.
 */
export const PUT: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json().catch(() => ({}));
	const id = Number(body.id);
	if (!Number.isInteger(id)) return Response.json({ message: 'id is required' }, { status: 400 });

	const result = await updateSeriesFromArr(withForwardedApiKey(event), id, body);
	return Response.json(result.body, { status: result.status });
};
