import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Add movie_file_id column to subtitles for per-file subtitle association.
 *
 * Multi-quality support means a movie can have multiple movie_files at different
 * resolutions. Linking a subtitle to a specific movie_file (rather than just the
 * movie) enables per-resolution hash matching, sidecar naming, and sync offset.
 *
 * Nullable: null for legacy subtitles (backfilled only when a movie has exactly
 * one movie_file) or episode subtitles (which stay null).
 */
export const migration_v124: MigrationDefinition = {
	version: 124,
	name: 'add_subtitles_movie_file_id',
	apply: (sqlite) => {
		if (tableExists(sqlite, 'subtitles') && !columnExists(sqlite, 'subtitles', 'movie_file_id')) {
			sqlite.prepare(`ALTER TABLE subtitles ADD COLUMN movie_file_id text`).run();
			logger.info('[SchemaSync] Added movie_file_id column to subtitles');
		}

		// Backfill existing MOVIE subtitles only when unambiguous: the movie has
		// exactly one movie_files row. Episode subtitles are left null.
		if (tableExists(sqlite, 'subtitles') && tableExists(sqlite, 'movie_files')) {
			const result = sqlite
				.prepare(
					`UPDATE subtitles
					SET movie_file_id = (
						SELECT mf.id FROM movie_files mf WHERE mf.movie_id = subtitles.movie_id LIMIT 1
					)
					WHERE subtitles.movie_id IS NOT NULL
						AND subtitles.movie_file_id IS NULL
						AND (SELECT COUNT(*) FROM movie_files mf WHERE mf.movie_id = subtitles.movie_id) = 1`
				)
				.run();
			if (result.changes > 0) {
				logger.info(
					{ updated: result.changes },
					'[SchemaSync] Backfilled movie_file_id for unambiguous movie subtitles'
				);
			}
		}

		if (tableExists(sqlite, 'subtitles')) {
			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_subtitles_movie_file" ON "subtitles" ("movie_file_id")`
				)
				.run();
		}
	}
};
