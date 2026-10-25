import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
export const migration_v071: MigrationDefinition = {
	version: 71,
	name: 'add_download_queue_tombstones_table',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'download_queue_tombstones')) {
			sqlite
				.prepare(
					`CREATE TABLE "download_queue_tombstones" (
							"id" text PRIMARY KEY NOT NULL,
							"download_client_id" text NOT NULL REFERENCES "download_clients"("id") ON DELETE CASCADE,
							"protocol" text DEFAULT 'torrent' NOT NULL,
							"remote_id" text NOT NULL,
							"reason" text,
							"suppressed_until" text NOT NULL,
							"last_seen_at" text,
							"created_at" text,
							"updated_at" text
						)`
				)
				.run();
		}

		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_download_queue_tombstones_client" ON "download_queue_tombstones" ("download_client_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_download_queue_tombstones_suppressed_until" ON "download_queue_tombstones" ("suppressed_until")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS "idx_download_queue_tombstones_unique" ON "download_queue_tombstones" ("download_client_id", "protocol", "remote_id")`
			)
			.run();

		logger.info('[SchemaSync] Ensured download_queue_tombstones table and indexes');
	}
};
