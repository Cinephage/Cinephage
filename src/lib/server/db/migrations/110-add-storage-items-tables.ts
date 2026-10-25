import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists, columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v110: MigrationDefinition = {
	version: 110,
	name: 'add_storage_items_tables',
	apply: (sqlite) => {
		// 1. storage_items - unified directory of media items
		if (!tableExists(sqlite, 'storage_items')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "storage_items" (
						"id" text PRIMARY KEY NOT NULL,
						"item_type" text NOT NULL,
						"tmdb_id" integer,
						"tvdb_id" integer,
						"imdb_id" text,
						"title" text NOT NULL,
						"year" integer,
						"series_name" text,
						"season_number" integer,
						"episode_number" integer,
						"movie_file_id" text,
						"episode_file_id" text,
						"root_folder_id" text,
						"library_id" text,
						"source_system" text NOT NULL,
						"match_confidence" text NOT NULL,
						"first_seen_at" text NOT NULL,
						"last_reconciled_at" text
					)`
				)
				.run();
		}

		// 2. storage_item_server_links - sidecar for multi-server fan-out
		if (!tableExists(sqlite, 'storage_item_server_links')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "storage_item_server_links" (
						"storage_item_id" text NOT NULL,
						"server_id" text NOT NULL,
						"synced_item_id" text NOT NULL,
						"last_seen_at" text NOT NULL,
						PRIMARY KEY ("storage_item_id", "server_id")
					)`
				)
				.run();
		}

		// 3. storage_insights - cached dismissible findings
		if (!tableExists(sqlite, 'storage_insights')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "storage_insights" (
						"id" text PRIMARY KEY NOT NULL,
						"insight_type" text NOT NULL,
						"severity" text NOT NULL,
						"scope" text NOT NULL,
						"scope_id" text,
						"title" text NOT NULL,
						"summary" text,
						"details_json" text,
						"reclaimable_bytes" integer,
						"item_count" integer NOT NULL DEFAULT 0,
						"first_detected_at" text NOT NULL,
						"last_detected_at" text NOT NULL,
						"dismissed_at" text,
						"dismissed_by" text
					)`
				)
				.run();
		}

		// 4. Indexes on storage_items
		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS "idx_storage_items_tmdb" ON "storage_items" ("tmdb_id")`)
			.run();
		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS "idx_storage_items_tvdb" ON "storage_items" ("tvdb_id")`)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_storage_items_source" ON "storage_items" ("source_system")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_storage_items_root_folder" ON "storage_items" ("root_folder_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_storage_items_library" ON "storage_items" ("library_id")`
			)
			.run();
		// Logical uniqueness: one row per (item_type, tmdb_id, season, episode)
		// Movies have NULL season/episode - COALESCE to -1 so the unique index treats
		// them as equal regardless of NULL semantics.
		sqlite
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS "idx_storage_items_logical"
					ON "storage_items" (
						"item_type",
						"tmdb_id",
						COALESCE("season_number", -1),
						COALESCE("episode_number", -1)
					)`
			)
			.run();

		// 5. Index on storage_item_server_links
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_storage_links_synced"
					ON "storage_item_server_links" ("synced_item_id")`
			)
			.run();

		// 6. Indexes on storage_insights
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_storage_insights_type"
					ON "storage_insights" ("insight_type", "severity")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_storage_insights_scope"
					ON "storage_insights" ("scope", "scope_id")`
			)
			.run();
		// Partial index: only active (non-dismissed) insights - hot path for the UI
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_storage_insights_active"
					ON "storage_insights" ("dismissed_at") WHERE "dismissed_at" IS NULL`
			)
			.run();

		// 7. Add total_space_bytes column to root_folders (idempotent)
		if (!columnExists(sqlite, 'root_folders', 'total_space_bytes')) {
			sqlite.prepare(`ALTER TABLE "root_folders" ADD COLUMN "total_space_bytes" integer`).run();
		}

		logger.info('[SchemaSync] Added storage_items_tables (v110)');
	}
};
