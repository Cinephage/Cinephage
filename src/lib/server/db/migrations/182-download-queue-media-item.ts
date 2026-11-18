import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 182: `download_queue.media_item_id`.
 *
 * Music grabs need a subject, and a movie/series column pair is exactly the shape
 * the media-kind audit says to stop growing. Albums already have a `media_items`
 * row (the spine), so a music grab points at that instead. Nullable: every
 * existing grab keeps using `movie_id`/`series_id` untouched.
 *
 * Additive ALTER, not a rebuild — no CHECK is involved. The column is added only
 * when it is missing, because a fresh database gets it from TABLE_DEFINITIONS
 * and then replays this migration.
 */
export const migration_v182: MigrationDefinition = {
	version: 182,
	name: 'download_queue_media_item',
	apply: (sqlite) => {
		const columns = sqlite.prepare(`PRAGMA table_info("download_queue")`).all() as Array<{
			name: string;
		}>;
		if (columns.some((column) => column.name === 'media_item_id')) return;

		sqlite
			.prepare(
				`ALTER TABLE "download_queue" ADD COLUMN "media_item_id" text
				 REFERENCES "media_items"("id") ON DELETE SET NULL`
			)
			.run();

		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_download_queue_media_item"
				 ON "download_queue" ("media_item_id")`
			)
			.run();
	}
};
