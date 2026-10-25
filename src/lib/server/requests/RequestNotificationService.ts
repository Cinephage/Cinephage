import { db } from '#lib/server/db/index.js';
import { requestNotifications, user } from '#lib/server/db/schema.js';
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { requestStreamEvents } from './RequestStreamEvents.js';

export type RequestNotificationEvent =
	| 'request_pending'
	| 'request_approved_auto'
	| 'request_approved'
	| 'request_declined'
	| 'request_expired'
	| 'request_failed'
	| 'request_fulfilled';

/**
 * Durable in-app notification feed rows + the live SSE nudge. Delivery
 * targeting: pending/failed go to every admin; the rest go to the
 * requester. Per-user event-type toggles are planned for the
 * (self-writable) `notifications` preference key; until that Phase 5
 * registry exists, every event is written default-on.
 */
export class RequestNotificationService {
	private enabledFor(userId: string, event: RequestNotificationEvent): boolean {
		// Deliberately without the preference registry for now: default-on.
		// The Phase 5 preference hook plugs in here without changing callers.
		void userId;
		void event;
		return true;
	}

	async notifyAdmins(
		event: RequestNotificationEvent,
		payload: Record<string, unknown>,
		requestId?: string
	): Promise<void> {
		const admins = await db.select({ id: user.id }).from(user).where(eq(user.role, 'admin'));
		if (admins.length === 0) return;

		const rows = admins
			.filter((a) => this.enabledFor(a.id, event))
			.map((a) => ({
				userId: a.id,
				requestId: requestId ?? null,
				event,
				payload
			}));
		await db.insert(requestNotifications).values(rows);
		requestStreamEvents.emitRefresh({
			requesterId: '',
			requestId,
			notificationForUserIds: admins.map((a) => a.id),
			timestamp: new Date().toISOString()
		});
	}

	async notifyUser(
		userId: string,
		event: RequestNotificationEvent,
		payload: Record<string, unknown>,
		requestId?: string
	): Promise<void> {
		if (!this.enabledFor(userId, event)) return;
		await db.insert(requestNotifications).values({
			userId,
			requestId: requestId ?? null,
			event,
			payload
		});
		requestStreamEvents.emitRefresh({
			requesterId: userId,
			requestId,
			notificationForUserIds: [userId],
			timestamp: new Date().toISOString()
		});
	}

	async getFeed(userId: string, options: { unreadOnly?: boolean; take?: number } = {}) {
		const take = Math.floor(Math.min(Math.max(options.take ?? 50, 1), 200));
		const conditions = [eq(requestNotifications.userId, userId)];
		if (options.unreadOnly) {
			conditions.push(isNull(requestNotifications.readAt));
		}
		return db
			.select()
			.from(requestNotifications)
			.where(and(...conditions))
			.orderBy(desc(requestNotifications.createdAt))
			.limit(take);
	}

	async getUnreadCount(userId: string): Promise<number> {
		const row = await db
			.select({ count: sql<number>`count(*)` })
			.from(requestNotifications)
			.where(and(eq(requestNotifications.userId, userId), isNull(requestNotifications.readAt)));
		return row[0]?.count ?? 0;
	}

	async markRead(userId: string, ids?: string[]): Promise<void> {
		// An explicit empty selection is a no-op, never "mark everything":
		// callers that filter to nothing must not wipe the unread badge.
		if (ids && ids.length === 0) return;
		const conditions = [
			eq(requestNotifications.userId, userId),
			isNull(requestNotifications.readAt)
		];
		if (ids && ids.length > 0) {
			conditions.push(inArray(requestNotifications.id, ids));
		}
		await db
			.update(requestNotifications)
			.set({ readAt: new Date().toISOString() })
			.where(and(...conditions));
	}

	/**
	 * Drops read notifications older than the horizon. Called from the
	 * periodic sweep so the admin fan-out (one row per admin per event)
	 * cannot grow unbounded.
	 */
	async pruneReadNotifications(olderThanDays = 30): Promise<number> {
		const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
		const removed = await db
			.delete(requestNotifications)
			.where(and(isNotNull(requestNotifications.readAt), lt(requestNotifications.readAt, cutoff)))
			.returning({ id: requestNotifications.id });
		return removed.length;
	}
}

let _instance: RequestNotificationService | null = null;

export function getRequestNotificationService(): RequestNotificationService {
	if (!_instance) {
		_instance = new RequestNotificationService();
	}
	return _instance;
}
