/**
 * Delivery — fan-out of one app event to every subscribed agent.
 *
 * Guarantees: publishing never throws into the caller (an import or a grab
 * must not fail because Telegram is down), one agent's failure never stops
 * another's delivery, every attempt lands in the log, and a persistently
 * failing connection backs off instead of retrying on every event.
 */

import { randomUUID } from 'node:crypto';
import { db } from '#lib/server/db/index.js';
import { notificationDeliveries } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { AgentResult } from './agent.js';
import { getNotificationAgent } from './registry.js';
import { renderNotification, renderTestNotification } from './render.js';
import {
	NotificationConnectionStore,
	pruneDeliveries,
	type NotificationConnectionRecord
} from './connections.js';
import type { NotificationEvent, NotificationPayload } from './events.js';

const logger = createChildLogger({ module: 'NotificationDelivery', logDomain: 'system' });

/** Escalating backoff after consecutive failures, in minutes. */
const FAILURE_BACKOFF_MINUTES = [5, 15, 60, 240, 720];

const DELIVERY_RETENTION_DAYS = 14;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let lastPruneAt = 0;

export class NotificationDeliveryService {
	private readonly store = new NotificationConnectionStore();

	/**
	 * Publishes one event. Fire-and-forget by design: callers should still
	 * `.catch()` (the promise resolves unless the DB itself fails), and no
	 * caller should ever await this on a request path that can be delayed.
	 */
	async publish(event: NotificationEvent, payload: NotificationPayload): Promise<void> {
		if (event === 'test') return;

		let connections: NotificationConnectionRecord[];
		try {
			connections = await this.store.listEnabledRecords();
		} catch (error) {
			logger.warn(
				{ event, error: error instanceof Error ? error.message : String(error) },
				'[Notifications] Could not load connections'
			);
			return;
		}

		const subscribers = connections.filter(
			(connection) => connection.events.includes('*') || connection.events.includes(event)
		);
		if (subscribers.length === 0) return;

		const message = renderNotification({
			...payload,
			event,
			occurredAt: payload.occurredAt ?? new Date().toISOString()
		});
		const results = await Promise.allSettled(
			subscribers.map((connection) => this.deliver(connection, message, { ...payload, event }))
		);

		for (const [index, result] of results.entries()) {
			if (result.status === 'rejected') {
				logger.warn(
					{ connection: subscribers[index].name, event },
					`[Notifications] Delivery crashed: ${String(result.reason)}`
				);
			}
		}

		void this.maybePrune();
	}

	/**
	 * Re-sends one logged attempt to its own connection. Uses the stored message
	 * so a retry says exactly what the original said, and ignores the backoff
	 * window because a manual retry is the operator asking "is it fixed now?".
	 */
	async retry(deliveryId: string): Promise<AgentResult> {
		const delivery = await this.store.getDelivery(deliveryId);
		if (!delivery) return { ok: false, error: 'Delivery not found' };
		const connection = await this.store.getRecord(delivery.connectionId);
		if (!connection) return { ok: false, error: 'Connection no longer exists' };
		const message = delivery.message ?? renderTestNotification();
		return this.deliver(connection, message, { event: delivery.event as NotificationEvent }, true);
	}

	/** Sends the canned test message to one connection; used by the admin UI. */
	async test(connectionId: string): Promise<AgentResult> {
		const connection = await this.store.getRecord(connectionId);
		if (!connection) return { ok: false, error: 'Connection not found' };
		// A manual test deliberately ignores the backoff window: it is how an
		// operator checks whether the endpoint has recovered.
		return this.deliver(connection, renderTestNotification(), { event: 'test' }, true);
	}

	private async deliver(
		connection: NotificationConnectionRecord,
		message: ReturnType<typeof renderNotification>,
		payload: NotificationPayload,
		ignoreBackoff = false
	): Promise<AgentResult> {
		const now = Date.now();
		if (!ignoreBackoff && connection.disabledUntil && Date.parse(connection.disabledUntil) > now) {
			logger.debug(
				{ connection: connection.name, until: connection.disabledUntil },
				'[Notifications] Skipping delivery while backing off'
			);
			return { ok: false, error: 'Connection is backing off after repeated failures' };
		}

		const agent = getNotificationAgent(connection.provider);
		if (!agent) {
			await this.record(
				connection.id,
				payload.event,
				{
					ok: false,
					error: `Unknown provider: ${connection.provider}`
				},
				0,
				message
			);
			await this.store.recordFailure(
				connection.id,
				`Unknown provider: ${connection.provider}`,
				null
			);
			return { ok: false, error: `Unknown provider: ${connection.provider}` };
		}

		const startedAt = Date.now();
		let result: AgentResult;
		try {
			result = await agent.send(connection.config, message, payload);
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		const durationMs = Date.now() - startedAt;

		await this.record(connection.id, payload.event, result, durationMs, message);

		if (result.ok) {
			await this.store.recordSuccess(connection.id);
			logger.info(
				{
					connection: connection.name,
					provider: connection.provider,
					event: payload.event,
					durationMs
				},
				'[Notifications] Delivered'
			);
		} else {
			const failures = connection.consecutiveFailures + 1;
			const backoffMinutes =
				FAILURE_BACKOFF_MINUTES[Math.min(failures - 1, FAILURE_BACKOFF_MINUTES.length - 1)];
			const disabledUntil = new Date(Date.now() + backoffMinutes * 60_000).toISOString();
			await this.store.recordFailure(
				connection.id,
				result.error ?? 'Delivery failed',
				disabledUntil
			);
			logger.warn(
				{
					connection: connection.name,
					provider: connection.provider,
					event: payload.event,
					status: result.status,
					failures,
					backoffMinutes
				},
				`[Notifications] Delivery failed: ${result.error ?? 'unknown error'}`
			);
		}

		return result;
	}

	private async record(
		connectionId: string,
		event: string,
		result: AgentResult,
		durationMs: number,
		message: ReturnType<typeof renderNotification>
	): Promise<void> {
		try {
			await db.insert(notificationDeliveries).values({
				id: randomUUID(),
				connectionId,
				event,
				ok: result.ok,
				statusCode: result.status ?? null,
				error: result.ok ? null : (result.error ?? 'Delivery failed').slice(0, 500),
				durationMs,
				// The rendered message is kept so a failed attempt can be retried
				// exactly, and so the log can show what was said. Capped: a
				// message is bounded by construction, but a hostile provider
				// string must not be able to grow the row.
				message: JSON.stringify(message).slice(0, 8000),
				createdAt: new Date().toISOString()
			});
		} catch (error) {
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				'[Notifications] Could not write delivery log row'
			);
		}
	}

	/** Bounded, rate-limited retention sweep; never on the delivery path's clock. */
	private async maybePrune(): Promise<void> {
		if (Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
		lastPruneAt = Date.now();
		try {
			const removed = await pruneDeliveries(DELIVERY_RETENTION_DAYS);
			if (removed > 0) {
				logger.debug({ removed }, '[Notifications] Pruned old delivery log rows');
			}
		} catch {
			// Retention is housekeeping; a failure here must not surface anywhere.
		}
	}
}

let _instance: NotificationDeliveryService | null = null;

export function getNotificationDeliveryService(): NotificationDeliveryService {
	if (!_instance) _instance = new NotificationDeliveryService();
	return _instance;
}
