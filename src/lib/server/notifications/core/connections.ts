/**
 * Connection store — the admin-configured agents.
 *
 * Responsibilities kept here (and nowhere else): persistence, encryption of
 * the provider config at rest, redaction for the API, and the rule that a
 * blank secret on update means "keep the stored one". Delivery and transport
 * know nothing about any of it.
 */

import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '#lib/server/db/index.js';
import { notificationConnections, notificationDeliveries } from '#lib/server/db/schema.js';
import {
	decryptCredential,
	encryptCredential,
	isEncryptedCredential
} from '#lib/server/crypto/credentialsCrypto.js';
import { ALL_EVENTS, SUBSCRIBABLE_EVENTS } from './events.js';
import { getNotificationAgent } from './registry.js';
import type { AgentConfig } from './agent.js';

const CONFIG_PURPOSE = 'notification-config';

export interface NotificationConnectionInput {
	name: string;
	provider: string;
	enabled?: boolean;
	events: string[];
	config: AgentConfig;
}

export interface NotificationConnectionPublic {
	id: string;
	name: string;
	provider: string;
	enabled: boolean;
	events: string[];
	config: AgentConfig;
	/** Secret field keys that hold a stored value (the value itself is never returned). */
	configuredSecrets: string[];
	consecutiveFailures: number;
	disabledUntil: string | null;
	lastSuccessAt: string | null;
	lastAttemptAt: string | null;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface NotificationConnectionRecord extends NotificationConnectionPublic {
	/** Decrypted config, including secrets — server-side use only. */
	config: AgentConfig;
}

export interface NotificationDeliveryRecord {
	id: string;
	connectionId: string;
	event: string;
	ok: boolean;
	statusCode: number | null;
	error: string | null;
	durationMs: number | null;
	createdAt: string;
	connectionName?: string | null;
	connectionProvider?: string | null;
}

function encryptConfig(connectionId: string, config: AgentConfig): string {
	return encryptCredential(CONFIG_PURPOSE, connectionId, JSON.stringify(config));
}

function decryptConfig(connectionId: string, stored: string): AgentConfig {
	const raw = isEncryptedCredential(stored)
		? decryptCredential(
				CONFIG_PURPOSE,
				connectionId,
				stored,
				`notification-connection:${connectionId}`
			)
		: stored;
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as AgentConfig) : {};
	} catch {
		return {};
	}
}

function sanitizeEvents(events: string[] | undefined): string[] {
	if (!events || events.length === 0) return [...SUBSCRIBABLE_EVENTS];
	if (events.includes(ALL_EVENTS)) return [ALL_EVENTS];
	const allowed = new Set<string>(SUBSCRIBABLE_EVENTS);
	const unique = [...new Set(events)].filter((event) => allowed.has(event));
	return unique.length > 0 ? unique : [...SUBSCRIBABLE_EVENTS];
}

/** Drops unknown keys and coerces booleans/numbers, keeping the shape stable. */
function sanitizeConfig(providerId: string, config: AgentConfig): AgentConfig {
	const agent = getNotificationAgent(providerId);
	if (!agent) return {};
	const clean: AgentConfig = {};
	for (const field of agent.fields) {
		const value = config[field.key];
		if (field.type === 'boolean') {
			clean[field.key] = value === true || value === 'true';
			continue;
		}
		if (field.type === 'number') {
			const numeric = Number(value);
			clean[field.key] = Number.isFinite(numeric) ? numeric : (field.default ?? 0);
			continue;
		}
		if (value === undefined || value === null) continue;
		clean[field.key] = String(value).trim();
	}
	return clean;
}

/** A blank secret field on update keeps the stored value; everything else replaces. */
function preserveSecrets(
	providerId: string,
	incoming: AgentConfig,
	existing: AgentConfig
): AgentConfig {
	const agent = getNotificationAgent(providerId);
	if (!agent) return incoming;
	const merged: AgentConfig = { ...incoming };
	for (const field of agent.fields) {
		if (!field.secret) continue;
		if (!merged[field.key] && existing[field.key]) merged[field.key] = existing[field.key];
	}
	return merged;
}

function missingRequiredFields(providerId: string, config: AgentConfig): string[] {
	const agent = getNotificationAgent(providerId);
	if (!agent) return ['provider'];
	return agent.fields
		.filter((field) => field.required && !config[field.key])
		.map((field) => field.key);
}

