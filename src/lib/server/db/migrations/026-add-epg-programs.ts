import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 26: Add epg_programs table for storing EPG data from Stalker portals

export const migration_v026: MigrationDefinition = {
	version: 26,
	name: 'add_epg_programs',
	apply: (sqlite) => {
		// Create epg_programs table
		if (!tableExists(sqlite, 'epg_programs')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "epg_programs" (
					"id" text PRIMARY KEY NOT NULL,
					"channel_id" text NOT NULL REFERENCES "stalker_channels"("id") ON DELETE CASCADE,
					"stalker_channel_id" text NOT NULL,
					"account_id" text NOT NULL REFERENCES "stalker_accounts"("id") ON DELETE CASCADE,
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
				)`
				)
				.run();

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
					`CREATE UNIQUE INDEX IF NOT EXISTS "idx_epg_programs_unique" ON "epg_programs" ("account_id", "stalker_channel_id", "start_time")`
				)
				.run();

			logger.info('[SchemaSync] Added epg_programs table');
		}

		logger.info('[SchemaSync] Added EPG support for Live TV');
	}
};
