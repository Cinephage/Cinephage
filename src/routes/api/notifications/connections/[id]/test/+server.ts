import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getNotificationDeliveryService } from '#lib/server/notifications/core/delivery.js';
import { NotFoundError } from '#lib/errors/index.js';

/**
 * POST /api/notifications/connections/[id]/test
 * Sends the canned test message. A failed delivery is a 200 with
 * `{ ok: false, error }` — the request itself succeeded, the agent did not.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const result = await getNotificationDeliveryService().test(event.params.id);
	if (result.error === 'Connection not found') {
		throw new NotFoundError('Notification connection', event.params.id);
	}
	return Response.json(result);
};
