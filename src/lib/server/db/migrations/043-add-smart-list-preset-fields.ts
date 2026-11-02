import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 43: Add preset fields for curated external list support

export const migration_v043: MigrationDefinition = {
	version: 43,
	name: 'add_smart_list_preset_fields',
	apply: (sqlite) => {
		// Add preset_id column
		if (!columnExists(sqlite, 'smart_lists', 'preset_id')) {
			sqlite.prepare(`ALTER TABLE smart_lists ADD COLUMN preset_id TEXT`).run();
			logger.info('[SchemaSync] Added preset_id column to smart_lists');
		}

		// Add preset_provider column
		if (!columnExists(sqlite, 'smart_lists', 'preset_provider')) {
			sqlite.prepare(`ALTER TABLE smart_lists ADD COLUMN preset_provider TEXT`).run();
			logger.info('[SchemaSync] Added preset_provider column to smart_lists');
		}

		// Add preset_settings column
		if (!columnExists(sqlite, 'smart_lists', 'preset_settings')) {
			sqlite
				.prepare(`ALTER TABLE smart_lists ADD COLUMN preset_settings TEXT DEFAULT '{}' NOT NULL`)
				.run();
			logger.info('[SchemaSync] Added preset_settings column to smart_lists');
		}

		logger.info('[SchemaSync] Added preset fields to smart_lists');
	}
};
