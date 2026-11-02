import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v094: MigrationDefinition = {
	version: 94,
	name: 'add_indexer_orphaned',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'indexers')) return;

		if (!columnExists(sqlite, 'indexers', 'orphaned')) {
			sqlite
				.prepare(`ALTER TABLE "indexers" ADD COLUMN "orphaned" integer NOT NULL DEFAULT 0`)
				.run();
			logger.info('[Migration v094] Added orphaned column to indexers');
		}
	}
};
