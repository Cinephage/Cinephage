import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
export const migration_v073: MigrationDefinition = {
	version: 73,
	name: 'allow_plex_media_browser_servers',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'media_browser_servers')) {
			return;
		}

		const tableInfo = sqlite
			.prepare(
				`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_browser_servers'`
			)
			.get() as { sql?: string } | undefined;

		if (tableInfo?.sql?.includes(`'plex'`)) {
			logger.info('[SchemaSync] media_browser_servers already allows plex');
			return;
		}

		sqlite.transaction(() => {
			sqlite
				.prepare(`ALTER TABLE "media_browser_servers" RENAME TO "media_browser_servers_old"`)
				.run();
			sqlite
				.prepare(
					`CREATE TABLE "media_browser_servers" (
					"id" text PRIMARY KEY NOT NULL,
					"name" text NOT NULL,
					"server_type" text NOT NULL CHECK ("server_type" IN ('jellyfin', 'emby', 'plex')),
					"host" text NOT NULL,
					"api_key" text NOT NULL,
					"enabled" integer DEFAULT 1,
					"on_import" integer DEFAULT 1,
					"on_upgrade" integer DEFAULT 1,
					"on_rename" integer DEFAULT 1,
					"on_delete" integer DEFAULT 1,
					"path_mappings" text,
					"server_name" text,
					"server_version" text,
					"server_id" text,
					"last_tested_at" text,
					"test_result" text,
					"test_error" text,
					"created_at" text,
					"updated_at" text
				)`
				)
				.run();
			sqlite
				.prepare(
					`INSERT INTO "media_browser_servers" (
						"id", "name", "server_type", "host", "api_key", "enabled", "on_import",
						"on_upgrade", "on_rename", "on_delete", "path_mappings", "server_name",
						"server_version", "server_id", "last_tested_at", "test_result", "test_error",
						"created_at", "updated_at"
					)
					SELECT
						"id", "name", "server_type", "host", "api_key", "enabled", "on_import",
						"on_upgrade", "on_rename", "on_delete", "path_mappings", "server_name",
						"server_version", "server_id", "last_tested_at", "test_result", "test_error",
						"created_at", "updated_at"
					FROM "media_browser_servers_old"`
				)
				.run();
			sqlite.prepare(`DROP TABLE "media_browser_servers_old"`).run();
		})();

		logger.info('[SchemaSync] Updated media_browser_servers to allow plex');
	}
};
