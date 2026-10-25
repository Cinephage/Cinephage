import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Add metadata_language and prefer_original_title columns to movies and series.
 *
 * metadata_language: Per-item TMDB language override (null = inherit global,
 *   'original' = use TMDB original_language, or any TMDB locale like 'fr-FR').
 * prefer_original_title: Display flag; when true, the UI shows originalTitle
 *   instead of title while keeping localized overviews/episodes.
 */
export const migration_v126: MigrationDefinition = {
	version: 126,
	name: 'add_metadata_language_overrides',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'movies', 'metadata_language')) {
			sqlite.prepare(`ALTER TABLE movies ADD COLUMN metadata_language TEXT`).run();
			logger.info('[SchemaSync] Added metadata_language column to movies');
		}
		if (!columnExists(sqlite, 'movies', 'prefer_original_title')) {
			sqlite.prepare(`ALTER TABLE movies ADD COLUMN prefer_original_title INTEGER DEFAULT 0`).run();
			logger.info('[SchemaSync] Added prefer_original_title column to movies');
		}
		if (!columnExists(sqlite, 'series', 'metadata_language')) {
			sqlite.prepare(`ALTER TABLE series ADD COLUMN metadata_language TEXT`).run();
			logger.info('[SchemaSync] Added metadata_language column to series');
		}
		if (!columnExists(sqlite, 'series', 'prefer_original_title')) {
			sqlite.prepare(`ALTER TABLE series ADD COLUMN prefer_original_title INTEGER DEFAULT 0`).run();
			logger.info('[SchemaSync] Added prefer_original_title column to series');
		}
	}
};
