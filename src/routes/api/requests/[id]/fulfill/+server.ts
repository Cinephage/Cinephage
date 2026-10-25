/**
 * Mark a request fulfilled (admin override when disk truth and desire
 * disagree). Admin only.
 */

import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getRequestService } from '#lib/server/requests/RequestService.js';
import { toRequestErrorResponse } from '#lib/server/requests/http.js';

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const fulfilled = await getRequestService().markFulfilledAdmin(event.params.id);
		return Response.json({ success: true, request: fulfilled });
	} catch (error) {
		return toRequestErrorResponse(error);
	}
};
