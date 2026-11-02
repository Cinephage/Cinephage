import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v093: MigrationDefinition = {
	version: 93,
	name: 'add_indexer_upstream_enabled',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'indexers')) return;

		if (!columnExists(sqlite, 'indexers', 'upstream_enabled')) {
			sqlite.prepare(`ALTER TABLE "indexers" ADD COLUMN "upstream_enabled" integer`).run();
			logger.info('[Migration v093] Added upstream_enabled column to indexers');

			// Backfill from settings JSON for existing Prowlarr-managed indexers.
			// settings->>'prowlarrEnabled' is stored as the string 'true'/'false'.
			sqlite
				.prepare(
					`UPDATE "indexers"
					 SET "upstream_enabled" = CASE
					   WHEN json_extract("settings", '$.prowlarrEnabled') = 'false' THEN 0
					   WHEN json_extract("settings", '$.prowlarrEnabled') = 'true'  THEN 1
					   ELSE NULL
					 END
					 WHERE json_extract("settings", '$.prowlarrEnabled') IS NOT NULL`
				)
				.run();
			logger.info(
				'[Migration v093] Backfilled upstream_enabled from prowlarrEnabled settings field'
			);
		}
	}
};
