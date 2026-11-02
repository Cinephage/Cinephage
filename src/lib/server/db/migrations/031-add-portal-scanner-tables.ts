import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 31: Add portal scanner tables (stalker_portals, portal_scan_results, portal_scan_history)

export const migration_v031: MigrationDefinition = {
	version: 31,
	name: 'add_portal_scanner_tables',
	apply: (sqlite) => {
		// Create stalker_portals table if it doesn't exist
		if (!tableExists(sqlite, 'stalker_portals')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "stalker_portals" (
					"id" text PRIMARY KEY NOT NULL,
					"name" text NOT NULL,
					"url" text NOT NULL UNIQUE,
					"endpoint" text,
					"server_timezone" text,
					"last_scanned_at" text,
					"last_scan_results" text,
					"enabled" integer DEFAULT 1,
					"created_at" text,
					"updated_at" text
				)`
				)
				.run();
			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_stalker_portals_enabled" ON "stalker_portals" ("enabled")`
				)
				.run();
			logger.info('[SchemaSync] Created stalker_portals table');
		}

		// Add portal_id and discovered_from_scan columns to stalker_accounts
		if (!columnExists(sqlite, 'stalker_accounts', 'portal_id')) {
			sqlite
				.prepare(
					`ALTER TABLE "stalker_accounts" ADD COLUMN "portal_id" text REFERENCES "stalker_portals"("id") ON DELETE SET NULL`
				)
				.run();
		}
		if (!columnExists(sqlite, 'stalker_accounts', 'discovered_from_scan')) {
			sqlite
				.prepare(
					`ALTER TABLE "stalker_accounts" ADD COLUMN "discovered_from_scan" integer DEFAULT 0`
				)
				.run();
		}

		// Create portal_scan_results table if it doesn't exist
		if (!tableExists(sqlite, 'portal_scan_results')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "portal_scan_results" (
					"id" text PRIMARY KEY NOT NULL,
					"portal_id" text NOT NULL REFERENCES "stalker_portals"("id") ON DELETE CASCADE,
					"mac_address" text NOT NULL,
					"status" text NOT NULL DEFAULT 'pending',
					"channel_count" integer,
					"category_count" integer,
					"expires_at" text,
					"account_status" text,
					"playback_limit" integer,
					"server_timezone" text,
					"raw_profile" text,
					"discovered_at" text NOT NULL,
					"processed_at" text
				)`
				)
				.run();
			sqlite
				.prepare(
					`CREATE UNIQUE INDEX IF NOT EXISTS "idx_scan_results_portal_mac" ON "portal_scan_results" ("portal_id", "mac_address")`
				)
				.run();
			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_scan_results_portal_status" ON "portal_scan_results" ("portal_id", "status")`
				)
				.run();
			logger.info('[SchemaSync] Created portal_scan_results table');
		}

		// Create portal_scan_history table if it doesn't exist
		if (!tableExists(sqlite, 'portal_scan_history')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "portal_scan_history" (
					"id" text PRIMARY KEY NOT NULL,
					"portal_id" text NOT NULL REFERENCES "stalker_portals"("id") ON DELETE CASCADE,
					"worker_id" text,
					"scan_type" text NOT NULL,
					"mac_prefix" text,
					"mac_range_start" text,
					"mac_range_end" text,
					"macs_to_test" integer,
					"macs_tested" integer DEFAULT 0,
					"macs_found" integer DEFAULT 0,
					"status" text NOT NULL DEFAULT 'running',
					"error" text,
					"started_at" text NOT NULL,
					"completed_at" text
				)`
				)
				.run();
			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_scan_history_portal" ON "portal_scan_history" ("portal_id")`
				)
				.run();
			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_scan_history_status" ON "portal_scan_history" ("status")`
				)
				.run();
			logger.info('[SchemaSync] Created portal_scan_history table');
		}

		logger.info('[SchemaSync] Added portal scanner tables');
	}
};
