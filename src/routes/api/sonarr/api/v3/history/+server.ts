import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildHistory } from '#lib/server/arr/history.js';

/** GET /api/sonarr/api/v3/history */
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

	return Response.json(await buildHistory('Sonarr', { page, pageSize, sortKey, sortDirection }));
};
