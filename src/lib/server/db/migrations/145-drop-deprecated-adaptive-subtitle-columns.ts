import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 142: Drop the deprecated per-item adaptive subtitle columns (Phase 7).
 *
 * movies/episodes.failed_subtitle_attempts and first_subtitle_search_at were
 * superseded in migration 141 by per-requirement rows in subtitle_search_state
 * and have had no readers since. `last_search_time` stays: the release-search
 * cooldown (CooldownStage / SearchCooldownSpecification) still reads and writes
 * it.
 *
 * Plain ALTER TABLE DROP COLUMN (SQLite 3.35+): neither column participates in
 * an index, CHECK, or FK on movies/episodes, so no table rebuild is needed.
 * Idempotent: tables/columns that no longer exist are skipped.
 */

const TARGETS: Array<{ table: string; column: string }> = [
	{ table: 'movies', column: 'failed_subtitle_attempts' },
	{ table: 'movies', column: 'first_subtitle_search_at' },
	{ table: 'episodes', column: 'failed_subtitle_attempts' },
	{ table: 'episodes', column: 'first_subtitle_search_at' }
];

export const migration_v145: MigrationDefinition = {
	version: 145,
	name: 'drop_deprecated_adaptive_subtitle_columns',
	apply: (sqlite: Database.Database) => {
		for (const { table, column } of TARGETS) {
			if (!tableExists(sqlite, table) || !columnExists(sqlite, table, column)) {
				continue;
			}

			try {
				sqlite.prepare(`ALTER TABLE "${table}" DROP COLUMN "${column}"`).run();
				logger.info(`[migration v142] Dropped ${table}.${column}`);
			} catch (e) {
				// A stray index/constraint on the column would abort the drop; leave
				// the column as dead data rather than failing startup.
				logger.warn(
					{ err: e instanceof Error ? e.message : String(e) },
					`[migration v142] Could not drop ${table}.${column} — column left as dead data`
				);
			}
		}
	}
};
