import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 178: external notification agents.
 *
 * `notification_connections` holds one admin-configured agent per row: the
 * provider id, the subscribed event list and a single encrypted config
 * envelope (see the `notification-config` secret-field spec). Delivery state
 * lives on the same row so a failing endpoint backs off instead of retrying
 * on every event. `notification_deliveries` is the capped attempt log behind
 * the admin panel; it deliberately stores no message body.
 *
 * Both statements are idempotent because a fresh database replays every
 * migration on top of the DDL in schema-sync.ts.
 */
export const migration_v178: MigrationDefinition = {
	version: 178,
	name: 'notification_connections',
	apply: (sqlite) => {
		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "notification_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"enabled" integer NOT NULL DEFAULT 1,
	"events" text NOT NULL,
	"config" text NOT NULL,
	"consecutive_failures" integer NOT NULL DEFAULT 0,
	"disabled_until" text,
	"last_success_at" text,
	"last_attempt_at" text,
	"last_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
)`
			)
			.run();

		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "notification_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL REFERENCES "notification_connections"("id") ON DELETE CASCADE,
	"event" text NOT NULL,
	"ok" integer NOT NULL,
	"status_code" integer,
	"error" text,
	"duration_ms" integer,
	"created_at" text NOT NULL
)`
			)
			.run();

		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_connection"
	ON "notification_deliveries" ("connection_id", "created_at")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_created"
	ON "notification_deliveries" ("created_at")`
			)
			.run();
	}
};
