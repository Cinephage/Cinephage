import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 177: drop the search_state table.
 *
 * Migration 172 created it for a per-item retry-state model that was replaced by
 * the specification-based circuit breaker (173/174) before either shipped. The
 * migration file is gone, so a fresh install never creates the table - but every
 * database that already ran 172 kept it, with its two indexes and its rows, and
 * nothing reads it any more. Dropping it here removes the divergence instead of
 * leaving the schema dependent on install history.
 *
 * Idempotent: the table and indexes are dropped only if present, so re-running
 * this on a fresh install (where they never existed) is a no-op.
 */
export const migration_v177: MigrationDefinition = {
	version: 177,
	name: 'drop_search_state',
	apply: (sqlite: Database.Database) => {
		if (!tableExists(sqlite, 'search_state')) {
			return;
		}

		sqlite.exec(`
			DROP INDEX IF EXISTS "idx_search_state_next";
			DROP INDEX IF EXISTS "idx_search_state_owner";
			DROP TABLE IF EXISTS "search_state";
		`);

		logger.info('[migration v177] Dropped search_state table and its indexes');
	}
};
