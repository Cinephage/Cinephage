import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 148: Acquisition intents + reservations — the durable acquisition
 * authority (acquisition-system redesign 2026-09-18).
 *
 * `acquisition_intents` records what is being acquired, for which target,
 * the pipeline-computed decision at approval time, and the lifecycle state.
 * The download queue becomes a transport projection linked via `queue_id`.
 *
 * `acquisition_reservations` enforces slot exclusivity with a partial unique
 * index: one ACTIVE (released_at IS NULL) reservation per target key
 * (`movie:<id>:<slot>` / `episode:<id>`). A second partial unique index on
 * intents keeps one ACTIVE intent per canonical release identity across all
 * targets. Both survive restarts, replacing process-local locks and
 * status-list occupancy inference.
 *
 * Table DDL also lives in schema-sync TABLE_DEFINITIONS for fresh installs;
 * this migration covers existing installs. Idempotent: guarded by
 * tableExists.
 */
const DDL = [
	`CREATE TABLE IF NOT EXISTS "acquisition_intents" (
		"id" text PRIMARY KEY NOT NULL,
		"media_type" text NOT NULL,
		"movie_id" text REFERENCES "movies"("id") ON DELETE SET NULL,
		"series_id" text REFERENCES "series"("id") ON DELETE SET NULL,
		"season_number" integer,
		"episode_ids" text,
		"quality_slot" text NOT NULL,
		"protocol" text NOT NULL,
		"identity_kind" text,
		"identity_value" text,
		"release_title" text NOT NULL,
		"indexer_id" text,
		"indexer_name" text,
		"upgrade_status" text,
		"decision" text,
		"source" text NOT NULL,
		"status" text DEFAULT 'active' NOT NULL,
		"queue_id" text,
		"error" text,
		"created_at" text NOT NULL,
		"updated_at" text NOT NULL,
		"completed_at" text
	)`,
	`CREATE TABLE IF NOT EXISTS "acquisition_reservations" (
		"id" text PRIMARY KEY NOT NULL,
		"intent_id" text NOT NULL REFERENCES "acquisition_intents"("id") ON DELETE CASCADE,
		"target_key" text NOT NULL,
		"created_at" text NOT NULL,
		"released_at" text
	)`,
	`CREATE INDEX IF NOT EXISTS "idx_acq_intents_status" ON "acquisition_intents" ("status")`,
	`CREATE INDEX IF NOT EXISTS "idx_acq_intents_queue" ON "acquisition_intents" ("queue_id")`,
	`CREATE INDEX IF NOT EXISTS "idx_acq_intents_movie" ON "acquisition_intents" ("movie_id")`,
	`CREATE INDEX IF NOT EXISTS "idx_acq_intents_series" ON "acquisition_intents" ("series_id")`,
	`CREATE UNIQUE INDEX IF NOT EXISTS "idx_acq_intents_active_identity" ON "acquisition_intents" ("identity_value") WHERE "identity_value" IS NOT NULL AND "status" = 'active'`,
	`CREATE INDEX IF NOT EXISTS "idx_acq_reservations_intent" ON "acquisition_reservations" ("intent_id")`,
	`CREATE UNIQUE INDEX IF NOT EXISTS "idx_acq_reservations_active_target" ON "acquisition_reservations" ("target_key") WHERE "released_at" IS NULL`
];

export const migration_v148: MigrationDefinition = {
	version: 148,
	name: 'acquisition_intents_and_reservations',
	apply: (sqlite: Database.Database) => {
		for (const statement of DDL) {
			sqlite.exec(statement);
		}
		if (!tableExists(sqlite, 'acquisition_intents')) {
			logger.error('acquisition_intents table missing after DDL — schema sync failed');
		}
		logger.info('Applied acquisition intents + reservations (v148)');
	}
};
