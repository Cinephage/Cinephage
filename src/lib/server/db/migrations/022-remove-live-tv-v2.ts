import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 22: Remove all Live TV tables (feature rewrite)

export const migration_v022: MigrationDefinition = {
	version: 22,
	name: 'remove_live_tv_v2',
	apply: (sqlite) => {
		const tables = [
			'livetv_epg_programs',
			'livetv_epg_channel_map',
			'livetv_epg_sources',
			'livetv_stream_health',
			'livetv_settings',
			'livetv_events_cache',
			'livetv_lineup',
			'livetv_categories',
			'livetv_channels_cache'
		];

		for (const table of tables) {
			if (tableExists(sqlite, table)) {
				sqlite.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
				logger.info(`[SchemaSync] Dropped table: ${table}`);
			}
		}

		logger.info('[SchemaSync] Removed all Live TV tables');
	}
};
