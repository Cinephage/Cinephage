import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Migration 68: Add edition column to episode_files

export const migration_v068: MigrationDefinition = {
	version: 68,
	name: 'add_edition_to_episode_files',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'episode_files', 'edition')) {
			sqlite.prepare(`ALTER TABLE episode_files ADD COLUMN edition TEXT`).run();
			logger.info('[SchemaSync] Added edition column to episode_files');
		}
	}
};
