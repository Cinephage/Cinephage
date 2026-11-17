import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import {
	NotificationConnectionError,
	NotificationConnectionStore
} from '#lib/server/notifications/core/connections.js';
import { notificationConnectionCreateSchema } from '#lib/validation/schemas.js';
import { ValidationError } from '#lib/errors/index.js';

/**
 * GET /api/notifications/connections
 * Lists configured agents. Secret values are never returned; see
 * `configuredSecrets` for which secret fields already hold a value.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	const store = new NotificationConnectionStore();
	return Response.json({ connections: await store.list() });
};

/** POST /api/notifications/connections — create an agent. */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await parseBody(event.request, notificationConnectionCreateSchema);
	try {
		const store = new NotificationConnectionStore();
		const connection = await store.create({
			name: body.name,
			provider: body.provider,
			enabled: body.enabled,
			events: body.events ?? [],
			config: body.config ?? {}
		});
		return Response.json({ connection }, { status: 201 });
	} catch (error) {
		if (error instanceof NotificationConnectionError) {
			throw new ValidationError(error.message);
		}
		throw error;
	}
};
