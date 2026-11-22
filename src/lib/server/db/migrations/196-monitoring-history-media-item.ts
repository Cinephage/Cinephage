import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 196: `monitoring_history.media_item_id`.
 *
 * Music's acquisition unit is the album, and a search attempt needs a subject
 * the same way a movie attempt carries movie_id. `media_items` is the identity
 * row queue and history already join on, so the Searches tab resolves an album
 * through the same map instead of a parallel id.
 *
 * Additive ALTER; `media_items.kind` has no CHECK, so no table rebuild.
 */
export const migration_v196: MigrationDefinition = {
	version: 196,
	name: 'monitoring_history_media_item',
	apply: (sqlite) => {
		const columns = sqlite.prepare(`PRAGMA table_info("monitoring_history")`).all() as Array<{
			name: string;
		}>;

		if (!columns.some((column) => column.name === 'media_item_id')) {
			sqlite
				.prepare(
					`ALTER TABLE "monitoring_history" ADD COLUMN "media_item_id" text REFERENCES "media_items"("id") ON DELETE CASCADE`
				)
				.run();
		}
	}
};
