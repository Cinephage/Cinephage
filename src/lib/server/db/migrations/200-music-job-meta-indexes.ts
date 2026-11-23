import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 200: the job row carries the counters a returning user sees, and the
 * two queries the music surfaces run get their indexes.
 *
 * `music_import_jobs.meta` keeps track/truncation/unmatched state that used to
 * exist only in memory, so a job loaded after a restart reviews like the live
 * one. The indexes are the Activity and calendar paths, both of which scan on
 * every request without them.
 */
export const migration_v200: MigrationDefinition = {
	version: 200,
	name: 'music_job_meta_indexes',
	apply: (sqlite) => {
		const columns = sqlite.prepare(`PRAGMA table_info("music_import_jobs")`).all() as Array<{
			name: string;
		}>;
		if (!columns.some((column) => column.name === 'meta')) {
			sqlite.prepare(`ALTER TABLE "music_import_jobs" ADD COLUMN "meta" text`).run();
		}
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_monitoring_history_media_item" ON "monitoring_history" ("media_item_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_albums_monitored_release_date" ON "albums" ("monitored", "release_date")`
			)
			.run();
	}
};
