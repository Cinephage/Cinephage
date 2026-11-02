import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

function indexExists(sqlite: Database.Database, table: string, indexName: string): boolean {
	const row = sqlite
		.prepare(`SELECT 1 FROM pragma_index_list(?) WHERE name = ?`)
		.get(table, indexName);
	return row !== undefined;
}

/**
 * Version 150: movie_files (movie_id, relative_path) uniqueness.
 *
 * Nothing enforced one row per movie+path, so duplicate rows accumulated
 * (re-grabs, streaming re-imports, scanner races). Writers now upsert; this
 * migration dedupes existing rows — keeping the OLDEST row per (movie,
 * path) — then adds the unique index.
 *
 * Idempotent: dedupe is a no-op when no duplicates exist; index creation is
 * guarded by indexExists.
 */
export const migration_v150: MigrationDefinition = {
	version: 150,
	name: 'movie_files_path_unique',
	apply: (sqlite: Database.Database) => {
		if (!columnExists(sqlite, 'movie_files', 'relative_path')) return;

		// Keep the oldest row per (movie_id, relative_path); child references
		// (download_history.movie_file_id is SET NULL on delete, subtitles
		// likewise) follow the surviving row only when paths matched anyway.
		const result = sqlite
			.prepare(
				`DELETE FROM movie_files
				 WHERE id IN (
					SELECT mf.id FROM movie_files mf
					JOIN movie_files keep
						ON keep.movie_id = mf.movie_id
						AND keep.relative_path = mf.relative_path
						AND keep.rowid < mf.rowid
				 )`
			)
			.run();
		if (result.changes > 0) {
			logger.info(
				{ removed: result.changes },
				'Deduped movie_files rows with identical (movie, path)'
			);
		}

		if (!indexExists(sqlite, 'movie_files', 'idx_movie_files_movie_path_unique')) {
			sqlite.exec(
				`CREATE UNIQUE INDEX IF NOT EXISTS "idx_movie_files_movie_path_unique"
				 ON "movie_files" ("movie_id", "relative_path")`
			);
		}
		logger.info('Applied movie_files (movie_id, relative_path) unique index (v150)');
	}
};
