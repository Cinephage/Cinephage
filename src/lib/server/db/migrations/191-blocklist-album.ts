import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 191: `blocklist.album_id`.
 *
 * A failed album import had nowhere to attach the blocked release, and the
 * music grab path did not consult the blocklist at all. Album identity lets a
 * bad release be remembered per album and skipped on the next search.
 *
 * Additive ALTER — no table rebuild.
 */
export const migration_v191: MigrationDefinition = {
	version: 191,
	name: 'blocklist_album',
	apply: (sqlite) => {
		const columns = sqlite.prepare(`PRAGMA table_info("blocklist")`).all() as Array<{
			name: string;
		}>;

		if (!columns.some((column) => column.name === 'album_id')) {
			sqlite
				.prepare(
					`ALTER TABLE "blocklist" ADD COLUMN "album_id" text REFERENCES "albums"("id") ON DELETE CASCADE`
				)
				.run();
		}

		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS "idx_blocklist_album" ON "blocklist" ("album_id")`)
			.run();
	}
};
