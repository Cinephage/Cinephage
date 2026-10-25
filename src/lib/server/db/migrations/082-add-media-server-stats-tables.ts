import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
export const migration_v082: MigrationDefinition = {
	version: 82,
	name: 'add_media_server_stats_tables',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'media_server_synced_items')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "media_server_synced_items" (
						"id" text PRIMARY KEY NOT NULL,
						"server_id" text NOT NULL REFERENCES "media_browser_servers"("id") ON DELETE CASCADE,
						"server_item_id" text NOT NULL,
						"tmdb_id" integer,
						"tvdb_id" integer,
						"imdb_id" text,
						"title" text NOT NULL,
						"year" integer,
						"item_type" text NOT NULL,
						"series_name" text,
						"season_number" integer,
						"episode_number" integer,
						"play_count" integer DEFAULT 0,
						"last_played_date" text,
						"played_percentage" real,
						"is_played" integer DEFAULT 0,
						"video_codec" text,
						"video_profile" text,
						"video_bit_depth" integer,
						"width" integer,
						"height" integer,
						"is_hdr" integer DEFAULT 0,
						"hdr_format" text,
						"video_bitrate" integer,
						"audio_codec" text,
						"audio_channels" integer,
						"audio_channel_layout" text,
						"audio_bitrate" integer,
						"audio_languages" text DEFAULT '[]',
						"subtitle_languages" text DEFAULT '[]',
						"container_format" text,
						"file_size" integer,
						"bitrate" integer,
						"duration" integer,
						"last_synced_at" text NOT NULL,
						"created_at" text,
						"updated_at" text
					)`
				)
				.run();
		}
		if (!tableExists(sqlite, 'media_server_synced_runs')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "media_server_synced_runs" (
						"id" text PRIMARY KEY NOT NULL,
						"server_id" text NOT NULL REFERENCES "media_browser_servers"("id") ON DELETE CASCADE,
						"status" text NOT NULL,
						"items_synced" integer DEFAULT 0,
						"items_added" integer DEFAULT 0,
						"items_updated" integer DEFAULT 0,
						"items_removed" integer DEFAULT 0,
						"error_message" text,
						"started_at" text NOT NULL,
						"completed_at" text,
						"duration" integer,
						"created_at" text
					)`
				)
				.run();
		}
		sqlite
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS "idx_synced_items_unique" ON "media_server_synced_items" ("server_id", "server_item_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_synced_items_tmdb_id" ON "media_server_synced_items" ("tmdb_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_synced_items_tvdb_id" ON "media_server_synced_items" ("tvdb_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_synced_items_item_type" ON "media_server_synced_items" ("item_type")`
			)
			.run();
		logger.info('[SchemaSync] Added media_server_stats_tables (v82)');
	}
};
