import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 21: Add cached_server column for DaddyHD server caching

export const migration_v021: MigrationDefinition = {
	version: 21,
	name: 'add_live_tv_cached_server',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'livetv_channels_cache', 'cached_server')) {
			sqlite.prepare(`ALTER TABLE "livetv_channels_cache" ADD COLUMN "cached_server" text`).run();
		}
		logger.info('[SchemaSync] Added cached_server column to livetv_channels_cache');
	}
};
