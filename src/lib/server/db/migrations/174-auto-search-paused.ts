import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureColumn } from '../migration-helpers.js';

/**
 * Version 174: movies.auto_search_paused, episodes.auto_search_paused.
 *
 * Lets a user pause auto-search for a single item from the Searches tab's
 * detail drawer, independent of `monitored` (which gates far more than just
 * searching) and independent of the missing-content-only failure cap
 * (consecutive_failure_count) - a user-initiated pause should stop every
 * search task type from touching the item, not just missing-content search.
 * NULL/0 for every existing row means no behavior change until a user
 * explicitly pauses something.
 */
export const migration_v174: MigrationDefinition = {
	version: 174,
	name: 'auto_search_paused',
	apply: (sqlite) => {
		ensureColumn(
			sqlite,
			'movies',
			'auto_search_paused',
			'"auto_search_paused" integer not null default 0'
		);
		ensureColumn(
			sqlite,
			'episodes',
			'auto_search_paused',
			'"auto_search_paused" integer not null default 0'
		);
	}
};
