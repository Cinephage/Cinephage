import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v112: MigrationDefinition = {
	version: 112,
	name: 'add_pattern_recognition_support',
	apply: (sqlite) => {
		// Add content_category to movie_files
		try {
			sqlite
				.prepare(
					`ALTER TABLE "movie_files" ADD COLUMN "content_category" text NOT NULL DEFAULT 'main'`
				)
				.run();
		} catch {
			logger.info('[migration v112] movie_files.content_category already exists, skipping');
		}

		// Add content_category to episode_files
		try {
			sqlite
				.prepare(
					`ALTER TABLE "episode_files" ADD COLUMN "content_category" text NOT NULL DEFAULT 'main'`
				)
				.run();
		} catch {
			logger.info('[migration v112] episode_files.content_category already exists, skipping');
		}

		// Add content_category to unmatched_files
		try {
			sqlite
				.prepare(
					`ALTER TABLE "unmatched_files" ADD COLUMN "content_category" text NOT NULL DEFAULT 'main'`
				)
				.run();
		} catch {
			logger.info('[migration v112] unmatched_files.content_category already exists, skipping');
		}

		// Create library_pattern_config table
		if (!tableExists(sqlite, 'library_pattern_config')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "library_pattern_config" (
						"id" text PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
						"library_id" text REFERENCES "libraries"("id") ON DELETE CASCADE,
						"scope" text NOT NULL,
						"ignore_defaults_enabled" integer NOT NULL DEFAULT 1,
						"ignore_user_patterns" text,
						"bonus_patterns" text,
						"structure_mode" text,
						"structure_config" text,
						"created_at" text NOT NULL DEFAULT (datetime('now')),
						"updated_at" text NOT NULL DEFAULT (datetime('now'))
					)`
				)
				.run();

			logger.info('[migration v112] Created library_pattern_config table');
		}
	}
};
