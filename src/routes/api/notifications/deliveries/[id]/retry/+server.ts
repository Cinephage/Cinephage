import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getNotificationDeliveryService } from '#lib/server/notifications/core/delivery.js';
import { NotFoundError } from '#lib/errors/index.js';

/**
 * POST /api/notifications/deliveries/[id]/retry
 * Re-sends one logged attempt with the message that was stored with it.
 * A failed send is a 200 with `{ ok: false }` — the retry itself succeeded.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const result = await getNotificationDeliveryService().retry(event.params.id);
	if (result.error === 'Delivery not found') {
		throw new NotFoundError('Notification delivery', event.params.id);
	}
	return Response.json(result);
};
