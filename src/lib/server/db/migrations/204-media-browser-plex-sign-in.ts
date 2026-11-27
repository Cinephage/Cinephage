import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 204: `media_browser_servers.plex_sign_in`.
 *
 * "Sign in with Plex" is opt-in per Plex server: the admin chooses it when
 * adding or editing the server. Off by default, so configuring a Plex server
 * for library notifications never silently opens a new way to sign in.
 */
export const migration_v204: MigrationDefinition = {
	version: 204,
	name: 'media_browser_plex_sign_in',
	apply: (sqlite) => {
		// A database created after this column existed in the schema already has
		// it; the migration still has to run for older ones.
		const columns = sqlite.prepare(`PRAGMA table_info("media_browser_servers")`).all() as Array<{
			name: string;
		}>;
		if (columns.length > 0 && !columns.some((column) => column.name === 'plex_sign_in')) {
			sqlite
				.prepare(
					`ALTER TABLE "media_browser_servers" ADD COLUMN "plex_sign_in" integer NOT NULL DEFAULT 0`
				)
				.run();
		}
	}
};
