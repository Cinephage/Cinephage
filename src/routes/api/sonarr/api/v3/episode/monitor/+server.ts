import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { monitorEpisodesFromArr } from '#lib/server/arr/libraryWrite.js';
import { withForwardedApiKey } from '#lib/server/arr/internalFetch.js';

/**
 * PUT /api/sonarr/api/v3/episode/monitor - bulk episode monitoring.
 * Seerr calls this after re-adding/updating a series, to monitor specific
 * episodes in the seasons being requested.
 */
export const PUT: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json().catch(() => ({}));
	const episodeIds = Array.isArray(body.episodeIds)
		? body.episodeIds.filter((id: unknown): id is number => Number.isInteger(id))
		: [];
	const monitored = typeof body.monitored === 'boolean' ? body.monitored : true;

	const result = await monitorEpisodesFromArr(withForwardedApiKey(event), episodeIds, monitored);
	return Response.json(result.body, { status: result.status });
};
