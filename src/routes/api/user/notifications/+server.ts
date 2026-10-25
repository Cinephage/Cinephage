/**
 * Own in-app notification feed (request lifecycle events).
 *
 * GET /api/user/notifications — own rows; ?unread=true filters; ?take=N.
 */

import type { RequestHandler } from './$types.js';
import { getRequestNotificationService } from '#lib/server/requests/RequestNotificationService.js';

export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const service = getRequestNotificationService();
	const feed = await service.getFeed(event.locals.user.id, {
		unreadOnly: event.url.searchParams.get('unread') === 'true',
		take: Number(event.url.searchParams.get('take') ?? 50)
	});
	const unreadCount = await service.getUnreadCount(event.locals.user.id);

	return Response.json({ success: true, notifications: feed, unreadCount });
};
