import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import {
	NotificationConnectionError,
	NotificationConnectionStore
} from '#lib/server/notifications/core/connections.js';
import { notificationConnectionUpdateSchema } from '#lib/validation/schemas.js';
import { NotFoundError, ValidationError } from '#lib/errors/index.js';

/** PATCH /api/notifications/connections/[id] — update an agent. */
export const PATCH: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await parseBody(event.request, notificationConnectionUpdateSchema);
	const store = new NotificationConnectionStore();
	try {
		const connection = await store.update(event.params.id, {
			name: body.name,
			provider: body.provider,
			enabled: body.enabled,
			events: body.events,
			config: body.config
		});
		if (!connection) throw new NotFoundError('Notification connection', event.params.id);
		return Response.json({ connection });
	} catch (error) {
		if (error instanceof NotificationConnectionError) {
			throw new ValidationError(error.message);
		}
		throw error;
	}
};

/** DELETE /api/notifications/connections/[id] — remove an agent and its log. */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const store = new NotificationConnectionStore();
	const deleted = await store.delete(event.params.id);
	if (!deleted) throw new NotFoundError('Notification connection', event.params.id);
	return Response.json({ success: true });
};
