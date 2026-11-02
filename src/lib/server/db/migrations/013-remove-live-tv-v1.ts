import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 13: Remove Live TV feature - drop all related tables

export const migration_v013: MigrationDefinition = {
	version: 13,
	name: 'remove_live_tv_v1',
	apply: (sqlite) => {
		// Drop all Live TV related tables
		sqlite.prepare(`DROP TABLE IF EXISTS "channel_lineup_items"`).run();
		sqlite.prepare(`DROP TABLE IF EXISTS "channel_categories"`).run();
		sqlite.prepare(`DROP TABLE IF EXISTS "epg_programs"`).run();
		sqlite.prepare(`DROP TABLE IF EXISTS "epg_sources"`).run();
		sqlite.prepare(`DROP TABLE IF EXISTS "live_events"`).run();
		sqlite.prepare(`DROP TABLE IF EXISTS "live_tv_settings"`).run();
		sqlite.prepare(`DROP TABLE IF EXISTS "stalker_portal_accounts"`).run();

		logger.info('[SchemaSync] Removed Live TV feature - dropped all related tables');
	}
};
