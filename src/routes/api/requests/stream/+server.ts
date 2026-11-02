/**
 * Live request updates over SSE.
 *
 * GET /api/requests/stream — 'requests:refresh' events, filtered per user:
 * admins receive everything, viewers only events about their own requests
 * or their own notifications.
 */

import type { RequestHandler } from './$types';
import { createSSEStream } from '#lib/server/sse.js';
import {
	requestStreamEvents,
	type RequestRefreshPayload
} from '#lib/server/requests/RequestStreamEvents.js';
import { requesterFromLocals } from '#lib/server/requests/http.js';

export const GET: RequestHandler = async (event) => {
	const requester = requesterFromLocals(event.locals);
	if (!requester) {
		return new Response('Unauthorized', { status: 401 });
	}

	const userId = requester.id;
	const isAdmin = requester.role === 'admin';

	return createSSEStream((send) => {
		const onRefresh = (payload: RequestRefreshPayload) => {
			if (!isAdmin) {
				const isOwnRequest = payload.requesterId === userId;
				const isOwnNotification = (payload.notificationForUserIds ?? []).includes(userId);
				if (!isOwnRequest && !isOwnNotification) return;
			}
			void send('requests:refresh', {
				requestId: payload.requestId,
				timestamp: payload.timestamp
			});
		};

		requestStreamEvents.on('requests:refresh', onRefresh);
		return () => {
			requestStreamEvents.off('requests:refresh', onRefresh);
		};
	});
};
