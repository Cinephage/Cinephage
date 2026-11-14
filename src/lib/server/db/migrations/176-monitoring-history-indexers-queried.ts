import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureColumn } from '../migration-helpers.js';

/**
 * Version 176: monitoring_history.indexers_queried.
 *
 * How many distinct indexers answered a given search attempt, regardless of
 * whether anything was grabbed - complements indexer_id/indexer_name
 * (migration 175, only set when a release was grabbed) by giving a signal
 * for no_results/rejected rows too (e.g. "0 indexers queried" points at a
 * config problem, "3 queried, nothing grabbed" doesn't). NULL for every
 * existing row means no behavior change.
 */
export const migration_v176: MigrationDefinition = {
	version: 176,
	name: 'monitoring_history_indexers_queried',
	apply: (sqlite) => {
		ensureColumn(sqlite, 'monitoring_history', 'indexers_queried', '"indexers_queried" integer');
	}
};
