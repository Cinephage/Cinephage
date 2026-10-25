import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 42: Add external list source support for smart lists

export const migration_v042: MigrationDefinition = {
	version: 42,
	name: 'add_smart_list_external_source_support',
	apply: (sqlite) => {
		// Add list_source_type column
		if (!columnExists(sqlite, 'smart_lists', 'list_source_type')) {
			sqlite
				.prepare(
					`ALTER TABLE smart_lists ADD COLUMN list_source_type TEXT DEFAULT 'tmdb-discover' NOT NULL`
				)
				.run();
			logger.info('[SchemaSync] Added list_source_type column to smart_lists');
		}

		// Add external_source_config column
		if (!columnExists(sqlite, 'smart_lists', 'external_source_config')) {
			sqlite
				.prepare(
					`ALTER TABLE smart_lists ADD COLUMN external_source_config TEXT DEFAULT '{}' NOT NULL`
				)
				.run();
			logger.info('[SchemaSync] Added external_source_config column to smart_lists');
		}

		// Add last_external_sync_time column
		if (!columnExists(sqlite, 'smart_lists', 'last_external_sync_time')) {
			sqlite.prepare(`ALTER TABLE smart_lists ADD COLUMN last_external_sync_time TEXT`).run();
			logger.info('[SchemaSync] Added last_external_sync_time column to smart_lists');
		}

		// Add external_sync_error column
		if (!columnExists(sqlite, 'smart_lists', 'external_sync_error')) {
			sqlite.prepare(`ALTER TABLE smart_lists ADD COLUMN external_sync_error TEXT`).run();
			logger.info('[SchemaSync] Added external_sync_error column to smart_lists');
		}

		logger.info('[SchemaSync] Added external list source support to smart_lists');
	}
};