function toPublic(
	row: typeof notificationConnections.$inferSelect,
	config: AgentConfig
): NotificationConnectionPublic {
	const agent = getNotificationAgent(row.provider);
	const configuredSecrets: string[] = [];
	const redacted: AgentConfig = { ...config };
	for (const field of agent?.fields ?? []) {
		if (!field.secret) continue;
		if (redacted[field.key]) configuredSecrets.push(field.key);
		redacted[field.key] = '';
	}
	return {
		id: row.id,
		name: row.name,
		provider: row.provider,
		enabled: row.enabled,
		events: Array.isArray(row.events) ? (row.events as string[]) : [],
		config: redacted,
		configuredSecrets,
		consecutiveFailures: row.consecutiveFailures,
		disabledUntil: row.disabledUntil,
		lastSuccessAt: row.lastSuccessAt,
		lastAttemptAt: row.lastAttemptAt,
		lastError: row.lastError,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

export class NotificationConnectionStore {
	async list(): Promise<NotificationConnectionPublic[]> {
		const rows = await db
			.select()
			.from(notificationConnections)
			.orderBy(asc(notificationConnections.name));
		return rows.map((row) => toPublic(row, decryptConfig(row.id, row.config)));
	}

	async listEnabledRecords(): Promise<NotificationConnectionRecord[]> {
		const rows = await db
			.select()
			.from(notificationConnections)
			.where(eq(notificationConnections.enabled, true))
			.orderBy(asc(notificationConnections.name));
		return rows.map((row) => {
			const config = decryptConfig(row.id, row.config);
			return { ...toPublic(row, config), config };
		});
	}

	async get(id: string): Promise<NotificationConnectionPublic | null> {
		const [row] = await db
			.select()
			.from(notificationConnections)
			.where(eq(notificationConnections.id, id))
			.limit(1);
		return row ? toPublic(row, decryptConfig(row.id, row.config)) : null;
	}

	async getRecord(id: string): Promise<NotificationConnectionRecord | null> {
		const [row] = await db
			.select()
			.from(notificationConnections)
			.where(eq(notificationConnections.id, id))
			.limit(1);
		if (!row) return null;
		const config = decryptConfig(row.id, row.config);
		return { ...toPublic(row, config), config };
	}

	async create(input: NotificationConnectionInput): Promise<NotificationConnectionPublic> {
		const id = randomUUID();
		const now = new Date().toISOString();
		const config = sanitizeConfig(input.provider, input.config);
		const missing = missingRequiredFields(input.provider, config);
		if (missing.length > 0) {
			throw new NotificationConnectionError(`Missing required fields: ${missing.join(', ')}`);
		}
		const [row] = await db
			.insert(notificationConnections)
			.values({
				id,
				name: input.name.trim() || defaultName(input.provider),
				provider: input.provider,
				enabled: input.enabled ?? true,
				events: sanitizeEvents(input.events),
				config: encryptConfig(id, config),
				createdAt: now,
				updatedAt: now
			})
			.returning();
		return toPublic(row, config);
	}

	async update(
		id: string,
		input: Partial<NotificationConnectionInput>
	): Promise<NotificationConnectionPublic | null> {
		const [existing] = await db
			.select()
			.from(notificationConnections)
			.where(eq(notificationConnections.id, id))
			.limit(1);
		if (!existing) return null;

		const provider = input.provider ?? existing.provider;
		const existingConfig = decryptConfig(existing.id, existing.config);
		const incoming = sanitizeConfig(provider, { ...existingConfig, ...(input.config ?? {}) });
		const config = preserveSecrets(provider, incoming, existingConfig);
		const missing = missingRequiredFields(provider, config);
		if (missing.length > 0) {
			throw new NotificationConnectionError(`Missing required fields: ${missing.join(', ')}`);
		}

		const [row] = await db
			.update(notificationConnections)
			.set({
				name: input.name?.trim() || existing.name,
				provider,
				enabled: input.enabled ?? existing.enabled,
				events: input.events ? sanitizeEvents(input.events) : (existing.events as string[]),
				config: encryptConfig(id, config),
				updatedAt: new Date().toISOString()
			})
			.where(eq(notificationConnections.id, id))
			.returning();
		return toPublic(row, config);
	}

	async delete(id: string): Promise<boolean> {
		const result = await db
			.delete(notificationConnections)
			.where(eq(notificationConnections.id, id));
		return result.changes > 0;
	}

	/** Resets backoff and clears the error after a successful manual test. */
	async recordSuccess(id: string): Promise<void> {
		const now = new Date().toISOString();
		await db
			.update(notificationConnections)
			.set({
				consecutiveFailures: 0,
				disabledUntil: null,
				lastError: null,
				lastSuccessAt: now,
				lastAttemptAt: now
			})
			.where(eq(notificationConnections.id, id));
	}

	async recordFailure(id: string, error: string, disabledUntil: string | null): Promise<void> {
		const now = new Date().toISOString();
		await db
			.update(notificationConnections)
			.set({
				consecutiveFailures: sql`${notificationConnections.consecutiveFailures} + 1`,
				disabledUntil,
				lastError: error.slice(0, 500),
				lastAttemptAt: now
			})
			.where(eq(notificationConnections.id, id));
	}
}

export class NotificationConnectionError extends Error {}

function defaultName(providerId: string): string {
	return getNotificationAgent(providerId)?.label ?? providerId;
}

/** Delivery log reads live with the store: same table family, same lifecycle. */
export async function listRecentDeliveries(limit = 50): Promise<NotificationDeliveryRecord[]> {
	const rows = await db
		.select({
			id: notificationDeliveries.id,
			connectionId: notificationDeliveries.connectionId,
			event: notificationDeliveries.event,
			ok: notificationDeliveries.ok,
			statusCode: notificationDeliveries.statusCode,
			error: notificationDeliveries.error,
			durationMs: notificationDeliveries.durationMs,
			createdAt: notificationDeliveries.createdAt,
			connectionName: notificationConnections.name,
			connectionProvider: notificationConnections.provider
		})
		.from(notificationDeliveries)
		.leftJoin(
			notificationConnections,
			eq(notificationDeliveries.connectionId, notificationConnections.id)
		)
		.orderBy(desc(notificationDeliveries.createdAt))
		.limit(Math.min(Math.max(limit, 1), 200));
	return rows;
}

export async function pruneDeliveries(olderThanDays = 14): Promise<number> {
	const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
	const removed = await db
		.delete(notificationDeliveries)
		.where(and(lt(notificationDeliveries.createdAt, cutoff)))
		.returning({ id: notificationDeliveries.id });
	return removed.length;
}
