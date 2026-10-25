import { db } from '#lib/server/db/index.js';
import { requests } from '#lib/server/db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import { ACTIVE_REQUEST_STATUSES } from './types.js';
import { getRequestNotificationService } from './RequestNotificationService.js';

/**
 * Leaf module for the blocked-media deny path. It must never import
 * blocked-media services (they import this) — keep it to db + notifications.
 *
 * Declines every active request for the blocked media with a clear reason;
 * the requester is notified.
 */
export async function declinePendingRequestsForBlockedMedia(
	tmdbId: number,
	mediaType: 'movie' | 'series'
): Promise<number> {
	const active = await db
		.select()
		.from(requests)
		.where(
			and(
				eq(requests.tmdbId, tmdbId),
				eq(requests.mediaType, mediaType),
				inArray(requests.status, [...ACTIVE_REQUEST_STATUSES])
			)
		);

	if (active.length === 0) return 0;

	const now = new Date().toISOString();
	const notifications = getRequestNotificationService();

	for (const request of active) {
		// Conditional update: a request fulfilled or declined between the
		// select and here must not be overwritten (same CAS discipline as
		// the service transitions).
		const claimed = await db
			.update(requests)
			.set({
				status: 'declined',
				declineReason: 'Media was blocked by an administrator',
				decidedAt: now,
				updatedAt: now
			})
			.where(
				and(eq(requests.id, request.id), inArray(requests.status, [...ACTIVE_REQUEST_STATUSES]))
			)
			.returning({ id: requests.id });
		if (claimed.length === 0) continue;

		await notifications.notifyUser(
			request.requestedBy,
			'request_declined',
			{
				title: request.title,
				mediaType: request.mediaType,
				reason: 'Media was blocked by an administrator'
			},
			request.id
		);
	}

	return active.length;
}
