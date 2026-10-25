import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 35: Add mount_mode column to download_clients

export const migration_v035: MigrationDefinition = {
	version: 35,
	name: 'add_download_client_mount_mode',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'download_clients', 'mount_mode')) {
			sqlite.prepare(`ALTER TABLE "download_clients" ADD COLUMN "mount_mode" text`).run();
			logger.info('[SchemaSync] Added mount_mode column to download_clients');
		}
	}
};
