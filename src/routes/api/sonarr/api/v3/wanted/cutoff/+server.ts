import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildWantedCutoff } from '#lib/server/arr/wanted.js';

/** GET /api/sonarr/api/v3/wanted/cutoff */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const { url } = event;
	const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1;
	const pageSize = Number.parseInt(url.searchParams.get('pageSize') ?? '10', 10) || 10;
	const sortKey = url.searchParams.get('sortKey');
	const sortDirection = url.searchParams.get('sortDirection') ?? 'default';

	return Response.json(
		await buildWantedCutoff('Sonarr', { page, pageSize, sortKey, sortDirection })
	);
};
