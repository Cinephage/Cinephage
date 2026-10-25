import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 25: Add channel_categories and channel_lineup_items tables for user lineup management

export const migration_v025: MigrationDefinition = {
	version: 25,
	name: 'add_channel_lineup_tables',
	apply: (sqlite) => {
		// Create channel_categories table
		if (!tableExists(sqlite, 'channel_categories')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "channel_categories" (
					"id" text PRIMARY KEY NOT NULL,
					"name" text NOT NULL,
					"position" integer NOT NULL,
					"color" text,
					"icon" text,
					"created_at" text,
					"updated_at" text
				)`
				)
				.run();

			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_channel_categories_position" ON "channel_categories" ("position")`
				)
				.run();

			logger.info('[SchemaSync] Added channel_categories table');
		}

		// Create channel_lineup_items table
		if (!tableExists(sqlite, 'channel_lineup_items')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "channel_lineup_items" (
					"id" text PRIMARY KEY NOT NULL,
					"account_id" text NOT NULL REFERENCES "stalker_accounts"("id") ON DELETE CASCADE,
					"channel_id" text NOT NULL REFERENCES "stalker_channels"("id") ON DELETE CASCADE,
					"position" integer NOT NULL,
					"channel_number" integer,
					"custom_name" text,
					"custom_logo" text,
					"epg_id" text,
					"category_id" text REFERENCES "channel_categories"("id") ON DELETE SET NULL,
					"added_at" text,
					"updated_at" text
				)`
				)
				.run();

			sqlite
				.prepare(
					`CREATE UNIQUE INDEX IF NOT EXISTS "idx_lineup_account_channel" ON "channel_lineup_items" ("account_id", "channel_id")`
				)
				.run();
			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_lineup_position" ON "channel_lineup_items" ("position")`
				)
				.run();
			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_lineup_account" ON "channel_lineup_items" ("account_id")`
				)
				.run();
			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_lineup_category" ON "channel_lineup_items" ("category_id")`
				)
				.run();

			logger.info('[SchemaSync] Added channel_lineup_items table');
		}

		logger.info('[SchemaSync] Added user lineup management tables for Live TV');
	}
};
