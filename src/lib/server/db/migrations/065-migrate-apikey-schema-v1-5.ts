import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 65: Migrate Better Auth apiKey table from v1.4 to v1.5 schema
// Changes: userId -> referenceId, adds configId column

export const migration_v065: MigrationDefinition = {
	version: 65,
	name: 'migrate_apikey_schema_v1_5',
	apply: (sqlite) => {
		logger.info('[SchemaSync] Checking apiKey table schema for v1.5 migration...');

		// Check if apikey table exists (SQLite table names are case-insensitive, but we use lowercase)
		const tableExists = sqlite
			.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='apikey'`)
			.get();

		if (!tableExists) {
			logger.info('[SchemaSync] apikey table not found, skipping v1.5 migration');
			return;
		}

		// Check current columns
		const columns = sqlite.prepare(`PRAGMA table_info(apikey)`).all() as Array<{ name: string }>;
		const hasUserId = columns.some((col) => col.name === 'userId');
		const hasReferenceId = columns.some((col) => col.name === 'referenceId');
		const hasConfigId = columns.some((col) => col.name === 'configId');

		if (!hasUserId && hasReferenceId) {
			logger.info('[SchemaSync] apikey table already migrated to v1.5 schema');

			// Ensure configId exists even if userId was already renamed
			if (!hasConfigId) {
				sqlite.prepare(`ALTER TABLE apikey ADD COLUMN configId TEXT DEFAULT 'default'`).run();
				logger.info('[SchemaSync] Added configId column to apikey table');
			}
			return;
		}

		if (hasUserId && hasReferenceId) {
			// A table with BOTH columns is a corrupted intermediate state that
			// current code paths never create; the rename below would fail on
			// it. Drop the stray legacy column instead.
			try {
				sqlite.prepare(`ALTER TABLE apikey DROP COLUMN userId`).run();
				logger.info('[SchemaSync] Dropped stray apikey.userId column');
			} catch {
				logger.warn('[SchemaSync] Could not drop stray apikey.userId column');
			}
		}

		if (hasUserId && !hasReferenceId) {
			// Rename userId to referenceId
			logger.info('[SchemaSync] Renaming apikey.userId to referenceId...');
			sqlite.prepare(`ALTER TABLE apikey RENAME COLUMN userId TO referenceId`).run();
			logger.info('[SchemaSync] Renamed apikey column to referenceId');
		}

		// Add configId column if it doesn't exist
		if (!hasConfigId) {
			sqlite.prepare(`ALTER TABLE apikey ADD COLUMN configId TEXT DEFAULT 'default'`).run();
			logger.info('[SchemaSync] Added configId column to apikey table');
		}

		// Recreate indexes to use new column name
		sqlite.prepare(`DROP INDEX IF EXISTS apikey_userId_idx`).run();
		sqlite.prepare(`DROP INDEX IF EXISTS idx_apikey_user`).run();
		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS apikey_referenceId_idx ON apikey(referenceId)`)
			.run();
		sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_apikey_reference ON apikey(referenceId)`).run();
		logger.info('[SchemaSync] Recreated apikey indexes for referenceId');

		logger.info('[SchemaSync] apikey v1.5 migration completed successfully');
	}
};
