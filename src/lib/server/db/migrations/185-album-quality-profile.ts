import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 185: `albums.quality_profile_id`.
 *
 * Music quality was a hardcoded ladder, so an album page had no control to
 * change it — the one thing movie and TV detail pages always offered. The
 * column stores a code-defined profile id (`music/profiles.ts`); null means
 * the built-in default, which is exactly the old behaviour.
 *
 * Additive ALTER — no table rebuild, no FK because the profiles are constants.
 */
export const migration_v185: MigrationDefinition = {
	version: 185,
	name: 'album_quality_profile',
	apply: (sqlite) => {
		const columns = sqlite.prepare(`PRAGMA table_info("albums")`).all() as Array<{ name: string }>;

		if (!columns.some((column) => column.name === 'quality_profile_id')) {
			sqlite.prepare(`ALTER TABLE "albums" ADD COLUMN "quality_profile_id" text`).run();
		}
	}
};
