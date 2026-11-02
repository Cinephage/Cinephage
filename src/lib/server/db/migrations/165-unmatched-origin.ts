import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureColumn } from '../migration-helpers.js';

/**
 * Version 165: Add `origin` column to `download_queue`.
 *
 * Marks rows created by the Unmatched-tab track/enroll flow
 * ('unmatched_track' | 'unmatched_enroll'), left null for every other
 * insert path. Previously that flow's release-back-to-Unmatched logic
 * inferred "came from track/enroll" from indexerId being null, which
 * also matches legitimate arr_push-pushed grabs (releasePush.ts never
 * sets indexerId either) - unmatching a movie/series could wrongly
 * cancel and delete an unrelated, legitimate download.
 */
export const migration_v165: MigrationDefinition = {
	version: 165,
	name: 'unmatched_origin',
	apply: (sqlite) => {
		ensureColumn(sqlite, 'download_queue', 'origin', '"origin" text');
	}
};
