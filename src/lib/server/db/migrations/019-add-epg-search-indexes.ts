import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 19: Add EPG search optimization indexes

export const migration_v019: MigrationDefinition = {
	version: 19,
	name: 'add_epg_search_indexes',
	apply: (sqlite) => {
		// Composite index for EPG channel search (source_id + name)
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_epg_map_source_name" ON "livetv_epg_channel_map" ("source_id", "xmltv_channel_name" COLLATE NOCASE)`
			)
			.run();

		// Index for EPG program lookups by xmltv_channel_id (for preview feature)
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_epg_programs_xmltv" ON "livetv_epg_programs" ("source_id", "xmltv_channel_id", "start_time")`
			)
			.run();

		logger.info('[SchemaSync] Added EPG search optimization indexes');
	}
};
