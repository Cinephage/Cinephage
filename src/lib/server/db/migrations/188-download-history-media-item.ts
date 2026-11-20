import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 188: finished music grabs need the same `media_items` link the queue
 * row already carries. Without it, Activity can only resolve video history and
 * a completed album disappears after import. Additive and nullable; video rows
 * stay null.
 */
function hasColumn(
	sqlite: Parameters<MigrationDefinition['apply']>[0],
	table: string,
	column: string
) {
	const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
	return columns.some((entry) => entry.name === column);
}

export const migration_v188: MigrationDefinition = {
	version: 188,
	name: 'download_history_media_item',
	apply: (sqlite) => {
		if (!hasColumn(sqlite, 'download_history', 'media_item_id')) {
			sqlite
				.prepare(
					`ALTER TABLE "download_history" ADD COLUMN "media_item_id" text REFERENCES "media_items"("id") ON DELETE SET NULL`
				)
				.run();
		}
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_dh_media_item" ON "download_history" ("media_item_id")`
			)
			.run();
	}
};
