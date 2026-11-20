import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 193: `music_scan_issues`.
 *
 * A music scan that could not identify a folder only wrote a log line. Video
 * has an unmatched-files surface; music needs the same review queue, so the
 * folder, what it looked like, and why it was refused are kept here.
 */
export const migration_v193: MigrationDefinition = {
	version: 193,
	name: 'music_scan_issues',
	apply: (sqlite) => {
		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "music_scan_issues" (
					"id" text PRIMARY KEY NOT NULL,
					"root_folder_id" text REFERENCES "root_folders"("id") ON DELETE CASCADE,
					"folder" text NOT NULL UNIQUE,
					"album_title" text,
					"artist_name" text,
					"reason" text NOT NULL,
					"status" text NOT NULL DEFAULT 'pending',
					"first_seen_at" text NOT NULL,
					"last_seen_at" text NOT NULL,
					"resolved_at" text
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_music_scan_issues_status" ON "music_scan_issues" ("status")`
			)
			.run();
	}
};
