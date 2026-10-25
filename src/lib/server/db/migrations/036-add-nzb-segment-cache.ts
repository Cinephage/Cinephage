import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 36: Add nzb_segment_cache table for persistent prefetched segments

export const migration_v036: MigrationDefinition = {
	version: 36,
	name: 'add_nzb_segment_cache',
	apply: (sqlite) => {
		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "nzb_segment_cache" (
			"id" text PRIMARY KEY NOT NULL,
			"mount_id" text NOT NULL REFERENCES "nzb_stream_mounts"("id") ON DELETE CASCADE,
			"file_index" integer NOT NULL,
			"segment_index" integer NOT NULL,
			"data" blob NOT NULL,
			"size" integer NOT NULL,
			"created_at" text
		)`
			)
			.run();

		// Create indexes
		sqlite
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS "idx_segment_cache_lookup" ON "nzb_segment_cache" ("mount_id", "file_index", "segment_index")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_segment_cache_mount" ON "nzb_segment_cache" ("mount_id")`
			)
			.run();

		logger.info('[SchemaSync] Created nzb_segment_cache table for persistent prefetched segments');
	}
};
