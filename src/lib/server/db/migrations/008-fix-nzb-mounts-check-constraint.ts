import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 8: Fix nzb_stream_mounts status CHECK constraint to include extraction states

export const migration_v008: MigrationDefinition = {
	version: 8,
	name: 'fix_nzb_mounts_check_constraint',
	apply: (sqlite) => {
		// SQLite doesn't support ALTER TABLE to modify CHECK constraints
		// Need to recreate the table with the correct constraint

		// Create new table with correct CHECK constraint
		sqlite
			.prepare(
				`CREATE TABLE "nzb_stream_mounts_new" (
			"id" text PRIMARY KEY NOT NULL,
			"nzb_hash" text NOT NULL UNIQUE,
			"title" text NOT NULL,
			"indexer_id" text REFERENCES "indexers"("id") ON DELETE SET NULL,
			"release_guid" text,
			"download_url" text,
			"movie_id" text REFERENCES "movies"("id") ON DELETE CASCADE,
			"series_id" text REFERENCES "series"("id") ON DELETE CASCADE,
			"season_number" integer,
			"episode_ids" text,
			"file_count" integer NOT NULL,
			"total_size" integer NOT NULL,
			"media_files" text NOT NULL,
			"rar_info" text,
			"password" text,
			"status" text DEFAULT 'pending' NOT NULL CHECK ("status" IN ('pending', 'parsing', 'ready', 'requires_extraction', 'downloading', 'extracting', 'error', 'expired')),
			"error_message" text,
			"streamability" text,
			"extracted_file_path" text,
			"extraction_progress" integer,
			"last_accessed_at" text,
			"access_count" integer DEFAULT 0,
			"expires_at" text,
			"created_at" text,
			"updated_at" text
		)`
			)
			.run();

		// Copy data from old table
		sqlite
			.prepare(
				`INSERT INTO "nzb_stream_mounts_new" SELECT
			id, nzb_hash, title, indexer_id, release_guid, download_url,
			movie_id, series_id, season_number, episode_ids,
			file_count, total_size, media_files, rar_info, password,
			status, error_message, streamability, extracted_file_path, extraction_progress,
			last_accessed_at, access_count, expires_at, created_at, updated_at
		FROM "nzb_stream_mounts"`
			)
			.run();

		// Drop old table
		sqlite.prepare(`DROP TABLE "nzb_stream_mounts"`).run();

		// Rename new table
		sqlite.prepare(`ALTER TABLE "nzb_stream_mounts_new" RENAME TO "nzb_stream_mounts"`).run();

		// Recreate indexes
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_nzb_mounts_status" ON "nzb_stream_mounts" ("status")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_nzb_mounts_movie" ON "nzb_stream_mounts" ("movie_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_nzb_mounts_series" ON "nzb_stream_mounts" ("series_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_nzb_mounts_expires" ON "nzb_stream_mounts" ("expires_at")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_nzb_mounts_hash" ON "nzb_stream_mounts" ("nzb_hash")`
			)
			.run();

		logger.info(
			'[SchemaSync] Fixed nzb_stream_mounts status CHECK constraint to include extraction states'
		);
	}
};
