import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildSeriesByArrId } from '#lib/server/arr/series.js';
import { updateSeriesFromArr, deleteSeriesFromArr } from '#lib/server/arr/libraryWrite.js';
import { withForwardedApiKey } from '#lib/server/arr/internalFetch.js';

/** GET /api/sonarr/api/v3/series/{id} */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const id = Number.parseInt(event.params.id, 10);
	if (Number.isNaN(id)) error(400, 'Invalid series id');

	const item = await buildSeriesByArrId(id);
	if (!item) error(404, 'Series not found');

	return Response.json(item);
};

/** PUT /api/sonarr/api/v3/series/{id} - update monitored/quality profile/type. */
export const PUT: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const id = Number.parseInt(event.params.id, 10);
	if (Number.isNaN(id)) error(400, 'Invalid series id');

	const body = await event.request.json().catch(() => ({}));
	const result = await updateSeriesFromArr(withForwardedApiKey(event), id, body);
	return Response.json(result.body, { status: result.status });
};

/** DELETE /api/sonarr/api/v3/series/{id}?deleteFiles=true - remove from library. */
export const DELETE: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const id = Number.parseInt(event.params.id, 10);
	if (Number.isNaN(id)) error(400, 'Invalid series id');

	const deleteFiles = event.url.searchParams.get('deleteFiles') === 'true';
	const result = await deleteSeriesFromArr(withForwardedApiKey(event), id, { deleteFiles });
	return Response.json(result.body, { status: result.status });
};
