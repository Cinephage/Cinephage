import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 29: Clean break migration for Live TV
// This drops any orphaned tables from intermediate rewrites (v14-21 external API system).
// These tables are no longer used and may exist in databases that went through those versions.

export const migration_v029: MigrationDefinition = {
	version: 29,
	name: 'clean_break_live_tv',
	apply: (sqlite) => {
		const orphanedTables = [
			'livetv_channels_cache',
			'livetv_categories',
			'livetv_lineup',
			'livetv_events_cache',
			'livetv_settings',
			'livetv_stream_health',
			'livetv_epg_sources',
			'livetv_epg_channel_map',
			'livetv_epg_programs',
			'livetv_epg_cache',
			// Also clean up any remaining legacy tables
			'stalker_portal_accounts',
			'epg_sources',
			'live_events'
		];

		let droppedCount = 0;
		for (const table of orphanedTables) {
			if (tableExists(sqlite, table)) {
				sqlite.prepare(`DROP TABLE "${table}"`).run();
				droppedCount++;
			}
		}

		if (droppedCount > 0) {
			logger.info(`[SchemaSync] Dropped ${droppedCount} orphaned Live TV tables`);
		}
	}
};
