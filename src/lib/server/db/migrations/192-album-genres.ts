import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 192: `albums.genres`.
 *
 * MusicBrainz release groups carry genres, but the album row had nowhere to
 * keep them, so the album page could not show what a movie page shows. Cached
 * as JSON; refresh/rematch rewrite it.
 *
 * Additive ALTER — no rebuild.
 */
export const migration_v192: MigrationDefinition = {
	version: 192,
	name: 'album_genres',
	apply: (sqlite) => {
		const columns = sqlite.prepare(`PRAGMA table_info("albums")`).all() as Array<{ name: string }>;

		if (!columns.some((column) => column.name === 'genres')) {
			sqlite.prepare(`ALTER TABLE "albums" ADD COLUMN "genres" text`).run();
		}
	}
};
