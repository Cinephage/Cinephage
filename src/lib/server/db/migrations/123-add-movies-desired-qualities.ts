import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Add desired_qualities column to movies for multi-quality per-movie support.
 *
 * Stores a JSON array of Resolution values (e.g. ['2160p', '1080p']). When the
 * movie has >= 2 effective quality buckets, the system maintains independent
 * files per resolution tier instead of a single best file. null/empty/<2 values
 * preserve the existing single-quality behavior.
 */
export const migration_v123: MigrationDefinition = {
	version: 123,
	name: 'add_movies_desired_qualities',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'movies', 'desired_qualities')) {
			sqlite.prepare(`ALTER TABLE movies ADD COLUMN desired_qualities TEXT`).run();
			logger.info('[SchemaSync] Added desired_qualities column to movies');
		}
	}
};
