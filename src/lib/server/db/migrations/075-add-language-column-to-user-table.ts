import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
export const migration_v075: MigrationDefinition = {
	version: 75,
	name: 'add_language_column_to_user_table',
	apply: (sqlite) => {
		// Check if user table exists
		if (!tableExists(sqlite, 'user')) {
			logger.info('[SchemaSync] user table not found, skipping language column migration');
			return;
		}

		// Check if language column already exists
		const tableInfo = sqlite.prepare(`PRAGMA table_info("user")`).all() as Array<{
			name: string;
		}>;
		const hasLanguageColumn = tableInfo.some((col) => col.name === 'language');

		if (hasLanguageColumn) {
			logger.info('[SchemaSync] language column already exists in user table');
			return;
		}

		// Add language column with default 'en'
		sqlite.prepare(`ALTER TABLE "user" ADD COLUMN "language" text DEFAULT 'en'`).run();
		logger.info('[SchemaSync] Added language column to user table');
	}
};
