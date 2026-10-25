import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 53: Add iptv_org_config column to livetv_accounts for IPTV-Org provider support

export const migration_v053: MigrationDefinition = {
	version: 53,
	name: 'add_iptv_org_config_column',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'livetv_accounts', 'iptv_org_config')) {
			sqlite.prepare(`ALTER TABLE "livetv_accounts" ADD COLUMN "iptv_org_config" text`).run();
			logger.info('[SchemaSync] Added iptv_org_config column to livetv_accounts');
		} else {
			logger.info('[SchemaSync] iptv_org_config column already exists in livetv_accounts');
		}
	}
};
