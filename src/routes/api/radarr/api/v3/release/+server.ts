import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { searchReleasesForMovie, grabRelease } from '#lib/server/arr/release.js';
import { withForwardedApiKey } from '#lib/server/arr/internalFetch.js';

/** GET /api/radarr/api/v3/release?movieId=... */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const movieId = Number.parseInt(event.url.searchParams.get('movieId') ?? '', 10);
	if (Number.isNaN(movieId)) return Response.json([]);

	return Response.json(await searchReleasesForMovie(withForwardedApiKey(event), movieId));
};

/** POST /api/radarr/api/v3/release - grab the posted release. */
export const POST: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json().catch(() => ({}));
	const result = await grabRelease(withForwardedApiKey(event), 'Radarr', body);
	return Response.json(result.body, { status: result.status });
};
