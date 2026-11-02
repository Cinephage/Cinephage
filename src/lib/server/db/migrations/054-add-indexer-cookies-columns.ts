import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Migration 54: Add cookie persistence columns to indexer_status for session storage

export const migration_v054: MigrationDefinition = {
	version: 54,
	name: 'add_indexer_cookies_columns',
	apply: (sqlite) => {
		// Add cookies column (JSON object storing cookie name/value pairs)
		if (!columnExists(sqlite, 'indexer_status', 'cookies')) {
			sqlite.prepare(`ALTER TABLE "indexer_status" ADD COLUMN "cookies" text`).run();
			logger.info('[SchemaSync] Added cookies column to indexer_status');
		} else {
			logger.info('[SchemaSync] cookies column already exists in indexer_status');
		}

		// Add cookies_expiration_date column (ISO timestamp for session expiry)
		if (!columnExists(sqlite, 'indexer_status', 'cookies_expiration_date')) {
			sqlite
				.prepare(`ALTER TABLE "indexer_status" ADD COLUMN "cookies_expiration_date" text`)
				.run();
			logger.info('[SchemaSync] Added cookies_expiration_date column to indexer_status');
		} else {
			logger.info('[SchemaSync] cookies_expiration_date column already exists in indexer_status');
		}
	}
};
