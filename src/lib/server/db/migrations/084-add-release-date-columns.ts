import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
export const migration_v084: MigrationDefinition = {
	version: 84,
	name: 'add_release_date_columns',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'movies', 'release_date')) {
			sqlite.prepare(`ALTER TABLE movies ADD COLUMN release_date text`).run();
		}
		if (!columnExists(sqlite, 'series', 'first_air_date')) {
			sqlite.prepare(`ALTER TABLE series ADD COLUMN first_air_date text`).run();
		}
		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS "idx_movies_release_date" ON "movies" ("release_date")`)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_series_first_air_date" ON "series" ("first_air_date")`
			)
			.run();
		logger.info('[SchemaSync] Added release_date and first_air_date columns (v84)');
	}
};
