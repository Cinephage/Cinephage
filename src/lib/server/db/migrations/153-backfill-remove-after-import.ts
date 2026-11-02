import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'migration-v153' });

/**
 * Backfill remove_after_import for non-debrid download clients.
 *
 * removeAfterImport used to be debrid-only; it now also governs whether the
 * monitor removes completed downloads (seeding goals met) from torrent and
 * usenet clients. Existing non-debrid clients all had auto-removal, so
 * backfilling 1 preserves their behavior exactly; the new settings toggle
 * turns it into an opt-out.
 */
export const migration_v153: MigrationDefinition = {
	version: 153,
	name: 'backfill_remove_after_import_non_debrid',
	apply: (sqlite) => {
		const result = sqlite
			.prepare(
				`UPDATE "download_clients" SET "remove_after_import" = 1
				 WHERE implementation NOT IN ('realdebrid', 'torbox')`
			)
			.run();
		logger.info(
			{ updated: result.changes },
			'Backfilled remove_after_import for non-debrid download clients'
		);
	}
};
