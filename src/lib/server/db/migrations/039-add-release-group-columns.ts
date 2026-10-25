import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 39: Add release_group column to download_queue and download_history

export const migration_v039: MigrationDefinition = {
	version: 39,
	name: 'add_release_group_columns',
	apply: (sqlite) => {
		// Add release_group to download_queue if not exists
		if (!columnExists(sqlite, 'download_queue', 'release_group')) {
			sqlite.prepare(`ALTER TABLE "download_queue" ADD COLUMN "release_group" text`).run();
			logger.info('[SchemaSync] Added release_group column to download_queue');
		}

		// Add release_group to download_history if not exists
		if (!columnExists(sqlite, 'download_history', 'release_group')) {
			sqlite.prepare(`ALTER TABLE "download_history" ADD COLUMN "release_group" text`).run();
			logger.info('[SchemaSync] Added release_group column to download_history');
		}
	}
};
