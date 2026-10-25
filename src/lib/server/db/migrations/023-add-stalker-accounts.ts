import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 23: Add stalker_accounts table for Live TV Stalker Portal support

export const migration_v023: MigrationDefinition = {
	version: 23,
	name: 'add_stalker_accounts',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'stalker_accounts')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "stalker_accounts" (
					"id" text PRIMARY KEY NOT NULL,
					"name" text NOT NULL,
					"portal_url" text NOT NULL,
					"mac_address" text NOT NULL,
					"enabled" integer DEFAULT 1,
					"playback_limit" integer,
					"channel_count" integer,
					"category_count" integer,
					"expires_at" text,
					"server_timezone" text,
					"last_tested_at" text,
					"last_test_success" integer,
					"last_test_error" text,
					"created_at" text,
					"updated_at" text
				)`
				)
				.run();

			// Create indexes
			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_stalker_accounts_enabled" ON "stalker_accounts" ("enabled")`
				)
				.run();
			sqlite
				.prepare(
					`CREATE UNIQUE INDEX IF NOT EXISTS "idx_stalker_accounts_portal_mac" ON "stalker_accounts" ("portal_url", "mac_address")`
				)
				.run();

			logger.info('[SchemaSync] Added stalker_accounts table for Live TV');
		}
	}
};
