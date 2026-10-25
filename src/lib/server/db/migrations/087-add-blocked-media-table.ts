import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v087: MigrationDefinition = {
	version: 87,
	name: 'add_blocked_media_table',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'blocked_media')) {
			sqlite
				.prepare(
					`CREATE TABLE "blocked_media" (
						"id" text PRIMARY KEY NOT NULL,
						"tmdb_id" integer NOT NULL,
						"media_type" text NOT NULL,
						"title" text NOT NULL,
						"poster_path" text,
						"year" integer,
						"reason" text,
						"created_at" text
					)`
				)
				.run();
		}

		sqlite
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS "idx_blocked_media_unique" ON "blocked_media" ("tmdb_id", "media_type")`
			)
			.run();

		logger.info('[SchemaSync] Ensured blocked_media table and indexes (v87)');
	}
};
