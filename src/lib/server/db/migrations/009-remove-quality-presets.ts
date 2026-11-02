import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 9: Remove deprecated qualityPresets system in favor of scoringProfiles

export const migration_v009: MigrationDefinition = {
	version: 9,
	name: 'remove_quality_presets',
	apply: (sqlite) => {
		// Step 1: Ensure default scoring profile exists
		const hasDefault = sqlite.prepare(`SELECT id FROM scoring_profiles WHERE is_default = 1`).get();
		let defaultProfileId = 'balanced';

		if (!hasDefault) {
			const validProfiles = sqlite.prepare(`SELECT id FROM scoring_profiles`).all() as {
				id: string;
			}[];
			if (validProfiles.length > 0) {
				const validIds = new Set(validProfiles.map((p) => p.id));
				defaultProfileId = validIds.has('balanced') ? 'balanced' : validProfiles[0].id;
				sqlite
					.prepare(`UPDATE scoring_profiles SET is_default = 1 WHERE id = ?`)
					.run(defaultProfileId);
			}
		} else {
			defaultProfileId = (hasDefault as { id: string }).id;
		}

		// Step 2: Migrate movies with quality_preset_id but no scoring_profile_id
		if (columnExists(sqlite, 'movies', 'quality_preset_id')) {
			const migratedMovies = sqlite
				.prepare(
					`UPDATE movies SET scoring_profile_id = ?
				 WHERE (scoring_profile_id IS NULL OR scoring_profile_id = '')
				 AND quality_preset_id IS NOT NULL`
				)
				.run(defaultProfileId);

			if (migratedMovies.changes > 0) {
				logger.info(
					`[SchemaSync] Migrated ${migratedMovies.changes} movies from qualityPresets to scoringProfiles`
				);
			}
		}

		// Step 3: Migrate series with quality_preset_id but no scoring_profile_id
		if (columnExists(sqlite, 'series', 'quality_preset_id')) {
			const migratedSeries = sqlite
				.prepare(
					`UPDATE series SET scoring_profile_id = ?
				 WHERE (scoring_profile_id IS NULL OR scoring_profile_id = '')
				 AND quality_preset_id IS NOT NULL`
				)
				.run(defaultProfileId);

			if (migratedSeries.changes > 0) {
				logger.info(
					`[SchemaSync] Migrated ${migratedSeries.changes} series from qualityPresets to scoringProfiles`
				);
			}
		}

		// Step 4: Drop quality_preset_id column from movies (requires table recreation)
		if (columnExists(sqlite, 'movies', 'quality_preset_id')) {
			sqlite
				.prepare(
					`CREATE TABLE "movies_new" (
				"id" text PRIMARY KEY NOT NULL,
				"tmdb_id" integer NOT NULL UNIQUE,
				"imdb_id" text,
				"title" text NOT NULL,
				"original_title" text,
				"year" integer,
				"overview" text,
				"poster_path" text,
				"backdrop_path" text,
				"runtime" integer,
				"genres" text,
				"path" text NOT NULL,
				"root_folder_id" text REFERENCES "root_folders"("id") ON DELETE SET NULL,
				"scoring_profile_id" text REFERENCES "scoring_profiles"("id") ON DELETE SET NULL,
				"language_profile_id" text,
				"monitored" integer DEFAULT true,
				"minimum_availability" text DEFAULT 'released',
				"added" text,
				"has_file" integer DEFAULT false,
				"wants_subtitles" integer DEFAULT true,
				"last_search_time" text
			)`
				)
				.run();

			sqlite
				.prepare(
					`INSERT INTO "movies_new" SELECT
				id, tmdb_id, imdb_id, title, original_title, year, overview,
				poster_path, backdrop_path, runtime, genres, path, root_folder_id,
				scoring_profile_id, language_profile_id, monitored, minimum_availability,
				added, has_file, wants_subtitles, last_search_time
			FROM "movies"`
				)
				.run();

			sqlite.prepare(`DROP TABLE "movies"`).run();
			sqlite.prepare(`ALTER TABLE "movies_new" RENAME TO "movies"`).run();

			// Recreate indexes
			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_movies_monitored_hasfile" ON "movies" ("monitored", "has_file")`
				)
				.run();
		}

		// Step 5: Drop quality_preset_id column from series (requires table recreation)
		if (columnExists(sqlite, 'series', 'quality_preset_id')) {
			sqlite
				.prepare(
					`CREATE TABLE "series_new" (
				"id" text PRIMARY KEY NOT NULL,
				"tmdb_id" integer NOT NULL UNIQUE,
				"tvdb_id" integer,
				"imdb_id" text,
				"title" text NOT NULL,
				"original_title" text,
				"year" integer,
				"overview" text,
				"poster_path" text,
				"backdrop_path" text,
				"status" text,
				"network" text,
				"genres" text,
				"path" text NOT NULL,
				"root_folder_id" text REFERENCES "root_folders"("id") ON DELETE SET NULL,
				"scoring_profile_id" text REFERENCES "scoring_profiles"("id") ON DELETE SET NULL,
				"language_profile_id" text,
				"monitored" integer DEFAULT true,
				"monitor_new_items" text DEFAULT 'all',
				"monitor_specials" integer DEFAULT false,
				"season_folder" integer DEFAULT true,
				"series_type" text DEFAULT 'standard',
				"added" text,
				"episode_count" integer DEFAULT 0,
				"episode_file_count" integer DEFAULT 0,
				"wants_subtitles" integer DEFAULT true
			)`
				)
				.run();

			sqlite
				.prepare(
					`INSERT INTO "series_new" SELECT
				id, tmdb_id, tvdb_id, imdb_id, title, original_title, year, overview,
				poster_path, backdrop_path, status, network, genres, path, root_folder_id,
				scoring_profile_id, language_profile_id, monitored, monitor_new_items,
				monitor_specials, season_folder, series_type, added, episode_count,
				episode_file_count, wants_subtitles
			FROM "series"`
				)
				.run();

			sqlite.prepare(`DROP TABLE "series"`).run();
			sqlite.prepare(`ALTER TABLE "series_new" RENAME TO "series"`).run();

			// Recreate indexes
			sqlite
				.prepare(`CREATE INDEX IF NOT EXISTS "idx_series_monitored" ON "series" ("monitored")`)
				.run();
		}

		// Step 6: Drop quality_presets table
		if (tableExists(sqlite, 'quality_presets')) {
			sqlite.prepare(`DROP TABLE "quality_presets"`).run();
			logger.info('[SchemaSync] Dropped deprecated quality_presets table');
		}

		logger.info(
			'[SchemaSync] Completed migration from qualityPresets to scoringProfiles (Version 9)'
		);
	}
};
