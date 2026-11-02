import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 28: Drop old live_tv_settings table (replaced by EPG scheduler settings)

export const migration_v028: MigrationDefinition = {
	version: 28,
	name: 'drop_old_live_tv_settings',
	apply: (sqlite) => {
		if (tableExists(sqlite, 'live_tv_settings')) {
			sqlite.prepare(`DROP TABLE "live_tv_settings"`).run();
			logger.info('[SchemaSync] Dropped old live_tv_settings table');
		}
	}
};
