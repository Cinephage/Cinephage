import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 6: Add NZB streaming tables

export const migration_v006: MigrationDefinition = {
	version: 6,
	name: 'add_nzb_streaming_tables',
	apply: (sqlite) => {
		// Create NNTP servers table
		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "nntp_servers" (
				"id" text PRIMARY KEY NOT NULL,
				"name" text NOT NULL,
				"host" text NOT NULL,
				"port" integer NOT NULL DEFAULT 563,
				"use_ssl" integer DEFAULT true,
				"username" text,
				"password" text,
				"max_connections" integer DEFAULT 10,
				"priority" integer DEFAULT 1,
				"enabled" integer DEFAULT true,
				"download_client_id" text REFERENCES "download_clients"("id") ON DELETE SET NULL,
				"auto_fetched" integer DEFAULT false,
				"last_tested_at" text,
				"test_result" text,
				"test_error" text,
				"created_at" text,
				"updated_at" text
			)`
			)
			.run();

		// Create NZB stream mounts table
		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "nzb_stream_mounts" (
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
				"last_accessed_at" text,
				"access_count" integer DEFAULT 0,
				"expires_at" text,
				"created_at" text,
				"updated_at" text
			)`
			)
			.run();

		// Create indexes
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_nntp_servers_enabled" ON "nntp_servers" ("enabled")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_nntp_servers_priority" ON "nntp_servers" ("priority")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_nntp_servers_download_client" ON "nntp_servers" ("download_client_id")`
			)
			.run();
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

		logger.info('[SchemaSync] Created NZB streaming tables (nntp_servers, nzb_stream_mounts)');
	}
};
