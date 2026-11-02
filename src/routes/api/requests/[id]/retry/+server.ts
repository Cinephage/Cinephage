/**
 * Retry a failed request (re-runs the approval step). Admin only.
 */

import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getRequestService } from '#lib/server/requests/RequestService.js';
import { toRequestErrorResponse } from '#lib/server/requests/http.js';
import { requesterFromLocals } from '#lib/server/requests/http.js';

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const requester = requesterFromLocals(event.locals);
	if (!requester) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const retried = await getRequestService().retry(event.params.id, requester);
		return Response.json({ success: true, request: retried });
	} catch (error) {
		return toRequestErrorResponse(error);
	}
};
