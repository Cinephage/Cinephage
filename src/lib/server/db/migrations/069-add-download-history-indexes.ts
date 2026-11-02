import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Migration 69: Add indexes on download_history for activity query performance

export const migration_v069: MigrationDefinition = {
	version: 69,
	name: 'add_download_history_indexes',
	apply: (sqlite) => {
		const indexes = [
			`CREATE INDEX IF NOT EXISTS "idx_dh_status" ON "download_history" ("status")`,
			`CREATE INDEX IF NOT EXISTS "idx_dh_movie" ON "download_history" ("movie_id")`,
			`CREATE INDEX IF NOT EXISTS "idx_dh_series" ON "download_history" ("series_id")`,
			`CREATE INDEX IF NOT EXISTS "idx_dh_created_at" ON "download_history" ("created_at")`,
			`CREATE INDEX IF NOT EXISTS "idx_dh_protocol" ON "download_history" ("protocol")`,
			`CREATE INDEX IF NOT EXISTS "idx_dh_indexer_name" ON "download_history" ("indexer_name")`,
			`CREATE INDEX IF NOT EXISTS "idx_dh_download_client" ON "download_history" ("download_client_id")`,
			`CREATE INDEX IF NOT EXISTS "idx_dh_status_created" ON "download_history" ("status", "created_at")`
		];
		for (const sql of indexes) {
			sqlite.prepare(sql).run();
		}
		logger.info('[SchemaSync] Added download_history indexes for activity query performance');
	}
};
