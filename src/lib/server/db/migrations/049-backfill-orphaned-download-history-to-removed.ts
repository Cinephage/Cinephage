import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Migration 49: Mark orphaned imported/streaming history rows as removed

export const migration_v049: MigrationDefinition = {
	version: 49,
	name: 'backfill_orphaned_download_history_to_removed',
	apply: (sqlite) => {
		const result = sqlite
			.prepare(
				`
					UPDATE download_history
					SET status = 'removed',
						status_reason = NULL
					WHERE movie_id IS NULL
						AND series_id IS NULL
						AND status IN ('imported', 'streaming')
				`
			)
			.run();

		logger.info(
			{
				rowsUpdated: result.changes
			},
			'[SchemaSync] Backfilled orphaned download_history rows to removed'
		);
	}
};
