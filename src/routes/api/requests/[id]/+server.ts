/**
 * Delete a request.
 *
 * DELETE /api/requests/[id] — a PENDING request is cancelled by its owner
 * (or an admin): no reason, no cooldown, the row stays as the decision
 * record. A decided request (declined/expired/cancelled/fulfilled) is
 * removed outright by its owner or an admin. Active non-pending statuses
 * 409 — decline/retry are the verbs there.
 */

import type { RequestHandler } from './$types.js';
import { getRequestService } from '#lib/server/requests/RequestService.js';
import { toRequestErrorResponse, requesterFromLocals } from '#lib/server/requests/http.js';

export const DELETE: RequestHandler = async (event) => {
	const requester = requesterFromLocals(event.locals);
	if (!requester) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const result = await getRequestService().cancelOrRemove(event.params.id, requester);
		if (result.kind === 'cancelled') {
			return Response.json({ success: true, request: result.request });
		}
		return Response.json({ success: true, deleted: true });
	} catch (error) {
		return toRequestErrorResponse(error);
	}
};
