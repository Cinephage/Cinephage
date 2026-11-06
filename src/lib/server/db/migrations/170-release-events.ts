import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 170: release_events - one row per observable release moment.
 *
 * Replaces the region-blind `movies.digital_release_date` / `physical_release_date`
 * columns as the source of truth: TMDB reports release dates per country and per
 * type, and collapsing them on write lost both dimensions.
 *
 * Table DDL also lives in schema-sync TABLE_DEFINITIONS for fresh installs; this
 * migration covers existing installs. Idempotent: guarded by tableExists and
 * IF NOT EXISTS.
 */
const DDL = [
	`CREATE TABLE IF NOT EXISTS "release_events" (
		"id" text PRIMARY KEY NOT NULL,
		"media_type" text NOT NULL,
		"media_id" text NOT NULL,
		"kind" text NOT NULL,
		"region" text NOT NULL DEFAULT 'US',
		"platform" text,
		"release_date" text NOT NULL,
		"release_time" text,
		"timezone" text,
		"source" text NOT NULL,
		"source_id" text,
		"confidence" text NOT NULL DEFAULT 'confirmed',
		"created_at" text NOT NULL,
		"updated_at" text NOT NULL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS "idx_release_events_natural_key"
		ON "release_events" ("media_type", "media_id", "kind", "region", "release_date", "source_id")`,
	`CREATE INDEX IF NOT EXISTS "idx_release_events_media"
		ON "release_events" ("media_type", "media_id")`,
	`CREATE INDEX IF NOT EXISTS "idx_release_events_date"
		ON "release_events" ("release_date")`,
	`CREATE INDEX IF NOT EXISTS "idx_release_events_kind_date"
		ON "release_events" ("kind", "release_date")`
];

export const migration_v170: MigrationDefinition = {
	version: 170,
	name: 'release_events',
	apply: (sqlite: Database.Database) => {
		for (const statement of DDL) {
			sqlite.exec(statement);
		}

		if (!tableExists(sqlite, 'release_events')) {
			logger.error('release_events missing after DDL - schema sync failed');
			return;
		}

		logger.info('Applied release_events (v170)');
	}
};
