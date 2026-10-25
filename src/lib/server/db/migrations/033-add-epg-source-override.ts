import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 33: Add EPG source override column to channel_lineup_items

export const migration_v033: MigrationDefinition = {
	version: 33,
	name: 'add_epg_source_override',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'channel_lineup_items', 'epg_source_channel_id')) {
			sqlite
				.prepare(
					`ALTER TABLE "channel_lineup_items" ADD COLUMN "epg_source_channel_id" text REFERENCES "livetv_channels"("id") ON DELETE SET NULL`
				)
				.run();
			logger.info('[SchemaSync] Added epg_source_channel_id column to channel_lineup_items');
		}
	}
};
