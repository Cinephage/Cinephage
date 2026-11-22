import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 195: `media_server_synced_items.artist_name` / `album_name`.
 *
 * Media-server stats only synced video. A track has no TMDB identity, so its
 * grouping keys — the artist and the album — need columns of their own; the
 * track row itself keeps `title`. Additive ALTERs.
 */
export const migration_v195: MigrationDefinition = {
	version: 195,
	name: 'synced_track_identity',
	apply: (sqlite) => {
		const columns = sqlite
			.prepare(`PRAGMA table_info("media_server_synced_items")`)
			.all() as Array<{ name: string }>;
		const names = new Set(columns.map((column) => column.name));

		if (!names.has('artist_name')) {
			sqlite.prepare(`ALTER TABLE "media_server_synced_items" ADD COLUMN "artist_name" text`).run();
		}
		if (!names.has('album_name')) {
			sqlite.prepare(`ALTER TABLE "media_server_synced_items" ADD COLUMN "album_name" text`).run();
		}
	}
};
