import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 5: Add preserve_symlinks column to root_folders for NZBDav/rclone symlink preservation

export const migration_v005: MigrationDefinition = {
	version: 5,
	name: 'add_root_folders_preserve_symlinks',
	apply: (sqlite) => {
		// Only add column if it doesn't exist (may already exist from fresh TABLE_DEFINITIONS)
		if (!columnExists(sqlite, 'root_folders', 'preserve_symlinks')) {
			sqlite
				.prepare(`ALTER TABLE root_folders ADD COLUMN preserve_symlinks INTEGER DEFAULT 0`)
				.run();
			logger.info('[SchemaSync] Added preserve_symlinks column to root_folders');
		}
	}
};
