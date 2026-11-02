import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { buildParseResult } from '#lib/server/arr/parse.js';

/** GET /api/sonarr/api/v3/parse?title=... */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const title = event.url.searchParams.get('title') ?? '';
	return Response.json(buildParseResult(title));
};
