import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v091: MigrationDefinition = {
	version: 91,
	name: 'add_download_release_date',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'movies')) return;

		if (!columnExists(sqlite, 'movies', 'download_release_date')) {
			sqlite.prepare(`ALTER TABLE "movies" ADD COLUMN "download_release_date" text`).run();
			logger.info('[Migration v091] Added download_release_date column to movies');
		}

		if (!columnExists(sqlite, 'movies', 'download_release_type')) {
			sqlite.prepare(`ALTER TABLE "movies" ADD COLUMN "download_release_type" text`).run();
			logger.info('[Migration v091] Added download_release_type column to movies');
		}

		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_movies_download_release_date" ON "movies" ("download_release_date")`
			)
			.run();
		logger.info('[Migration v091] Created download_release_date index');
	}
};
