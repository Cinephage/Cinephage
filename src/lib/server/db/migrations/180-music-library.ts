import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 180: music library.
 *
 * Adds the music media kind — `media_items` (the shared identity row the
 * non-video kinds hang off), `artists`, `albums`, `tracks` and `track_files`.
 *
 * Additive on purpose: no existing table is rebuilt and no existing column is
 * changed, so this lands on a populated database without touching a row. The
 * `libraries.media_type` CHECK still says ('movie','tv') — widening it is a
 * table rebuild and lands separately, once a music library has to exist.
 *
 * Every statement is idempotent because a fresh database replays every
 * migration on top of the DDL in schema-sync.ts.
 */
export const migration_v180: MigrationDefinition = {
	version: 180,
	name: 'music_library',
	apply: (sqlite) => {
		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "media_items" (
"id" text PRIMARY KEY NOT NULL,
"kind" text NOT NULL,
"title" text NOT NULL,
"sort_title" text,
"year" integer,
"path" text,
"library_id" text REFERENCES "libraries"("id") ON DELETE SET NULL,
"root_folder_id" text REFERENCES "root_folders"("id") ON DELETE SET NULL,
"monitored" integer DEFAULT true,
"provider_refs" text,
"added" text,
"updated_at" text
)`
			)
			.run();

		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "artists" (
"id" text PRIMARY KEY NOT NULL,
"mbid" text,
"name" text NOT NULL,
"sort_name" text,
"disambiguation" text,
"artist_type" text,
"country" text,
"genres" text,
"overview" text,
"image_path" text,
"monitored" integer DEFAULT true,
"library_id" text REFERENCES "libraries"("id") ON DELETE SET NULL,
"root_folder_id" text REFERENCES "root_folders"("id") ON DELETE SET NULL,
"added" text,
"refreshed_at" text
)`
			)
			.run();

		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "albums" (
"id" text PRIMARY KEY NOT NULL,
"media_item_id" text NOT NULL REFERENCES "media_items"("id") ON DELETE CASCADE,
"artist_id" text NOT NULL REFERENCES "artists"("id") ON DELETE CASCADE,
"mbid" text,
"release_mbid" text,
"title" text NOT NULL,
"sort_title" text,
"year" integer,
"primary_type" text,
"secondary_types" text,
"status" text,
"label_name" text,
"catalog_number" text,
"barcode" text,
"country" text,
"media_count" integer,
"track_count" integer,
"duration" integer,
"cover_path" text,
"path" text,
"library_id" text REFERENCES "libraries"("id") ON DELETE SET NULL,
"root_folder_id" text REFERENCES "root_folders"("id") ON DELETE SET NULL,
"monitored" integer DEFAULT true,
"has_file" integer DEFAULT false,
"added" text,
"refreshed_at" text,
"last_searched_at" text
)`
			)
			.run();

		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "tracks" (
"id" text PRIMARY KEY NOT NULL,
"album_id" text NOT NULL REFERENCES "albums"("id") ON DELETE CASCADE,
"recording_mbid" text,
"title" text NOT NULL,
"artist_credit" text,
"disc_number" integer DEFAULT 1,
"track_number" integer,
"position" integer,
"duration" integer,
"explicit" integer DEFAULT false,
"has_file" integer DEFAULT false,
"added" text
)`
			)
			.run();

		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "track_files" (
"id" text PRIMARY KEY NOT NULL,
"album_id" text NOT NULL REFERENCES "albums"("id") ON DELETE CASCADE,
"track_id" text REFERENCES "tracks"("id") ON DELETE SET NULL,
"relative_path" text NOT NULL,
"size_bytes" integer,
"format" text,
"bitrate_kbps" integer,
"bit_depth" integer,
"sample_rate_hz" integer,
"channels" integer,
"duration" integer,
"added" text
)`
			)
			.run();

		for (const indexDef of [
			`CREATE INDEX IF NOT EXISTS "idx_media_items_kind" ON "media_items" ("kind")`,
			`CREATE INDEX IF NOT EXISTS "idx_media_items_library" ON "media_items" ("library_id")`,
			`CREATE INDEX IF NOT EXISTS "idx_media_items_monitored" ON "media_items" ("monitored")`,
			`CREATE UNIQUE INDEX IF NOT EXISTS "idx_artists_mbid" ON "artists" ("mbid")`,
			`CREATE INDEX IF NOT EXISTS "idx_artists_library" ON "artists" ("library_id")`,
			`CREATE INDEX IF NOT EXISTS "idx_artists_monitored" ON "artists" ("monitored")`,
			`CREATE UNIQUE INDEX IF NOT EXISTS "idx_albums_media_item" ON "albums" ("media_item_id")`,
			`CREATE UNIQUE INDEX IF NOT EXISTS "idx_albums_mbid_artist" ON "albums" ("mbid", "artist_id")`,
			`CREATE INDEX IF NOT EXISTS "idx_albums_artist" ON "albums" ("artist_id")`,
			`CREATE INDEX IF NOT EXISTS "idx_albums_library" ON "albums" ("library_id")`,
			`CREATE INDEX IF NOT EXISTS "idx_albums_root_folder" ON "albums" ("root_folder_id")`,
			`CREATE INDEX IF NOT EXISTS "idx_albums_monitored_hasfile" ON "albums" ("monitored", "has_file")`,
			`CREATE UNIQUE INDEX IF NOT EXISTS "idx_tracks_album_disc_track"
	ON "tracks" ("album_id", "disc_number", "track_number")`,
			`CREATE INDEX IF NOT EXISTS "idx_tracks_album" ON "tracks" ("album_id")`,
			`CREATE INDEX IF NOT EXISTS "idx_tracks_recording" ON "tracks" ("recording_mbid")`,
			`CREATE UNIQUE INDEX IF NOT EXISTS "idx_track_files_album_path" ON "track_files" ("album_id", "relative_path")`,
			`CREATE INDEX IF NOT EXISTS "idx_track_files_album" ON "track_files" ("album_id")`,
			`CREATE INDEX IF NOT EXISTS "idx_track_files_track" ON "track_files" ("track_id")`
		]) {
			sqlite.prepare(indexDef).run();
		}
	}
};
