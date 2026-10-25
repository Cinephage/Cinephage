import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Migration 46: Add activity_details table for granular activity logging

export const migration_v046: MigrationDefinition = {
	version: 46,
	name: 'add_activity_details_table',
	apply: (sqlite) => {
		// Create activity_details table
		sqlite
			.prepare(
				`
			CREATE TABLE IF NOT EXISTS "activity_details" (
				"id" text PRIMARY KEY NOT NULL,
				"activity_id" text NOT NULL REFERENCES "activities"("id") ON DELETE CASCADE,
				"score_breakdown" text,
				"replaced_movie_file_id" text REFERENCES "movie_files"("id") ON DELETE SET NULL,
				"replaced_episode_file_ids" text,
				"replaced_file_path" text,
				"replaced_file_quality" text,
				"replaced_file_score" integer,
				"replaced_file_size" integer,
				"search_results" text,
				"selection_reason" text,
				"import_log" text,
				"files_imported" text,
				"files_deleted" text,
				"download_client_name" text,
				"download_client_type" text,
				"download_id" text,
				"info_hash" text,
				"release_info" text,
				"created_at" text,
				"updated_at" text
			)
		`
			)
			.run();

		// Create indexes
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_activity_details_activity" ON "activity_details" ("activity_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_activity_details_replaced_movie" ON "activity_details" ("replaced_movie_file_id")`
			)
			.run();

		logger.info('[SchemaSync] Created activity_details table with indexes');
	}
};
