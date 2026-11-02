import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureColumn } from '../migration-helpers.js';

/**
 * Version 166: scoring_profiles.allowed_indexers.
 *
 * JSON array of indexer IDs that a profile is allowed to search. NULL means
 * "all indexers" — the behavior every existing profile had before this column
 * existed, so upgrading is a no-op until a user opts in. An empty array is not
 * stored (the API rejects it); a profile is either unrestricted or restricted
 * to at least one indexer.
 */
export const migration_v166: MigrationDefinition = {
	version: 166,
	name: 'scoring_profile_allowed_indexers',
	apply: (sqlite) => {
		ensureColumn(sqlite, 'scoring_profiles', 'allowed_indexers', '"allowed_indexers" text');
	}
};
