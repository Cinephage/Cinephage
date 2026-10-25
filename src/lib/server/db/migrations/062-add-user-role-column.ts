import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 62: Add role column to user table for RBAC

export const migration_v062: MigrationDefinition = {
	version: 62,
	name: 'add_user_role_column',
	apply: (sqlite) => {
		// Check if user table exists (Better Auth managed)
		const userTableExists = sqlite
			.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='user'`)
			.get();

		if (userTableExists) {
			// Check if role column already exists
			const columnInfo = sqlite.prepare(`PRAGMA table_info("user")`).all() as Array<{
				name: string;
			}>;
			const roleColumnExists = columnInfo.some((col) => col.name === 'role');

			if (!roleColumnExists) {
				// Add role column with default 'admin' for existing users
				sqlite.prepare(`ALTER TABLE "user" ADD COLUMN "role" text DEFAULT 'admin' NOT NULL`).run();
				logger.info('[SchemaSync] Added role column to user table');
			} else {
				logger.info('[SchemaSync] role column already exists in user table');
			}

			// Update any users without a role to be 'admin'
			const updateResult = sqlite
				.prepare(`UPDATE "user" SET "role" = 'admin' WHERE "role" IS NULL OR "role" = ''`)
				.run();
			if (updateResult.changes > 0) {
				logger.info(`[SchemaSync] Updated ${updateResult.changes} users to have admin role`);
			}
		} else {
			logger.info('[SchemaSync] user table not found, skipping migration');
		}
	}
};
