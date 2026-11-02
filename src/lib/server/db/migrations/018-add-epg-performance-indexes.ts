import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 18: Add EPG performance optimization indexes

export const migration_v018: MigrationDefinition = {
	version: 18,
	name: 'add_epg_performance_indexes',
	apply: (sqlite) => {
		// Index for LIKE search on channel names (case-insensitive)
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_epg_map_name_search" ON "livetv_epg_channel_map" ("xmltv_channel_name" COLLATE NOCASE)`
			)
			.run();

		// Covering index for getEpgNow query optimization
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_epg_programs_now" ON "livetv_epg_programs" ("channel_id", "end_time", "start_time")`
			)
			.run();

		// Index for cleanup query optimization (end_time-based filtering)
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_epg_programs_end" ON "livetv_epg_programs" ("end_time")`
			)
			.run();

		logger.info('[SchemaSync] Added EPG performance optimization indexes');
	}
};
