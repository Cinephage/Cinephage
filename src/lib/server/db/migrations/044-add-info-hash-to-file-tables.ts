import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Migration 44: Add info_hash columns to movie_files and episode_files for duplicate detection

export const migration_v044: MigrationDefinition = {
	version: 44,
	name: 'add_info_hash_to_file_tables',
	apply: (sqlite) => {
		// Add info_hash to movie_files
		if (!columnExists(sqlite, 'movie_files', 'info_hash')) {
			sqlite.prepare(`ALTER TABLE movie_files ADD COLUMN info_hash TEXT`).run();
			logger.info('[SchemaSync] Added info_hash column to movie_files');
		}

		// Add info_hash to episode_files
		if (!columnExists(sqlite, 'episode_files', 'info_hash')) {
			sqlite.prepare(`ALTER TABLE episode_files ADD COLUMN info_hash TEXT`).run();
			logger.info('[SchemaSync] Added info_hash column to episode_files');
		}

		logger.info('[SchemaSync] Added info_hash columns for duplicate detection');
	}
};
