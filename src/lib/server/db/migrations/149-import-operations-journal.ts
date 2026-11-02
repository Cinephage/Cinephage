import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 149: Import operations journal — durable record of each multi-step
 * import (transfer → register → retire old files → complete) so startup
 * recovery resumes or compensates deterministically. See schema.ts docs.
 *
 * Table DDL also lives in schema-sync TABLE_DEFINITIONS; this migration
 * covers existing installs.
 */
const DDL = [
	`CREATE TABLE IF NOT EXISTS "import_operations" (
		"id" text PRIMARY KEY NOT NULL,
		"intent_id" text REFERENCES "acquisition_intents"("id") ON DELETE SET NULL,
		"queue_id" text,
		"media_type" text NOT NULL,
		"movie_id" text,
		"series_id" text,
		"episode_ids" text,
		"protocol" text,
		"destination_path" text NOT NULL,
		"new_file_id" text,
		"pending_old_file_ids" text,
		"failed_old_file_ids" text,
		"status" text DEFAULT 'staged' NOT NULL,
		"error" text,
		"created_at" text NOT NULL,
		"updated_at" text NOT NULL,
		"completed_at" text
	)`,
	`CREATE INDEX IF NOT EXISTS "idx_import_operations_status" ON "import_operations" ("status")`,
	`CREATE INDEX IF NOT EXISTS "idx_import_operations_queue" ON "import_operations" ("queue_id")`
];

export const migration_v149: MigrationDefinition = {
	version: 149,
	name: 'import_operations_journal',
	apply: (sqlite: Database.Database) => {
		for (const statement of DDL) {
			sqlite.exec(statement);
		}
		logger.info('Applied import operations journal (v149)');
	}
};
