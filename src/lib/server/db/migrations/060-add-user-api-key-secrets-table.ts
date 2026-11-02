import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Migration 60: Add user_api_key_secrets table for encrypted API key storage

export const migration_v060: MigrationDefinition = {
	version: 60,
	name: 'add_user_api_key_secrets_table',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'userApiKeySecrets')) {
			sqlite
				.prepare(
					`
				CREATE TABLE "userApiKeySecrets" (
					"id" TEXT PRIMARY KEY NOT NULL,
					"userId" TEXT NOT NULL,
					"encryptedKey" TEXT NOT NULL,
					"createdAt" TEXT NOT NULL,
					FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE
				)
			`
				)
				.run();
			sqlite
				.prepare(`CREATE INDEX "idx_userApiKeySecrets_userId" ON "userApiKeySecrets"("userId")`)
				.run();
			logger.info('[SchemaSync] Created userApiKeySecrets table');
		} else {
			logger.info('[SchemaSync] userApiKeySecrets table already exists');
		}
	}
};
