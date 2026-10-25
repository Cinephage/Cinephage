import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 12: Add media_browser_servers table for Jellyfin/Emby integration

export const migration_v012: MigrationDefinition = {
	version: 12,
	name: 'add_media_browser_servers',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'media_browser_servers')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "media_browser_servers" (
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
		}
		logger.info('[SchemaSync] Added media_browser_servers table for Jellyfin/Emby integration');
	}
};
