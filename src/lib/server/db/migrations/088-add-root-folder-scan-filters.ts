import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v088: MigrationDefinition = {
	version: 88,
	name: 'add_root_folder_scan_filters',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'root_folders', 'skip_folder_patterns')) {
			sqlite
				.prepare(`ALTER TABLE "root_folders" ADD COLUMN "skip_folder_patterns" text DEFAULT NULL`)
				.run();
			logger.info('[Migration v088] Added skip_folder_patterns column to root_folders');
		}

		if (!columnExists(sqlite, 'root_folders', 'blocked_video_extensions')) {
			sqlite
				.prepare(
					`ALTER TABLE "root_folders" ADD COLUMN "blocked_video_extensions" text DEFAULT NULL`
				)
				.run();
			logger.info('[Migration v088] Added blocked_video_extensions column to root_folders');
		}
	}
};
