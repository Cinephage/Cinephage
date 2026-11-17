import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import {
	NotificationConnectionError,
	NotificationConnectionStore
} from '#lib/server/notifications/core/connections.js';
import { getNotificationAgent } from '#lib/server/notifications/core/registry.js';
import { renderTestNotification } from '#lib/server/notifications/core/render.js';
import { notificationConnectionTestSchema } from '#lib/validation/schemas.js';
import { NotFoundError } from '#lib/errors/index.js';

/**
 * POST /api/notifications/test
 *
 * Tests a *draft* config before it is saved, so a wrong token or a typo'd URL
 * never gets stored. Editing an existing connection sends its id, and the
 * store fills in the secrets the form deliberately does not round-trip.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await parseBody(event.request, notificationConnectionTestSchema);
	const agent = getNotificationAgent(body.provider);
	if (!agent) throw new NotFoundError('Notification provider', body.provider);

	const store = new NotificationConnectionStore();
	try {
		const config = await store.prepareDraftConfig(
			body.provider,
			body.config ?? {},
			body.connectionId
		);
		const result = await agent.test(config, renderTestNotification());
		return Response.json(result);
	} catch (error) {
		if (error instanceof NotificationConnectionError) {
			return Response.json({ ok: false, error: error.message }, { status: 400 });
		}
		throw error;
	}
};
