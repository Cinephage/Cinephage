import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildSonarrCalendar } from '#lib/server/arr/calendar.js';

/** GET /api/sonarr/api/v3/calendar */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const { url } = event;
	const startParam = url.searchParams.get('start');
	const endParam = url.searchParams.get('end');
	const unmonitored = url.searchParams.get('unmonitored') === 'true';

	return Response.json(
		await buildSonarrCalendar({
			start: startParam ? new Date(startParam) : null,
			end: endParam ? new Date(endParam) : null,
			unmonitored
		})
	);
};
