import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureColumn } from '../migration-helpers.js';

/**
 * Version 155: indexers.rate_limit_per_minute.
 *
 * Lets a user cap how many requests Cinephage sends to a given indexer per
 * minute. Indexers without an explicit YAML `requestdelay` (most
 * custom/manually-added Newznab/Torznab indexers) previously fell back to a
 * generic default that could exceed a real account's API quota, especially
 * during a large automatic/manual series search. Null keeps the existing
 * definition-driven or generic default behavior.
 */
export const migration_v155: MigrationDefinition = {
	version: 155,
	name: 'indexer_rate_limit_override',
	apply: (sqlite) => {
		ensureColumn(sqlite, 'indexers', 'rate_limit_per_minute', '"rate_limit_per_minute" integer');
	}
};
