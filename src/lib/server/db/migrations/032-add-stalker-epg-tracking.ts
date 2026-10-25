import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 32: Add EPG tracking columns to stalker_accounts for visibility and sync status

export const migration_v032: MigrationDefinition = {
	version: 32,
	name: 'add_stalker_epg_tracking',
	apply: (sqlite) => {
		// Add EPG tracking columns to stalker_accounts
		if (!columnExists(sqlite, 'stalker_accounts', 'last_epg_sync_at')) {
			sqlite.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "last_epg_sync_at" text`).run();
		}
		if (!columnExists(sqlite, 'stalker_accounts', 'last_epg_sync_error')) {
			sqlite.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "last_epg_sync_error" text`).run();
		}
		if (!columnExists(sqlite, 'stalker_accounts', 'epg_program_count')) {
			sqlite
				.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "epg_program_count" integer DEFAULT 0`)
				.run();
		}
		if (!columnExists(sqlite, 'stalker_accounts', 'has_epg')) {
			sqlite.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "has_epg" integer`).run();
		}

		logger.info('[SchemaSync] Added EPG tracking columns to stalker_accounts');
	}
};
