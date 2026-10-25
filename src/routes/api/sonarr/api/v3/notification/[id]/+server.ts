import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import {
	getNotificationByArrId,
	updateNotificationByArrId,
	deleteNotificationByArrId
} from '#lib/server/arr/notifications.js';

/** GET /api/sonarr/api/v3/notification/{id} */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const id = Number.parseInt(event.params.id, 10);
	if (Number.isNaN(id)) error(400, 'Invalid notification id');

	const notification = await getNotificationByArrId('sonarr', id);
	if (!notification) error(404, 'Notification not found');

	return Response.json(notification);
};

/** PUT /api/sonarr/api/v3/notification/{id} - update an existing webhook. */
export const PUT: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const id = Number.parseInt(event.params.id, 10);
	if (Number.isNaN(id)) error(400, 'Invalid notification id');

	const body = await event.request.json().catch(() => ({}));
	const notification = await updateNotificationByArrId('sonarr', id, body);
	if (!notification) error(404, 'Notification not found');

	return Response.json(notification);
};

/** DELETE /api/sonarr/api/v3/notification/{id} */
export const DELETE: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const id = Number.parseInt(event.params.id, 10);
	if (Number.isNaN(id)) error(400, 'Invalid notification id');

	await deleteNotificationByArrId('sonarr', id);
	return Response.json({});
};
