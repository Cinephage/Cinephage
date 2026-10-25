import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
export const migration_v070: MigrationDefinition = {
	version: 70,
	name: 'drop_unused_activities_tables',
	apply: (sqlite) => {
		// The "activities" and "activity_details" tables were scaffolding for a
		// materialized-view pattern that was never implemented.  The actual
		// Activity page reads directly from download_queue, download_history,
		// and monitoring_history.  Both tables are always empty and can be
		// safely dropped.  activity_details has a FK to activities, so it must
		// be dropped first.
		sqlite.prepare('DROP TABLE IF EXISTS "activity_details"').run();
		sqlite.prepare('DROP TABLE IF EXISTS "activities"').run();
		logger.info('[SchemaSync] Dropped unused activities and activity_details tables');
	}
};
