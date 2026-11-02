import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v095: MigrationDefinition = {
	version: 95,
	name: 'drop_provider_choice_columns',
	apply: (sqlite) => {
		// Drop indexes referencing the columns before dropping the columns themselves.
		// SQLite refuses to drop a column while a covering index still references it.
		sqlite.prepare(`DROP INDEX IF EXISTS "idx_libraries_metadata_provider"`).run();
		sqlite.prepare(`DROP INDEX IF EXISTS "idx_movies_metadata_provider"`).run();
		sqlite.prepare(`DROP INDEX IF EXISTS "idx_series_metadata_provider"`).run();

		if (
			tableExists(sqlite, 'libraries') &&
			columnExists(sqlite, 'libraries', 'metadata_provider')
		) {
			sqlite.prepare(`ALTER TABLE "libraries" DROP COLUMN "metadata_provider"`).run();
			logger.info('[Migration v095] Dropped metadata_provider from libraries');
		}

		if (tableExists(sqlite, 'movies')) {
			if (columnExists(sqlite, 'movies', 'metadata_provider')) {
				sqlite.prepare(`ALTER TABLE "movies" DROP COLUMN "metadata_provider"`).run();
				logger.info('[Migration v095] Dropped metadata_provider from movies');
			}
			if (columnExists(sqlite, 'movies', 'pinned_external')) {
				sqlite.prepare(`ALTER TABLE "movies" DROP COLUMN "pinned_external"`).run();
				logger.info('[Migration v095] Dropped pinned_external from movies');
			}
		}

		if (tableExists(sqlite, 'series')) {
			if (columnExists(sqlite, 'series', 'metadata_provider')) {
				sqlite.prepare(`ALTER TABLE "series" DROP COLUMN "metadata_provider"`).run();
				logger.info('[Migration v095] Dropped metadata_provider from series');
			}
			if (columnExists(sqlite, 'series', 'pinned_external')) {
				sqlite.prepare(`ALTER TABLE "series" DROP COLUMN "pinned_external"`).run();
				logger.info('[Migration v095] Dropped pinned_external from series');
			}
		}
	}
};
