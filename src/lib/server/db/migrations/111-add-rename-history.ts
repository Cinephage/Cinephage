import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v111: MigrationDefinition = {
	version: 111,
	name: 'add_rename_history',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'rename_history')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "rename_history" (
						"id" text PRIMARY KEY NOT NULL,
						"file_id" text NOT NULL,
						"media_type" text NOT NULL,
						"old_path" text NOT NULL,
						"new_path" text NOT NULL,
						"success" integer NOT NULL DEFAULT 0,
						"error" text,
						"operation" text NOT NULL DEFAULT 'rename',
						"created_at" text NOT NULL
					)`
				)
				.run();

			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_rename_history_file" ON "rename_history" ("file_id")`
				)
				.run();

			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_rename_history_created" ON "rename_history" ("created_at")`
				)
				.run();
		}

		logger.info('[SchemaSync] Added rename_history table (v111)');
	}
};
