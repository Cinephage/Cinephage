import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 41: Add default_monitored to root_folders for unmonitor-by-default on scan (Issue #81)

export const migration_v041: MigrationDefinition = {
	version: 41,
	name: 'add_root_folders_default_monitored',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'root_folders', 'default_monitored')) {
			sqlite
				.prepare(`ALTER TABLE root_folders ADD COLUMN default_monitored INTEGER DEFAULT 1`)
				.run();
			logger.info('[SchemaSync] Added default_monitored column to root_folders');
		}
	}
};
