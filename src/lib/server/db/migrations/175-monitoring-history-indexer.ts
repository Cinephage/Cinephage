import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureColumn } from '../migration-helpers.js';

/**
 * Version 175: monitoring_history.indexer_id, monitoring_history.indexer_name.
 *
 * Attributes a grabbed release to the indexer that supplied it, so the
 * Searches tab can show "who found this" instead of just "found". NULL for
 * every existing row (and for rows where nothing was grabbed) means no
 * behavior change.
 */
export const migration_v175: MigrationDefinition = {
	version: 175,
	name: 'monitoring_history_indexer',
	apply: (sqlite) => {
		ensureColumn(sqlite, 'monitoring_history', 'indexer_id', '"indexer_id" text');
		ensureColumn(sqlite, 'monitoring_history', 'indexer_name', '"indexer_name" text');
	}
};
