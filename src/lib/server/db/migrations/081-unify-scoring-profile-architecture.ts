import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
export const migration_v081: MigrationDefinition = {
	version: 81,
	name: 'unify_scoring_profile_architecture',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'scoring_profiles', 'is_built_in')) {
			sqlite.prepare(`ALTER TABLE scoring_profiles ADD COLUMN is_built_in INTEGER DEFAULT 0`).run();
		}
		if (!columnExists(sqlite, 'scoring_profiles', 'min_resolution')) {
			sqlite.prepare(`ALTER TABLE scoring_profiles ADD COLUMN min_resolution text`).run();
		}
		if (!columnExists(sqlite, 'scoring_profiles', 'max_resolution')) {
			sqlite.prepare(`ALTER TABLE scoring_profiles ADD COLUMN max_resolution text`).run();
		}
		if (!columnExists(sqlite, 'scoring_profiles', 'allowed_sources')) {
			sqlite.prepare(`ALTER TABLE scoring_profiles ADD COLUMN allowed_sources text`).run();
		}
		if (!columnExists(sqlite, 'scoring_profiles', 'excluded_sources')) {
			sqlite.prepare(`ALTER TABLE scoring_profiles ADD COLUMN excluded_sources text`).run();
		}

		sqlite
			.prepare(
				`UPDATE scoring_profiles SET is_built_in = 1 WHERE id IN ('quality', 'balanced', 'compact', 'streamer')`
			)
			.run();

		try {
			if (tableExists(sqlite, 'profile_size_limits')) {
				const sizeLimits = sqlite
					.prepare(
						`SELECT profile_id, movie_min_size_gb, movie_max_size_gb, episode_min_size_mb, episode_max_size_mb, is_default FROM profile_size_limits`
					)
					.all() as Array<{
					profile_id: string;
					movie_min_size_gb: number | null;
					movie_max_size_gb: number | null;
					episode_min_size_mb: number | null;
					episode_max_size_mb: number | null;
					is_default: number | null;
				}>;

				for (const limit of sizeLimits) {
					sqlite
						.prepare(
							`UPDATE scoring_profiles SET
								movie_min_size_gb = ?,
								movie_max_size_gb = ?,
								episode_min_size_mb = ?,
								episode_max_size_mb = ?,
								is_default = COALESCE(?, is_default)
							WHERE id = ?`
						)
						.run(
							limit.movie_min_size_gb,
							limit.movie_max_size_gb,
							limit.episode_min_size_mb,
							limit.episode_max_size_mb,
							limit.is_default === 1 ? 1 : null,
							limit.profile_id
						);
				}

				if (sizeLimits.length > 0) {
					logger.info(
						{ count: sizeLimits.length },
						'[SchemaSync] Migrated profile_size_limits data into scoring_profiles'
					);
				}
			}
		} catch (error) {
			logger.warn(
				{ err: error instanceof Error ? error.message : String(error) },
				'[SchemaSync] Failed to migrate profile_size_limits, continuing'
			);
		}

		try {
			if (tableExists(sqlite, 'built_in_profile_score_overrides')) {
				const overrides = sqlite
					.prepare(`SELECT profile_id, format_scores FROM built_in_profile_score_overrides`)
					.all() as Array<{
					profile_id: string;
					format_scores: string | null;
				}>;

				for (const override of overrides) {
					if (!override.format_scores) continue;

					let overrideScores: Record<string, number>;
					try {
						overrideScores = JSON.parse(override.format_scores);
					} catch {
						continue;
					}

					if (!overrideScores || typeof overrideScores !== 'object') continue;

					const existingRow = sqlite
						.prepare(`SELECT format_scores FROM scoring_profiles WHERE id = ?`)
						.get(override.profile_id) as { format_scores: string | null } | undefined;

					let existingScores: Record<string, number> = {};
					if (existingRow?.format_scores) {
						try {
							const parsed = JSON.parse(existingRow.format_scores);
							if (parsed && typeof parsed === 'object') {
								existingScores = parsed;
							}
						} catch {
							// keep empty
						}
					}

					const mergedScores = { ...existingScores, ...overrideScores };

					sqlite
						.prepare(`UPDATE scoring_profiles SET format_scores = ? WHERE id = ?`)
						.run(JSON.stringify(mergedScores), override.profile_id);
				}

				if (overrides.length > 0) {
					logger.info(
						{ count: overrides.length },
						'[SchemaSync] Merged built_in_profile_score_overrides into scoring_profiles'
					);
				}
			}
		} catch (error) {
			logger.warn(
				{ err: error instanceof Error ? error.message : String(error) },
				'[SchemaSync] Failed to merge built_in_profile_score_overrides, continuing'
			);
		}

		logger.info('[SchemaSync] Unified scoring profile architecture (v81)');
	}
};
