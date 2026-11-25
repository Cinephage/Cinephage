import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 187: a music profile owns its fallback switch and size bounds.
 *
 * 186 reused `upgrades_allowed` for "fall back to a lower rung", which is a
 * different question from video's "replace this file with a better one" — the
 * editor wrote one meaning into a column the video side reads with the other.
 * The switch gets its own column, backfilled from the old value so nothing a
 * person already chose changes. Size bounds are MB of audio, not the movie/
 * episode limits video profiles carry.
 */
function hasColumn(
	sqlite: Parameters<MigrationDefinition['apply']>[0],
	table: string,
	column: string
) {
	const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
	return columns.some((entry) => entry.name === column);
}

export const migration_v187: MigrationDefinition = {
	version: 187,
	name: 'music_profile_fallback_and_size',
	apply: (sqlite) => {
		if (!hasColumn(sqlite, 'scoring_profiles', 'music_allow_fallback')) {
			sqlite
				.prepare(
					`ALTER TABLE "scoring_profiles" ADD COLUMN "music_allow_fallback" integer DEFAULT true`
				)
				.run();
		}
		if (!hasColumn(sqlite, 'scoring_profiles', 'music_min_size_mb')) {
			sqlite.prepare(`ALTER TABLE "scoring_profiles" ADD COLUMN "music_min_size_mb" real`).run();
		}
		if (!hasColumn(sqlite, 'scoring_profiles', 'music_max_size_mb')) {
			sqlite.prepare(`ALTER TABLE "scoring_profiles" ADD COLUMN "music_max_size_mb" real`).run();
		}

		sqlite
			.prepare(
				`UPDATE "scoring_profiles"
				 SET "music_allow_fallback" = COALESCE("upgrades_allowed", 1)
				 WHERE "media_kind" = 'music'`
			)
			.run();
	}
};
