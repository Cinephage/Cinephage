import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v097: MigrationDefinition = {
	version: 97,
	name: 'add_episode_group_id',
	apply: (sqlite) => {
		if (tableExists(sqlite, 'series')) {
			if (!columnExists(sqlite, 'series', 'episode_group_id')) {
				sqlite.prepare(`ALTER TABLE "series" ADD COLUMN "episode_group_id" text`).run();
				logger.info('[Migration v097] Added episode_group_id column to series');
			}
		}
	}
};
