import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v089: MigrationDefinition = {
	version: 89,
	name: 'add_blocked_keywords_table',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'blocked_keywords')) {
			sqlite
				.prepare(
					`CREATE TABLE "blocked_keywords" (
						"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
						"keyword_id" integer NOT NULL UNIQUE,
						"name" text NOT NULL,
						"created_at" text NOT NULL
					)`
				)
				.run();
			logger.info('[Migration v089] Created blocked_keywords table');
		}
	}
};
