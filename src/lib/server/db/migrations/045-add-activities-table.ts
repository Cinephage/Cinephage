import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Migration 45: Add activities table for unified activity tracking

export const migration_v045: MigrationDefinition = {
	version: 45,
	name: 'add_activities_table',
	apply: (sqlite) => {
		// Create activities table
		sqlite
			.prepare(
				`
			CREATE TABLE IF NOT EXISTS "activities" (
				"id" text PRIMARY KEY NOT NULL,
				"queue_item_id" text REFERENCES "download_queue"("id") ON DELETE CASCADE,
				"download_history_id" text REFERENCES "download_history"("id") ON DELETE CASCADE,
				"monitoring_history_id" text REFERENCES "monitoring_history"("id") ON DELETE CASCADE,
				"source_type" text NOT NULL CHECK ("source_type" IN ('queue', 'history', 'monitoring')),
				"media_type" text NOT NULL CHECK ("media_type" IN ('movie', 'episode')),
				"movie_id" text REFERENCES "movies"("id") ON DELETE CASCADE,
				"series_id" text REFERENCES "series"("id") ON DELETE CASCADE,
				"episode_ids" text,
				"season_number" integer,
				"media_title" text NOT NULL,
				"media_year" integer,
				"series_title" text,
				"release_title" text,
				"quality" text,
				"release_group" text,
				"size" integer,
				"indexer_id" text,
				"indexer_name" text,
				"protocol" text CHECK ("protocol" IN ('torrent', 'usenet', 'streaming')),
				"status" text NOT NULL CHECK ("status" IN ('imported', 'streaming', 'downloading', 'failed', 'rejected', 'removed', 'no_results', 'searching')),
				"status_reason" text,
				"download_progress" integer DEFAULT 0,
				"is_upgrade" integer DEFAULT false,
				"old_score" integer,
				"new_score" integer,
				"timeline" text,
				"started_at" text NOT NULL,
				"completed_at" text,
				"imported_path" text,
				"search_text" text,
				"created_at" text,
				"updated_at" text
			)
		`
			)
			.run();

		// Create indexes
		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS "idx_activities_status" ON "activities" ("status")`)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_activities_media_type" ON "activities" ("media_type")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_activities_started_at" ON "activities" ("started_at")`
			)
			.run();
		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS "idx_activities_movie" ON "activities" ("movie_id")`)
			.run();
		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS "idx_activities_series" ON "activities" ("series_id")`)
			.run();
		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS "idx_activities_source" ON "activities" ("source_type")`)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_activities_queue" ON "activities" ("queue_item_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_activities_history" ON "activities" ("download_history_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_activities_monitoring" ON "activities" ("monitoring_history_id")`
			)
			.run();

		logger.info('[SchemaSync] Created activities table with indexes');
	}
};
