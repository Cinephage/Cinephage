import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v086: MigrationDefinition = {
	version: 86,
	name: 'add_movie_metadata_provider_columns',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'movies', 'metadata_provider')) {
			sqlite
				.prepare(`ALTER TABLE movies ADD COLUMN metadata_provider text NOT NULL DEFAULT 'auto'`)
				.run();
		}
		if (!columnExists(sqlite, 'movies', 'provider_refs')) {
			sqlite.prepare(`ALTER TABLE movies ADD COLUMN provider_refs text`).run();
		}
		if (!columnExists(sqlite, 'movies', 'pinned_external')) {
			sqlite.prepare(`ALTER TABLE movies ADD COLUMN pinned_external text`).run();
		}
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_movies_metadata_provider" ON "movies" ("metadata_provider")`
			)
			.run();
		logger.info('[SchemaSync] Added metadata provider columns to movies (v86)');
	}
};
