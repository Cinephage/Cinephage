import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 157: user_media_server_links.
 *
 * Identity mapping between a Cinephage account and its media-server
 * (Jellyfin) account. Stores the server user id plus a username snapshot —
 * deliberately no per-user tokens: pairing proves identity and the
 * server-side admin key handles data access internally.
 */
export const migration_v157: MigrationDefinition = {
	version: 157,
	name: 'user_media_server_links',
	apply: (sqlite) => {
		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "user_media_server_links" (
		"id" text PRIMARY KEY NOT NULL,
		"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
		"server_id" text NOT NULL REFERENCES "media_browser_servers"("id") ON DELETE CASCADE,
		"server_user_id" text NOT NULL,
		"server_username" text NOT NULL,
		"linked_at" text,
		"created_at" text
	)`
			)
			.run();

		sqlite
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_media_server_links_server_user"
			ON "user_media_server_links" ("server_id", "server_user_id")`
			)
			.run();

		sqlite
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_media_server_links_user_server"
			ON "user_media_server_links" ("user_id", "server_id")`
			)
			.run();
	}
};
