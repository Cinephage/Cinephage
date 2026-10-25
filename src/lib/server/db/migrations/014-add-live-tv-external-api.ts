import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 14: Add new Live TV feature (external API-based)

export const migration_v014: MigrationDefinition = {
	version: 14,
	name: 'add_live_tv_external_api',
	apply: (sqlite) => {
		// Create Live TV tables
		if (!tableExists(sqlite, 'livetv_channels_cache')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "livetv_channels_cache" (
					"id" text PRIMARY KEY NOT NULL,
					"name" text NOT NULL,
					"country" text NOT NULL,
					"country_name" text,
					"logo" text,
					"status" text DEFAULT 'online' CHECK ("status" IN ('online', 'offline')),
					"viewers" integer DEFAULT 0,
					"cached_at" text,
					"updated_at" text
				)`
				)
				.run();
		}

		if (!tableExists(sqlite, 'livetv_categories')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "livetv_categories" (
					"id" text PRIMARY KEY NOT NULL,
					"name" text NOT NULL,
					"position" integer NOT NULL DEFAULT 0,
					"color" text,
					"created_at" text
				)`
				)
				.run();
		}

		if (!tableExists(sqlite, 'livetv_lineup')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "livetv_lineup" (
					"id" text PRIMARY KEY NOT NULL,
					"channel_id" text NOT NULL,
					"display_name" text,
					"channel_number" integer,
					"category_id" text REFERENCES "livetv_categories"("id") ON DELETE SET NULL,
					"position" integer NOT NULL DEFAULT 0,
					"enabled" integer DEFAULT 1,
					"added_at" text
				)`
				)
				.run();
		}

		if (!tableExists(sqlite, 'livetv_events_cache')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "livetv_events_cache" (
					"id" text PRIMARY KEY NOT NULL,
					"sport" text NOT NULL,
					"home_team" text,
					"away_team" text,
					"home_team_logo" text,
					"away_team_logo" text,
					"tournament" text,
					"country" text,
					"status" text DEFAULT 'upcoming' CHECK ("status" IN ('live', 'upcoming', 'finished')),
					"start_time" text NOT NULL,
					"end_time" text,
					"channels" text,
					"cached_at" text
				)`
				)
				.run();
		}

		if (!tableExists(sqlite, 'livetv_settings')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "livetv_settings" (
					"key" text PRIMARY KEY NOT NULL,
					"value" text NOT NULL
				)`
				)
				.run();
		}

		// Create indexes
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_cache_country" ON "livetv_channels_cache" ("country")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_cache_status" ON "livetv_channels_cache" ("status")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_categories_position" ON "livetv_categories" ("position")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_lineup_position" ON "livetv_lineup" ("position")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_lineup_category" ON "livetv_lineup" ("category_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_lineup_channel" ON "livetv_lineup" ("channel_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_events_sport" ON "livetv_events_cache" ("sport")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_events_status" ON "livetv_events_cache" ("status")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_events_time" ON "livetv_events_cache" ("start_time")`
			)
			.run();

		logger.info('[SchemaSync] Added Live TV feature tables');
	}
};
