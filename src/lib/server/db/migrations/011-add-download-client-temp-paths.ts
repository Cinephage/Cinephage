import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 11: Add temp path columns to download_clients for SABnzbd dual folder support

export const migration_v011: MigrationDefinition = {
	version: 11,
	name: 'add_download_client_temp_paths',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'download_clients', 'temp_path_local')) {
			sqlite.prepare(`ALTER TABLE download_clients ADD COLUMN temp_path_local TEXT`).run();
		}
		if (!columnExists(sqlite, 'download_clients', 'temp_path_remote')) {
			sqlite.prepare(`ALTER TABLE download_clients ADD COLUMN temp_path_remote TEXT`).run();
		}
		logger.info('[SchemaSync] Added temp path columns to download_clients for SABnzbd');
	}
};
