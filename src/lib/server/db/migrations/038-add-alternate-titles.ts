import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 38: Add alternate_titles table for multi-title search support

export const migration_v038: MigrationDefinition = {
	version: 38,
	name: 'add_alternate_titles',
	apply: (sqlite) => {
		// Create the alternate_titles table if it doesn't exist
		if (!tableExists(sqlite, 'alternate_titles')) {
			sqlite
				.prepare(
					`CREATE TABLE "alternate_titles" (
						"id" integer PRIMARY KEY AUTOINCREMENT,
						"media_type" text NOT NULL CHECK ("media_type" IN ('movie', 'series')),
						"media_id" text NOT NULL,
						"title" text NOT NULL,
						"clean_title" text NOT NULL,
						"source" text NOT NULL CHECK ("source" IN ('tmdb', 'user')),
						"language" text,
						"country" text,
						"created_at" text
					)`
				)
				.run();

			// Create indexes for efficient lookup
			sqlite
				.prepare(
					`CREATE INDEX "idx_alternate_titles_media" ON "alternate_titles" ("media_type", "media_id")`
				)
				.run();
			sqlite
				.prepare(`CREATE INDEX "idx_alternate_titles_source" ON "alternate_titles" ("source")`)
				.run();

			logger.info('[SchemaSync] Created alternate_titles table for multi-title search support');
		}
	}
};
