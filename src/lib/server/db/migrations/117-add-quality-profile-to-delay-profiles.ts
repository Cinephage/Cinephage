import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v117: MigrationDefinition = {
	version: 117,
	name: 'add_quality_profile_to_delay_profiles',
	apply: (sqlite) => {
		try {
			sqlite
				.prepare(
					'ALTER TABLE delay_profiles ADD COLUMN quality_profile_id text REFERENCES scoring_profiles(id) ON DELETE SET NULL'
				)
				.run();
			logger.info('[migration v117] Added quality_profile_id to delay_profiles');
		} catch (e) {
			logger.info(
				{ err: e instanceof Error ? e.message : String(e) },
				'[migration v117] Column may already exist, skipping'
			);
		}
	}
};
