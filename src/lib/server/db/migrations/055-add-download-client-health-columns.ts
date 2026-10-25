import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Migration 55: Add health tracking columns to download_clients

export const migration_v055: MigrationDefinition = {
	version: 55,
	name: 'add_download_client_health_columns',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'download_clients', 'health')) {
			sqlite
				.prepare(`ALTER TABLE "download_clients" ADD COLUMN "health" text DEFAULT 'healthy'`)
				.run();
			logger.info('[SchemaSync] Added health column to download_clients');
		}
		if (!columnExists(sqlite, 'download_clients', 'consecutive_failures')) {
			sqlite
				.prepare(
					`ALTER TABLE "download_clients" ADD COLUMN "consecutive_failures" integer DEFAULT 0`
				)
				.run();
			logger.info('[SchemaSync] Added consecutive_failures column to download_clients');
		}
		if (!columnExists(sqlite, 'download_clients', 'last_success')) {
			sqlite.prepare(`ALTER TABLE "download_clients" ADD COLUMN "last_success" text`).run();
			logger.info('[SchemaSync] Added last_success column to download_clients');
		}
		if (!columnExists(sqlite, 'download_clients', 'last_failure')) {
			sqlite.prepare(`ALTER TABLE "download_clients" ADD COLUMN "last_failure" text`).run();
			logger.info('[SchemaSync] Added last_failure column to download_clients');
		}
		if (!columnExists(sqlite, 'download_clients', 'last_failure_message')) {
			sqlite.prepare(`ALTER TABLE "download_clients" ADD COLUMN "last_failure_message" text`).run();
			logger.info('[SchemaSync] Added last_failure_message column to download_clients');
		}
		if (!columnExists(sqlite, 'download_clients', 'last_checked_at')) {
			sqlite.prepare(`ALTER TABLE "download_clients" ADD COLUMN "last_checked_at" text`).run();
			logger.info('[SchemaSync] Added last_checked_at column to download_clients');
		}
	}
};
