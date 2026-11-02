import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 15: Remove Live TV EPG cache (unused - API does not provide EPG)

export const migration_v015: MigrationDefinition = {
	version: 15,
	name: 'remove_live_tv_epg_cache',
	apply: (sqlite) => {
		sqlite.prepare(`DROP TABLE IF EXISTS "livetv_epg_cache"`).run();
		logger.info('[SchemaSync] Removed unused livetv_epg_cache table');
	}
};
