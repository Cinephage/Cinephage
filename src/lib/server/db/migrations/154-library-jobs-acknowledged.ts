import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureColumn } from '../migration-helpers.js';

/**
 * Version 154: library_jobs.acknowledged_at.
 *
 * Lets a user dismiss a failed background-import batch from the Activity
 * page's "Needs attention" list without retrying it; the job rows (and
 * their errorMessage) stay in the table as history, this just marks them
 * reviewed so the card stops surfacing them as actionable.
 */
export const migration_v154: MigrationDefinition = {
	version: 154,
	name: 'library_jobs_acknowledged',
	apply: (sqlite) => {
		ensureColumn(sqlite, 'library_jobs', 'acknowledged_at', '"acknowledged_at" text');
	}
};
