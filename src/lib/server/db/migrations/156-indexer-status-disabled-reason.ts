import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureColumn } from '../migration-helpers.js';

/**
 * Version 156: indexer_status.disabled_reason.
 *
 * Distinguishes an indexer auto-disabled because it self-reported an
 * exhausted API quota ('quota_exceeded') from one disabled after repeated
 * unexplained failures ('consecutive_failures'), so the UI can show the
 * right explanation instead of a generic "Unhealthy" badge.
 */
export const migration_v156: MigrationDefinition = {
	version: 156,
	name: 'indexer_status_disabled_reason',
	apply: (sqlite) => {
		ensureColumn(sqlite, 'indexer_status', 'disabled_reason', '"disabled_reason" text');
	}
};
