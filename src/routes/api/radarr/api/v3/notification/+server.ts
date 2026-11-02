import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { listNotifications, createNotification } from '#lib/server/arr/notifications.js';

/** GET /api/radarr/api/v3/notification */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	return Response.json(await listNotifications('radarr'));
};

/**
 * POST /api/radarr/api/v3/notification - register a webhook. Real clients
 * (Pulsarr, Notifiarr) POST a full NotificationResource here on setup.
 */
export const POST: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const body = await event.request.json().catch(() => ({}));
	return Response.json(await createNotification('radarr', body), { status: 201 });
};
