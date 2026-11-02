import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { pushRelease } from '#lib/server/arr/releasePush.js';
import { withForwardedApiKey } from '#lib/server/arr/internalFetch.js';

/** POST /api/radarr/api/v3/release/push - autobrr/RSS-tool release push. */
export const POST: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json().catch(() => ({}));
	const result = await pushRelease('radarr', body, withForwardedApiKey(event));
	return Response.json(result.body, { status: result.status });
};
