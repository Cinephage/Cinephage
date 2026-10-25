import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';
import { SYSTEM_LIBRARY_SEEDS } from '../schema-sync.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 78: Backfill existing movies and series to seeded system libraries

export const migration_v078: MigrationDefinition = {
	version: 78,
	name: 'backfill_existing_media_to_system_libraries',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'libraries')) {
			logger.info('[SchemaSync] libraries table not found, skipping system library backfill');
			return;
		}

		const hasMoviesLibraryId = columnExists(sqlite, 'movies', 'library_id');
		const hasSeriesLibraryId = columnExists(sqlite, 'series', 'library_id');

		if (!hasMoviesLibraryId && !hasSeriesLibraryId) {
			logger.info('[SchemaSync] Media library columns not found, skipping system library backfill');
			return;
		}

		const now = new Date().toISOString();

		const ensureLibrarySeed = sqlite.prepare(`
			INSERT INTO "libraries" (
				"id", "name", "slug", "media_type", "media_sub_type", "is_system", "system_key",
				"is_default", "default_root_folder_id", "default_monitored",
				"default_search_on_add", "default_wants_subtitles", "sort_order", "created_at", "updated_at"
			)
			VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, 1, 1, 1, ?, ?, ?)
			ON CONFLICT("system_key") DO UPDATE SET
				"name" = excluded."name",
				"slug" = excluded."slug",
				"media_type" = excluded."media_type",
				"media_sub_type" = excluded."media_sub_type",
				"is_default" = excluded."is_default",
				"updated_at" = excluded."updated_at"
		`);

		for (const seed of SYSTEM_LIBRARY_SEEDS) {
			ensureLibrarySeed.run(
				seed.id,
				seed.mediaType === 'movie' && seed.mediaSubType === 'anime'
					? 'Anime Movies'
					: seed.mediaType === 'movie'
						? 'Movies'
						: seed.mediaSubType === 'anime'
							? 'Anime Series'
							: 'TV Shows',
				seed.slug,
				seed.mediaType,
				seed.mediaSubType,
				seed.systemKey,
				seed.id === 'lib-movies-standard' || seed.id === 'lib-tv-standard' ? 1 : 0,
				seed.sortOrder,
				now,
				now
			);
		}

		if (hasMoviesLibraryId) {
			sqlite
				.prepare(
					`UPDATE "movies"
					SET "library_id" = CASE
						WHEN "library_id" IS NOT NULL
							AND EXISTS (SELECT 1 FROM "libraries" l WHERE l."id" = "movies"."library_id")
						THEN "library_id"
						WHEN "root_folder_id" IS NOT NULL THEN (
							SELECT l."id"
							FROM "libraries" l
							WHERE l."id" = CASE
								WHEN (
									SELECT COALESCE(rf."media_sub_type", 'standard')
									FROM "root_folders" rf
									WHERE rf."id" = "movies"."root_folder_id"
									LIMIT 1
								) = 'anime'
								THEN 'lib-movies-anime'
								ELSE 'lib-movies-standard'
							END
						)
						ELSE 'lib-movies-standard'
					END
					WHERE "library_id" IS NULL
						OR NOT EXISTS (SELECT 1 FROM "libraries" l WHERE l."id" = "movies"."library_id")`
				)
				.run();
		}

		if (hasSeriesLibraryId) {
			sqlite
				.prepare(
					`UPDATE "series"
					SET "library_id" = CASE
						WHEN "library_id" IS NOT NULL
							AND EXISTS (SELECT 1 FROM "libraries" l WHERE l."id" = "series"."library_id")
						THEN "library_id"
						WHEN "root_folder_id" IS NOT NULL THEN (
							SELECT l."id"
							FROM "libraries" l
							WHERE l."id" = CASE
								WHEN (
									SELECT COALESCE(rf."media_sub_type", 'standard')
									FROM "root_folders" rf
									WHERE rf."id" = "series"."root_folder_id"
									LIMIT 1
								) = 'anime'
								THEN 'lib-tv-anime'
								ELSE 'lib-tv-standard'
							END
						)
						ELSE 'lib-tv-standard'
					END
					WHERE "library_id" IS NULL
						OR NOT EXISTS (SELECT 1 FROM "libraries" l WHERE l."id" = "series"."library_id")`
				)
				.run();
		}

		logger.info('[SchemaSync] Backfilled existing media into seeded system libraries');
	}
};
