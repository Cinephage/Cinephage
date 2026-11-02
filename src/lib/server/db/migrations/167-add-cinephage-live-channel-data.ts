import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 167: Add cinephage_data column to livetv_channels for Cinephage Live
// provider metadata (taxonomy category + country code from the Cinephage API).

export const migration_v167: MigrationDefinition = {
	version: 167,
	name: 'add_cinephage_live_channel_data',
	apply: (sqlite) => {
		// Minimal installs (e.g. auth-repair DBs) may not have the Live TV
		// tables yet; schema-sync creates them from the current schema,
		// which already includes the column.
		if (!tableExists(sqlite, 'livetv_channels')) {
			logger.info('[SchemaSync] livetv_channels missing; skipping cinephage_data column');
			return;
		}
		if (!columnExists(sqlite, 'livetv_channels', 'cinephage_data')) {
			sqlite.prepare(`ALTER TABLE "livetv_channels" ADD COLUMN "cinephage_data" text`).run();
			logger.info('[SchemaSync] Added cinephage_data column to livetv_channels');
		} else {
			logger.info('[SchemaSync] cinephage_data column already exists in livetv_channels');
		}
	}
};
