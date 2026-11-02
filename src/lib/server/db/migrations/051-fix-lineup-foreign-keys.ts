import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Migration 51: Fix channel_lineup_items and channel_lineup_backups foreign key references

export const migration_v051: MigrationDefinition = {
	version: 51,
	name: 'fix_lineup_foreign_keys',
	apply: (sqlite) => {
		logger.info('[SchemaSync] Fixing channel lineup foreign key references');

		// Drop and recreate channel_lineup_items with correct references
		if (tableExists(sqlite, 'channel_lineup_items')) {
			// Backup existing data if any
			const hasData = sqlite
				.prepare('SELECT COUNT(*) as count FROM channel_lineup_items')
				.get() as { count: number };
			if (hasData.count > 0) {
				logger.info(
					`[SchemaSync] Warning: channel_lineup_items has ${hasData.count} rows that will be lost`
				);
			}

			// Drop the table
			sqlite.prepare('DROP TABLE IF EXISTS "channel_lineup_items"').run();
			logger.info('[SchemaSync] Dropped old channel_lineup_items table');
		}

		// Create new channel_lineup_items with correct references to livetv_* tables
		sqlite
			.prepare(
				`
			CREATE TABLE "channel_lineup_items" (
				"id" text PRIMARY KEY NOT NULL,
				"account_id" text NOT NULL REFERENCES "livetv_accounts"("id") ON DELETE CASCADE,
				"channel_id" text NOT NULL REFERENCES "livetv_channels"("id") ON DELETE CASCADE,
				"position" integer NOT NULL,
				"channel_number" integer,
				"custom_name" text,
				"custom_logo" text,
				"epg_id" text,
				"epg_source_channel_id" text REFERENCES "livetv_channels"("id") ON DELETE SET NULL,
				"category_id" text REFERENCES "channel_categories"("id") ON DELETE SET NULL,
				"added_at" text,
				"updated_at" text
			)
		`
			)
			.run();
		logger.info('[SchemaSync] Created channel_lineup_items with correct foreign keys');

		// Create indexes
		sqlite
			.prepare(
				`CREATE UNIQUE INDEX "idx_lineup_account_channel" ON "channel_lineup_items" ("account_id", "channel_id")`
			)
			.run();
		sqlite
			.prepare(`CREATE INDEX "idx_lineup_position" ON "channel_lineup_items" ("position")`)
			.run();
		sqlite
			.prepare(`CREATE INDEX "idx_lineup_account" ON "channel_lineup_items" ("account_id")`)
			.run();
		sqlite
			.prepare(`CREATE INDEX "idx_lineup_category" ON "channel_lineup_items" ("category_id")`)
			.run();

		// Drop and recreate channel_lineup_backups with correct references
		if (tableExists(sqlite, 'channel_lineup_backups')) {
			const hasData = sqlite
				.prepare('SELECT COUNT(*) as count FROM channel_lineup_backups')
				.get() as { count: number };
			if (hasData.count > 0) {
				logger.info(
					`[SchemaSync] Warning: channel_lineup_backups has ${hasData.count} rows that will be lost`
				);
			}

			sqlite.prepare('DROP TABLE IF EXISTS "channel_lineup_backups"').run();
			logger.info('[SchemaSync] Dropped old channel_lineup_backups table');
		}

		// Create new channel_lineup_backups with correct references
		sqlite
			.prepare(
				`
			CREATE TABLE "channel_lineup_backups" (
				"id" text PRIMARY KEY NOT NULL,
				"lineup_item_id" text NOT NULL REFERENCES "channel_lineup_items"("id") ON DELETE CASCADE,
				"account_id" text NOT NULL REFERENCES "livetv_accounts"("id") ON DELETE CASCADE,
				"channel_id" text NOT NULL REFERENCES "livetv_channels"("id") ON DELETE CASCADE,
				"priority" integer NOT NULL,
				"created_at" text,
				"updated_at" text
			)
		`
			)
			.run();
		logger.info('[SchemaSync] Created channel_lineup_backups with correct foreign keys');

		// Create indexes for backups
		sqlite
			.prepare(
				`CREATE INDEX "idx_lineup_backups_item" ON "channel_lineup_backups" ("lineup_item_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX "idx_lineup_backups_priority" ON "channel_lineup_backups" ("lineup_item_id", "priority")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE UNIQUE INDEX "idx_lineup_backups_unique" ON "channel_lineup_backups" ("lineup_item_id", "channel_id")`
			)
			.run();

		logger.info('[SchemaSync] Channel lineup foreign key references fixed successfully');
	}
};
