import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 66: Fix apikey schema migration for databases stuck at v65
// Some databases reached v65 but the migration didn't run due to case-sensitivity bug

export const migration_v066: MigrationDefinition = {
	version: 66,
	name: 'fix_apikey_schema_v1_5_stuck',
	apply: (sqlite) => {
		logger.info('[SchemaSync] Checking for stuck apikey schema migration...');

		// Check if apikey table exists
		const tableExists = sqlite
			.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='apikey'`)
			.get();

		if (!tableExists) {
			logger.info('[SchemaSync] apikey table not found, skipping');
			return;
		}

		// Check current columns
		const columns = sqlite.prepare(`PRAGMA table_info(apikey)`).all() as Array<{ name: string }>;
		const hasUserId = columns.some((col) => col.name === 'userId');
		const hasReferenceId = columns.some((col) => col.name === 'referenceId');
		const hasConfigId = columns.some((col) => col.name === 'configId');

		if (!hasUserId && hasReferenceId && hasConfigId) {
			logger.info('[SchemaSync] apikey table properly migrated, no fix needed');
			return;
		}

		logger.info('[SchemaSync] Fixing stuck apikey schema migration...');

		if (hasUserId && hasReferenceId) {
			// Both columns present is a corrupted intermediate state; the
			// rename below would fail on it. Drop the stray legacy column.
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

		logger.info('[SchemaSync] apikey schema fix completed successfully');
	}
};
