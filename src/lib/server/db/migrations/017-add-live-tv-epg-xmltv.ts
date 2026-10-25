import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 17: Add Live TV EPG with XMLTV support

export const migration_v017: MigrationDefinition = {
	version: 17,
	name: 'add_live_tv_epg_xmltv',
	apply: (sqlite) => {
		// EPG Sources table
		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "livetv_epg_sources" (
		"id" text PRIMARY KEY NOT NULL,
		"name" text NOT NULL,
		"url" text NOT NULL UNIQUE,
		"enabled" integer DEFAULT 1,
		"priority" integer DEFAULT 0,
		"last_refresh" text,
		"last_error" text,
		"channel_count" integer DEFAULT 0,
		"program_count" integer DEFAULT 0,
		"created_at" text,
		"updated_at" text
	)`
			)
			.run();

		// EPG Channel Map table
		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "livetv_epg_channel_map" (
		"id" text PRIMARY KEY NOT NULL,
		"source_id" text NOT NULL REFERENCES "livetv_epg_sources"("id") ON DELETE CASCADE,
		"xmltv_channel_id" text NOT NULL,
		"xmltv_channel_name" text NOT NULL,
		"channel_id" text,
		"match_score" real,
		"manual_override" integer DEFAULT 0
	)`
			)
			.run();

		// EPG Programs table
		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "livetv_epg_programs" (
		"id" text PRIMARY KEY NOT NULL,
		"source_id" text NOT NULL REFERENCES "livetv_epg_sources"("id") ON DELETE CASCADE,
		"xmltv_channel_id" text NOT NULL,
		"channel_id" text,
		"title" text NOT NULL,
		"description" text,
		"start_time" text NOT NULL,
		"end_time" text NOT NULL,
		"category" text,
		"cached_at" text
	)`
			)
			.run();

		// Create indexes
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_epg_sources_enabled" ON "livetv_epg_sources" ("enabled")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_epg_sources_priority" ON "livetv_epg_sources" ("priority")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_epg_map_source" ON "livetv_epg_channel_map" ("source_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_epg_map_channel" ON "livetv_epg_channel_map" ("channel_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_epg_map_xmltv" ON "livetv_epg_channel_map" ("source_id", "xmltv_channel_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_epg_programs_source" ON "livetv_epg_programs" ("source_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_epg_programs_channel" ON "livetv_epg_programs" ("channel_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_epg_programs_time" ON "livetv_epg_programs" ("start_time", "end_time")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_epg_programs_channel_time" ON "livetv_epg_programs" ("channel_id", "start_time")`
			)
			.run();

		logger.info('[SchemaSync] Added Live TV EPG tables for XMLTV support');
	}
};
