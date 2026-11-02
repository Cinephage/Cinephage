import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureColumn, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 147: Audio-language shortfall flag (audio-language acquisition
 * design 2026-09-15, phase D).
 *
 * Adds `language_shortfall` (boolean, default false) to movies and series.
 * The flag is set by the import verifier when probed audio languages
 * (mediaInfo.audioLanguages, the only definitive signal) contradict the
 * item's effective audio preference — e.g. a MULTi pack that turned out to
 * lack the preferred language. It marks the item as a candidate for a
 * better-language upgrade re-grab. Never set when audio languages are
 * unknown (absence of evidence never punishes) or when the preference is
 * satisfied.
 *
 * Read-only at query time by monitoring/upgrade surfaces; written only by
 * `recalculateLanguageShortfall` (src/lib/server/languages/language-shortfall.ts).
 *
 * Idempotent: guarded by ensureColumn.
 */
export const migration_v147: MigrationDefinition = {
	version: 147,
	name: 'language_shortfall_flag',
	apply: (sqlite: Database.Database) => {
		for (const table of ['movies', 'series']) {
			if (!tableExists(sqlite, table)) continue;
			ensureColumn(sqlite, table, 'language_shortfall', '"language_shortfall" integer DEFAULT 0');
		}
		logger.info('Applied language shortfall flag columns (movies, series)');
	}
};
