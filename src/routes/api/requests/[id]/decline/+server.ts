/**
 * Decline a request with a reason (required). Admin only.
 */

import type { RequestHandler } from './$types.js';
import { parseBody } from '#lib/server/api/validate.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getRequestService } from '#lib/server/requests/RequestService.js';
import { declineRequestSchema, toRequestErrorResponse } from '#lib/server/requests/http.js';
import { requesterFromLocals } from '#lib/server/requests/http.js';

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const requester = requesterFromLocals(event.locals);
	if (!requester) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const { reason } = await parseBody(event.request, declineRequestSchema);
		const declined = await getRequestService().decline(event.params.id, requester, reason);
		return Response.json({ success: true, request: declined });
	} catch (error) {
		return toRequestErrorResponse(error);
	}
};
