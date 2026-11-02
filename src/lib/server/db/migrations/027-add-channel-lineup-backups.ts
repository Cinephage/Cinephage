import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 27: Add channel_lineup_backups table for backup channel sources

export const migration_v027: MigrationDefinition = {
	version: 27,
	name: 'add_channel_lineup_backups',
	apply: (sqlite) => {
		// Create channel_lineup_backups table
		if (!tableExists(sqlite, 'channel_lineup_backups')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "channel_lineup_backups" (
					"id" text PRIMARY KEY NOT NULL,
					"lineup_item_id" text NOT NULL REFERENCES "channel_lineup_items"("id") ON DELETE CASCADE,
					"account_id" text NOT NULL REFERENCES "stalker_accounts"("id") ON DELETE CASCADE,
					"channel_id" text NOT NULL REFERENCES "stalker_channels"("id") ON DELETE CASCADE,
					"priority" integer NOT NULL,
					"created_at" text,
					"updated_at" text
				)`
				)
				.run();

			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_lineup_backups_item" ON "channel_lineup_backups" ("lineup_item_id")`
				)
				.run();
			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_lineup_backups_priority" ON "channel_lineup_backups" ("lineup_item_id", "priority")`
				)
				.run();
			sqlite
				.prepare(
					`CREATE UNIQUE INDEX IF NOT EXISTS "idx_lineup_backups_unique" ON "channel_lineup_backups" ("lineup_item_id", "channel_id")`
				)
				.run();

			logger.info('[SchemaSync] Added channel_lineup_backups table');
		}

		logger.info('[SchemaSync] Added backup links support for Live TV');
	}
};
