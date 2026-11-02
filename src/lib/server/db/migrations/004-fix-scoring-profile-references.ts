import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 4: Fix invalid scoring profile references and ensure default profile exists

export const migration_v004: MigrationDefinition = {
	version: 4,
	name: 'fix_scoring_profile_references',
	apply: (sqlite) => {
		// Ensure a default profile exists (set 'compact' as default if none)
		const hasDefault = sqlite.prepare(`SELECT id FROM scoring_profiles WHERE is_default = 1`).get();

		if (!hasDefault) {
			const validProfiles = sqlite.prepare(`SELECT id FROM scoring_profiles`).all() as {
				id: string;
			}[];
			const validIds = new Set(validProfiles.map((p) => p.id));

			if (validProfiles.length > 0) {
				const defaultId = validIds.has('compact') ? 'compact' : validProfiles[0].id;
				sqlite.prepare(`UPDATE scoring_profiles SET is_default = 1 WHERE id = ?`).run(defaultId);
				logger.info(`[SchemaSync] Set default scoring profile to '${defaultId}'`);
			}
		}

		// Clear invalid profile references (set to NULL so user can choose)
		// This prevents auto-downloads with unwanted profiles
		const invalidMovies = sqlite
			.prepare(
				`UPDATE movies SET scoring_profile_id = NULL
			 WHERE scoring_profile_id IS NOT NULL
			 AND scoring_profile_id != ''
			 AND scoring_profile_id NOT IN (SELECT id FROM scoring_profiles)`
			)
			.run();

		if (invalidMovies.changes > 0) {
			logger.info(
				`[SchemaSync] Cleared ${invalidMovies.changes} movies with invalid profile references`
			);
		}

		const invalidSeries = sqlite
			.prepare(
				`UPDATE series SET scoring_profile_id = NULL
			 WHERE scoring_profile_id IS NOT NULL
			 AND scoring_profile_id != ''
			 AND scoring_profile_id NOT IN (SELECT id FROM scoring_profiles)`
			)
			.run();

		if (invalidSeries.changes > 0) {
			logger.info(
				`[SchemaSync] Cleared ${invalidSeries.changes} series with invalid profile references`
			);
		}
	}
};
