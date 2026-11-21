import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 194: `albums.release_date`.
 *
 * `year` was enough for a list row but not for a calendar: a day needs the
 * full first-release date MusicBrainz already returns. Additive ALTER.
 */
export const migration_v194: MigrationDefinition = {
	version: 194,
	name: 'album_release_date',
	apply: (sqlite) => {
		const columns = sqlite.prepare(`PRAGMA table_info("albums")`).all() as Array<{ name: string }>;
		if (!columns.some((column) => column.name === 'release_date')) {
			sqlite.prepare(`ALTER TABLE "albums" ADD COLUMN "release_date" text`).run();
		}
	}
};
