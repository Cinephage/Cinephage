import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 160: request system foundation.
 *
 * Three tables: `requests` (user-submitted media requests carrying TMDB
 * identity until approval creates the library row), `user_request_settings`
 * (admin-managed per-user overrides — never in the self-writable
 * user_preferences table), and `request_notifications` (durable in-app
 * notification feed). Global request configuration lives in the settings
 * table under the `request_settings` key (written by the settings service,
 * not seeded here).
 */
export const migration_v160: MigrationDefinition = {
	version: 160,
	name: 'request_system',
	apply: (sqlite) => {
		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "requests" (
		"id" text PRIMARY KEY NOT NULL,
		"media_type" text NOT NULL,
		"tmdb_id" integer NOT NULL,
		"title" text NOT NULL,
		"poster_path" text,
		"year" integer,
		"movie_id" text REFERENCES "movies"("id") ON DELETE SET NULL,
		"series_id" text REFERENCES "series"("id") ON DELETE SET NULL,
		"status" text NOT NULL DEFAULT 'pending',
		"seasons" text,
		"episodes" text,
		"episode_count_snapshot" text,
		"requested_by" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
		"acting_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
		"decided_by" text REFERENCES "user"("id") ON DELETE SET NULL,
		"auto_approved" integer NOT NULL DEFAULT 0,
		"decline_reason" text,
		"failure_reason" text,
		"ignore_quota" integer NOT NULL DEFAULT 0,
		"expires_at" text,
		"decided_at" text,
		"fulfilled_at" text,
		"created_at" text NOT NULL,
		"updated_at" text NOT NULL
	)`
			)
			.run();

		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "user_request_settings" (
		"user_id" text PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
		"requests_disabled" integer NOT NULL DEFAULT 0,
		"auto_approve" integer,
		"movie_quota_limit" integer,
		"movie_quota_days" integer,
		"tv_quota_limit" integer,
		"tv_quota_days" integer,
		"updated_at" text NOT NULL
	)`
			)
			.run();

		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "request_notifications" (
		"id" text PRIMARY KEY NOT NULL,
		"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
		"request_id" text REFERENCES "requests"("id") ON DELETE CASCADE,
		"event" text NOT NULL,
		"payload" text NOT NULL,
		"read_at" text,
		"created_at" text NOT NULL
	)`
			)
			.run();

		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_requests_media_status" ON "requests" ("media_type", "tmdb_id", "status")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_requests_requester_created" ON "requests" ("requested_by", "created_at")`
			)
			.run();
		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS "idx_requests_pending" ON "requests" ("status")`)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_request_notifications_user_read" ON "request_notifications" ("user_id", "read_at")`
			)
			.run();
	}
};
