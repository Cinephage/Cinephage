import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { searchReleasesForSeries, grabRelease } from '#lib/server/arr/release.js';
import { withForwardedApiKey } from '#lib/server/arr/internalFetch.js';

/** GET /api/sonarr/api/v3/release?seriesId=...&episodeId=...&seasonNumber=... */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const { url } = event;
	const seriesId = Number.parseInt(url.searchParams.get('seriesId') ?? '', 10);
	if (Number.isNaN(seriesId)) return Response.json([]);

	const episodeIdParam = url.searchParams.get('episodeId');
	const episodeArrId = episodeIdParam ? Number.parseInt(episodeIdParam, 10) : undefined;
	const seasonNumberParam = url.searchParams.get('seasonNumber');
	const seasonNumber = seasonNumberParam ? Number.parseInt(seasonNumberParam, 10) : undefined;

	return Response.json(
		await searchReleasesForSeries(withForwardedApiKey(event), seriesId, {
			episodeArrId,
			seasonNumber
		})
	);
};

/** POST /api/sonarr/api/v3/release - grab the posted release. */
export const POST: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json().catch(() => ({}));
	const result = await grabRelease(withForwardedApiKey(event), 'Sonarr', body);
	return Response.json(result.body, { status: result.status });
};
