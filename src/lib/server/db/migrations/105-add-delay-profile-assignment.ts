import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';

export const migration_v105: MigrationDefinition = {
	version: 105,
	name: 'add_delay_profile_assignment',
	apply: (sqlite) => {
		// Ensure delay_profiles and pending_releases tables exist (in case they were not created
		// by a previous migration - they were added directly to the base schema).
		if (!tableExists(sqlite, 'delay_profiles')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "delay_profiles" (
						"id" text PRIMARY KEY NOT NULL,
						"name" text NOT NULL,
						"sort_order" integer NOT NULL DEFAULT 0,
						"enabled" integer DEFAULT 1,
						"usenet_delay" integer NOT NULL DEFAULT 0,
						"torrent_delay" integer NOT NULL DEFAULT 0,
						"quality_delays" text,
						"preferred_protocol" text,
						"tags" text,
						"bypass_if_highest_quality" integer DEFAULT 1,
						"bypass_if_above_score" integer,
						"created_at" text,
						"updated_at" text
					)`
				)
				.run();
		}

		if (!tableExists(sqlite, 'pending_releases')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "pending_releases" (
						"id" text PRIMARY KEY NOT NULL,
						"title" text NOT NULL,
						"info_hash" text,
						"indexer_id" text,
						"download_url" text,
						"magnet_url" text,
						"movie_id" text,
						"series_id" text,
						"episode_ids" text,
						"score" integer NOT NULL,
						"size" integer,
						"protocol" text NOT NULL,
						"quality" text,
						"delay_profile_id" text,
						"added_at" text,
						"process_at" text NOT NULL,
						"status" text NOT NULL DEFAULT 'pending',
						"superseded_by" text
					)`
				)
				.run();
		}

		// Add publish_date to pending_releases so we can show when the release was originally published
		if (!columnExists(sqlite, 'pending_releases', 'publish_date')) {
			sqlite.prepare(`ALTER TABLE "pending_releases" ADD COLUMN "publish_date" text`).run();
		}

		// Add delay_profile_id FK to movies
		if (!columnExists(sqlite, 'movies', 'delay_profile_id')) {
			sqlite
				.prepare(
					`ALTER TABLE "movies" ADD COLUMN "delay_profile_id" text REFERENCES "delay_profiles"("id") ON DELETE SET NULL`
				)
				.run();
		}

		// Add delay_profile_id FK to series
		if (!columnExists(sqlite, 'series', 'delay_profile_id')) {
			sqlite
				.prepare(
					`ALTER TABLE "series" ADD COLUMN "delay_profile_id" text REFERENCES "delay_profiles"("id") ON DELETE SET NULL`
				)
				.run();
		}
	}
};
