import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 199: `tracks.monitored`.
 *
 * Importing a playlist is often "I want this song", not "I want this album".
 * The album row and full tracklist land as usual — acquisition stays
 * album-level — but only the tracks the playlist named are wanted, so a later
 * per-track search has something to work from.
 */
export const migration_v199: MigrationDefinition = {
	version: 199,
	name: 'tracks_monitored',
	apply: (sqlite) => {
		// A database created after this column existed in the schema already has
		// it; the migration still has to run for older ones.
		const columns = sqlite.prepare(`PRAGMA table_info("tracks")`).all() as Array<{ name: string }>;
		if (!columns.some((column) => column.name === 'monitored')) {
			sqlite.prepare(`ALTER TABLE "tracks" ADD COLUMN "monitored" integer NOT NULL DEFAULT 1`).run();
		}
	}
};
