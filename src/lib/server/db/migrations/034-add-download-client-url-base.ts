import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 34: Add url_base column to download_clients

export const migration_v034: MigrationDefinition = {
	version: 34,
	name: 'add_download_client_url_base',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'download_clients', 'url_base')) {
			sqlite.prepare(`ALTER TABLE "download_clients" ADD COLUMN "url_base" text`).run();
			logger.info('[SchemaSync] Added url_base column to download_clients');
		}
	}
};
