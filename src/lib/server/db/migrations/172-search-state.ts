import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 172: search_state - bounded retry state for automatic release search.
 *
 * The monitoring loop had no memory of failure: an item was re-queried on every
 * scheduler run until it succeeded, and a failed download actively reset the
 * cooldown, so nothing ever stopped. This table gives each (item, search kind)
 * one row holding the attempt count, the next allowed attempt, the last outcome
 * and the indexer that answered, which is what the retry cap, the backoff and
 * the Activity "Searches" view all read.
 *
 * Upsert-per-item, so it is bounded by library size - unlike monitoring_history,
 * which appends a row per attempt.
 *
 * Table DDL also lives in schema-sync TABLE_DEFINITIONS for fresh installs; this
 * migration covers existing installs. Idempotent by construction.
 */
export const migration_v172: MigrationDefinition = {
	version: 172,
	name: 'search_state',
	apply: (sqlite: Database.Database) => {
		sqlite.exec(`
			CREATE TABLE IF NOT EXISTS "search_state" (
				"owner_type" text NOT NULL,
				"owner_id" text NOT NULL,
				"search_kind" text NOT NULL,
				"status" text NOT NULL DEFAULT 'idle',
				"attempts" integer NOT NULL DEFAULT 0,
				"first_attempt_at" text,
				"last_attempt_at" text,
				"next_attempt_at" text,
				"last_outcome" text,
				"last_indexer_id" text,
				"last_indexer_name" text,
				"indexers_queried" integer NOT NULL DEFAULT 0,
				"paused_until" text,
				"pause_reason" text,
				"updated_at" text NOT NULL
			)
		`);
		sqlite.exec(
			`CREATE INDEX IF NOT EXISTS "idx_search_state_next" ON "search_state" ("status", "next_attempt_at")`
		);
		sqlite.exec(
			`CREATE INDEX IF NOT EXISTS "idx_search_state_owner" ON "search_state" ("owner_type", "owner_id")`
		);

		logger.info('Created search_state table (v172)');
	}
};
