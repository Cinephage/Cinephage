import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Remove the "Default Movie" / "Default TV" scaffolding profiles introduced by v114.
 *
 * v114 seeded two built-in default profiles (both with is_default = 1) and added
 * dead columns (is_builtin, media_type) that no application code ever reads.
 * The dual-default state broke the single-default invariant, causing both profiles
 * to leak into every quality-profile dropdown regardless of media type.
 *
 * This migration:
 *   1. Resolves a single surviving default (existing user-chosen default, or 'balanced')
 *   2. Reassigns all FK references from the removed profiles to the surviving default
 *   3. Deletes the two scaffolding rows
 *   4. Drops the dead is_builtin and media_type columns
 *
 * Idempotent: safe to re-run. Tables/columns/rows that no longer exist are skipped.
 */
export const migration_v122: MigrationDefinition = {
	version: 122,
	name: 'remove_quality_scaffolding_defaults',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'scoring_profiles')) {
			return;
		}

		// Step 1: Resolve the surviving default profile.
		// Prefer a default that is NOT one of the removed v114 rows.
		const survivingDefault = sqlite
			.prepare(
				`SELECT id FROM scoring_profiles
				 WHERE is_default = 1
				   AND id NOT IN ('profile-default-movie', 'profile-default-tv')
				 LIMIT 1`
			)
			.get() as { id: string } | undefined;

		let defaultProfileId: string | null = survivingDefault?.id ?? null;

		if (!defaultProfileId) {
			// No surviving default — fall back to 'balanced' if it exists.
			const balanced = sqlite
				.prepare(`SELECT id FROM scoring_profiles WHERE id = 'balanced' LIMIT 1`)
				.get() as { id: string } | undefined;

			if (balanced) {
				defaultProfileId = 'balanced';
				// Restore single-default invariant.
				sqlite.prepare(`UPDATE scoring_profiles SET is_default = 0`).run();
				sqlite
					.prepare(`UPDATE scoring_profiles SET is_default = 1 WHERE id = ?`)
					.run(defaultProfileId);
			}
		}

		// Step 2: Reassign FK references from removed profiles to the surviving default.
		if (defaultProfileId) {
			const fkTables: Array<{ table: string; column: string }> = [
				{ table: 'movies', column: 'scoring_profile_id' },
				{ table: 'series', column: 'scoring_profile_id' },
				{ table: 'libraries', column: 'quality_profile_id' },
				{ table: 'delay_profiles', column: 'quality_profile_id' },
				{ table: 'smart_lists', column: 'scoring_profile_id' }
			];

			for (const { table, column } of fkTables) {
				if (!tableExists(sqlite, table) || !columnExists(sqlite, table, column)) {
					continue;
				}

				const result = sqlite
					.prepare(
						`UPDATE "${table}" SET "${column}" = ?
						 WHERE "${column}" IN ('profile-default-movie', 'profile-default-tv')`
					)
					.run(defaultProfileId);

				if (result.changes > 0) {
					logger.info(
						`[migration v122] Reassigned ${result.changes} ${table}.${column} references to '${defaultProfileId}'`
					);
				}
			}
		}

		// Step 3: Delete the two seeded v114 rows.
		const deleted = sqlite
			.prepare(
				`DELETE FROM scoring_profiles
				 WHERE id IN ('profile-default-movie', 'profile-default-tv')`
			)
			.run();

		if (deleted.changes > 0) {
			logger.info(`[migration v122] Removed ${deleted.changes} scaffolding default profile row(s)`);
		}

		// Step 4: Drop dead columns added by v114 (is_builtin, media_type).
		// Nothing in the application reads either column. SQLite 3.35+ supports DROP COLUMN.
		for (const column of ['is_builtin', 'media_type']) {
			if (!columnExists(sqlite, 'scoring_profiles', column)) {
				continue;
			}

			try {
				sqlite.prepare(`ALTER TABLE "scoring_profiles" DROP COLUMN "${column}"`).run();
				logger.info(`[migration v122] Dropped scoring_profiles.${column}`);
			} catch (e) {
				logger.warn(
					{ err: e instanceof Error ? e.message : String(e) },
					`[migration v122] Could not drop scoring_profiles.${column} — column left as dead data`
				);
			}
		}

		logger.info('[migration v122] Quality scaffolding defaults removed');
	}
};
