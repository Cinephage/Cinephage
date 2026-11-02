import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 152: Drop the legacy subtitle_settings key-value table.
 *
 * All subtitle defaults moved to language_settings (migration 140) and
 * provider settings to subtitle_providers; no code reads or writes this table
 * anymore. Migration 140 already deleted its obsolete keys, so dropping it
 * loses nothing.
 *
 * Idempotent: guarded by tableExists.
 */
export const migration_v152: MigrationDefinition = {
	version: 152,
	name: 'drop_subtitle_settings',
	apply: (sqlite: Database.Database) => {
		if (!tableExists(sqlite, 'subtitle_settings')) return;
		sqlite.exec(`DROP TABLE "subtitle_settings"`);
		logger.info('Dropped legacy subtitle_settings table');
	}
};
