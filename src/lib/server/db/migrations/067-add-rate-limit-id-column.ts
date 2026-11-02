import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists, ensureColumn } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 67: Better Auth now generates IDs for rateLimit rows; ensure column exists on upgraded DBs

export const migration_v067: MigrationDefinition = {
	version: 67,
	name: 'add_rate_limit_id_column',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'rateLimit')) {
			logger.info('[SchemaSync] rateLimit table not found, skipping id column migration');
			return;
		}

		ensureColumn(sqlite, 'rateLimit', 'id', '"id" text');
		ensureColumn(sqlite, 'rateLimit', 'key', '"key" text');
		ensureColumn(sqlite, 'rateLimit', 'count', '"count" integer NOT NULL DEFAULT 0');
		ensureColumn(sqlite, 'rateLimit', 'lastRequest', '"lastRequest" integer NOT NULL DEFAULT 0');

		const backfilled = sqlite
			.prepare(
				`UPDATE "rateLimit" SET "id" = lower(hex(randomblob(16))) WHERE "id" IS NULL OR "id" = ''`
			)
			.run();
		if (backfilled.changes > 0) {
			logger.info(
				{
					rows: backfilled.changes
				},
				'[SchemaSync] Backfilled missing rateLimit.id values'
			);
		}

		sqlite
			.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_rateLimit_key" ON "rateLimit" ("key")`)
			.run();
		sqlite
			.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_rateLimit_id" ON "rateLimit" ("id")`)
			.run();
	}
};
