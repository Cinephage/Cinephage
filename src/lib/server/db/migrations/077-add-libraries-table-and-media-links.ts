import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
export const migration_v077: MigrationDefinition = {
	version: 77,
	name: 'add_libraries_table_and_media_links',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'libraries')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "libraries" (
						"id" text PRIMARY KEY NOT NULL,
						"name" text NOT NULL,
						"slug" text NOT NULL UNIQUE,
						"media_type" text NOT NULL CHECK ("media_type" IN ('movie', 'tv')),
						"media_sub_type" text DEFAULT 'custom' NOT NULL CHECK ("media_sub_type" IN ('standard', 'anime', 'custom')),
						"is_system" integer DEFAULT false NOT NULL,
						"system_key" text UNIQUE,
						"is_default" integer DEFAULT false NOT NULL,
						"default_root_folder_id" text REFERENCES "root_folders"("id") ON DELETE SET NULL,
						"default_monitored" integer DEFAULT true NOT NULL,
						"default_search_on_add" integer DEFAULT true NOT NULL,
						"default_wants_subtitles" integer DEFAULT true NOT NULL,
						"sort_order" integer DEFAULT 0 NOT NULL,
						"created_at" text,
						"updated_at" text
					)`
				)
				.run();
			logger.info('[SchemaSync] Created libraries table');
		}

		if (!columnExists(sqlite, 'movies', 'library_id')) {
			sqlite
				.prepare(
					`ALTER TABLE "movies" ADD COLUMN "library_id" text REFERENCES "libraries"("id") ON DELETE SET NULL`
				)
				.run();
			logger.info('[SchemaSync] Added movies.library_id column');
		}

		if (!columnExists(sqlite, 'series', 'library_id')) {
			sqlite
				.prepare(
					`ALTER TABLE "series" ADD COLUMN "library_id" text REFERENCES "libraries"("id") ON DELETE SET NULL`
				)
				.run();
			logger.info('[SchemaSync] Added series.library_id column');
		}

		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_libraries_media_type" ON "libraries" ("media_type")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_libraries_media_sub_type" ON "libraries" ("media_sub_type")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_libraries_sort_order" ON "libraries" ("sort_order")`
			)
			.run();
		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS "idx_movies_library_id" ON "movies" ("library_id")`)
			.run();
		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS "idx_series_library_id" ON "series" ("library_id")`)
			.run();

		const getRootFolder = sqlite.prepare(
			`SELECT "id", "default_monitored"
			FROM "root_folders"
			WHERE "media_type" = ? AND COALESCE("media_sub_type", 'standard') = ?
			ORDER BY "is_default" DESC, "created_at" ASC
			LIMIT 1`
		);
		const now = new Date().toISOString();

		const movieStandardRoot = getRootFolder.get('movie', 'standard') as
			{ id: string; default_monitored: number | null } | undefined;
		const movieAnimeRoot = getRootFolder.get('movie', 'anime') as
			{ id: string; default_monitored: number | null } | undefined;
		const tvStandardRoot = getRootFolder.get('tv', 'standard') as
			{ id: string; default_monitored: number | null } | undefined;
		const tvAnimeRoot = getRootFolder.get('tv', 'anime') as
			{ id: string; default_monitored: number | null } | undefined;

		const upsertLibrary = sqlite.prepare(`
			INSERT INTO "libraries" (
				"id", "name", "slug", "media_type", "media_sub_type", "is_system", "system_key",
				"is_default", "default_root_folder_id", "default_monitored",
				"default_search_on_add", "default_wants_subtitles", "sort_order", "created_at", "updated_at"
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT("system_key") DO UPDATE SET
				"name" = excluded."name",
				"slug" = excluded."slug",
				"media_type" = excluded."media_type",
				"media_sub_type" = excluded."media_sub_type",
				"is_default" = excluded."is_default",
				"default_root_folder_id" = excluded."default_root_folder_id",
				"default_monitored" = excluded."default_monitored",
				"default_search_on_add" = excluded."default_search_on_add",
				"default_wants_subtitles" = excluded."default_wants_subtitles",
				"sort_order" = excluded."sort_order",
				"updated_at" = excluded."updated_at"
		`);

		upsertLibrary.run(
			'lib-movies-standard',
			'Movies',
			'movies',
			'movie',
			'standard',
			1,
			'movies_standard',
			1,
			movieStandardRoot?.id ?? null,
			movieStandardRoot?.default_monitored === 0 ? 0 : 1,
			1,
			1,
			0,
			now,
			now
		);
		upsertLibrary.run(
			'lib-movies-anime',
			'Anime Movies',
			'anime-movies',
			'movie',
			'anime',
			1,
			'movies_anime',
			0,
			movieAnimeRoot?.id ?? null,
			movieAnimeRoot?.default_monitored === 0 ? 0 : 1,
			1,
			1,
			10,
			now,
			now
		);
		upsertLibrary.run(
			'lib-tv-standard',
			'TV Shows',
			'tv-shows',
			'tv',
			'standard',
			1,
			'tv_standard',
			1,
			tvStandardRoot?.id ?? null,
			tvStandardRoot?.default_monitored === 0 ? 0 : 1,
			1,
			1,
			0,
			now,
			now
		);
		upsertLibrary.run(
			'lib-tv-anime',
			'Anime Series',
			'anime-series',
			'tv',
			'anime',
			1,
			'tv_anime',
			0,
			tvAnimeRoot?.id ?? null,
			tvAnimeRoot?.default_monitored === 0 ? 0 : 1,
			1,
			1,
			10,
			now,
			now
		);

		sqlite
			.prepare(
				`UPDATE "movies"
				SET "library_id" = CASE
					WHEN EXISTS (
						SELECT 1
						FROM "root_folders" rf
						WHERE rf."id" = "movies"."root_folder_id"
							AND COALESCE(rf."media_sub_type", 'standard') = 'anime'
					)
					THEN 'lib-movies-anime'
					ELSE 'lib-movies-standard'
				END
				WHERE "library_id" IS NULL`
			)
			.run();

		sqlite
			.prepare(
				`UPDATE "series"
				SET "library_id" = CASE
					WHEN EXISTS (
						SELECT 1
						FROM "root_folders" rf
						WHERE rf."id" = "series"."root_folder_id"
							AND COALESCE(rf."media_sub_type", 'standard') = 'anime'
					)
					THEN 'lib-tv-anime'
					ELSE 'lib-tv-standard'
				END
				WHERE "library_id" IS NULL`
			)
			.run();

		sqlite
			.prepare(
				`UPDATE "movies"
				SET "library_id" = 'lib-movies-standard'
				WHERE "library_id" IS NOT NULL
					AND NOT EXISTS (SELECT 1 FROM "libraries" l WHERE l."id" = "movies"."library_id")`
			)
			.run();

		sqlite
			.prepare(
				`UPDATE "series"
				SET "library_id" = 'lib-tv-standard'
				WHERE "library_id" IS NOT NULL
					AND NOT EXISTS (SELECT 1 FROM "libraries" l WHERE l."id" = "series"."library_id")`
			)
			.run();

		logger.info('[SchemaSync] Seeded system libraries and backfilled media library_id');
	}
};
