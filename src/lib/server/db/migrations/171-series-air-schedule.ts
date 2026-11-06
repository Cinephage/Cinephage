import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 171: series broadcast schedule (air time / days / timezone).
 *
 * TMDB has no broadcast time; TVDB's `/series/{id}/extended` returns `airsTime`
 * (HH:MM, wall clock at the network) and `airsDays`. Neither provider reports a
 * timezone, so `air_tz` is resolved from the network's country and may be
 * overridden per series.
 *
 * Table DDL also lives in schema-sync TABLE_DEFINITIONS for fresh installs; this
 * migration covers existing installs. Idempotent: guarded by columnExists.
 */
const COLUMNS: { name: string; ddl: string }[] = [
	{ name: 'air_time', ddl: 'ALTER TABLE "series" ADD COLUMN "air_time" text' },
	{ name: 'airs_days', ddl: 'ALTER TABLE "series" ADD COLUMN "airs_days" text' },
	{ name: 'air_tz', ddl: 'ALTER TABLE "series" ADD COLUMN "air_tz" text' }
];

export const migration_v171: MigrationDefinition = {
	version: 171,
	name: 'series_air_schedule',
	apply: (sqlite: Database.Database) => {
		for (const column of COLUMNS) {
			if (columnExists(sqlite, 'series', column.name)) continue;
			sqlite.exec(column.ddl);
		}

		logger.info('Applied series air schedule columns (v171)');
	}
};
