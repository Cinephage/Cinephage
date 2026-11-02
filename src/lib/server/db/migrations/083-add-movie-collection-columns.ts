import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
export const migration_v083: MigrationDefinition = {
	version: 83,
	name: 'add_movie_collection_columns',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'movies', 'tmdb_collection_id')) {
			sqlite.prepare(`ALTER TABLE movies ADD COLUMN tmdb_collection_id integer`).run();
		}
		if (!columnExists(sqlite, 'movies', 'collection_name')) {
			sqlite.prepare(`ALTER TABLE movies ADD COLUMN collection_name text`).run();
		}
		logger.info('[SchemaSync] Added movie collection columns (v83)');
	}
};
