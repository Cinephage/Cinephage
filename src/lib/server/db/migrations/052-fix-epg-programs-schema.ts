import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Migration 52: Fix epg_programs table schema for multi-provider support

export const migration_v052: MigrationDefinition = {
	version: 52,
	name: 'fix_epg_programs_schema',
	apply: (sqlite) => {
		logger.info('[SchemaSync] Fixing epg_programs table schema for multi-provider support');

		// Check if epg_programs exists with old schema
		if (tableExists(sqlite, 'epg_programs')) {
			const hasOldColumn = columnExists(sqlite, 'epg_programs', 'stalker_channel_id');

			if (hasOldColumn) {
				logger.info('[SchemaSync] Found old epg_programs schema, recreating table');

				// Drop old indexes
				const oldIndexes = [
					'idx_epg_programs_channel',
					'idx_epg_programs_channel_time',
					'idx_epg_programs_account',
					'idx_epg_programs_end',
					'idx_epg_programs_unique'
				];

				for (const index of oldIndexes) {
					try {
						sqlite.prepare(`DROP INDEX IF EXISTS "${index}"`).run();
					} catch {
						// Index might not exist
					}
				}

				// Drop old table
				sqlite.prepare('DROP TABLE IF EXISTS "epg_programs"').run();
				logger.info('[SchemaSync] Dropped old epg_programs table');
			}
		}

		// Create new epg_programs table with correct schema
		sqlite
			.prepare(
				`
			CREATE TABLE IF NOT EXISTS "epg_programs" (
				"id" text PRIMARY KEY NOT NULL,
				"channel_id" text NOT NULL REFERENCES "livetv_channels"("id") ON DELETE CASCADE,
				"external_channel_id" text NOT NULL,
				"account_id" text NOT NULL REFERENCES "livetv_accounts"("id") ON DELETE CASCADE,
				"provider_type" text NOT NULL,
				"title" text NOT NULL,
				"description" text,
				"category" text,
				"director" text,
				"actor" text,
				"start_time" text NOT NULL,
				"end_time" text NOT NULL,
				"duration" integer NOT NULL,
				"has_archive" integer DEFAULT 0,
				"cached_at" text,
				"updated_at" text
			)
			`
			)
			.run();
		logger.info('[SchemaSync] Created epg_programs table with multi-provider schema');

		// Create indexes
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_epg_programs_channel" ON "epg_programs" ("channel_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_epg_programs_channel_time" ON "epg_programs" ("channel_id", "start_time")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_epg_programs_account" ON "epg_programs" ("account_id")`
			)
			.run();
		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS "idx_epg_programs_end" ON "epg_programs" ("end_time")`)
			.run();
		sqlite
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS "idx_epg_programs_unique" ON "epg_programs" ("account_id", "external_channel_id", "start_time")`
			)
			.run();
		logger.info('[SchemaSync] Created epg_programs indexes');

		logger.info('[SchemaSync] epg_programs table schema fixed successfully');
	}
};
