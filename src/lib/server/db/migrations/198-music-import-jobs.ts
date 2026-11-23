import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 198: `music_import_jobs`.
 *
 * An import of a real library is minutes of MusicBrainz work, and a person
 * with a lot of music starts it and leaves. Keeping the job only in memory
 * meant a deploy or a restart erased the evidence that anything was running.
 *
 * Only the recipe and the outcome are stored, not the resolved rows: the
 * resolution cache already holds the expensive answers, `addAlbum` is
 * idempotent, so a resumed job re-runs cheaply and cannot double-add.
 */
export const migration_v198: MigrationDefinition = {
	version: 198,
	name: 'music_import_jobs',
	apply: (sqlite) => {
		sqlite.exec(`
			CREATE TABLE IF NOT EXISTS "music_import_jobs" (
				"id" text PRIMARY KEY NOT NULL,
				"url" text NOT NULL,
				"recipe" text NOT NULL,
				"phase" text NOT NULL,
				"progress" text NOT NULL,
				"summary" text,
				"result" text,
				"error" text,
				"created_at" text NOT NULL,
				"updated_at" text NOT NULL
			)
		`);
		sqlite.exec(
			`CREATE INDEX IF NOT EXISTS "idx_music_import_jobs_created" ON "music_import_jobs" ("created_at")`
		);
	}
};
