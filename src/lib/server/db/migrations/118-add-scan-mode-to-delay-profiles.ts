import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v118: MigrationDefinition = {
	version: 118,
	name: 'add_scan_mode_to_delay_profiles',
	apply: (sqlite) => {
		try {
			sqlite
				.prepare(
					`ALTER TABLE "delay_profiles" ADD COLUMN "scan_mode" text NOT NULL DEFAULT 'scheduled'`
				)
				.run();
			sqlite.prepare(`ALTER TABLE "delay_profiles" ADD COLUMN "scan_config" text`).run();

			logger.info('[migration v118] scan_mode + scan_config columns added to delay_profiles');
		} catch (e) {
			logger.info(
				{ err: e instanceof Error ? e.message : String(e) },
				'[migration v118] Columns may already exist, skipping'
			);
		}
	}
};
