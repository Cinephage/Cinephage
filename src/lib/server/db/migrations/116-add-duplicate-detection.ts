import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v116: MigrationDefinition = {
	version: 116,
	name: 'add_duplicate_detection_support',
	apply: (sqlite) => {
		try {
			for (const table of ['movie_files', 'episode_files', 'unmatched_files']) {
				for (const col of ['filename_signature', 'content_hash', 'content_hash_algorithm']) {
					try {
						sqlite.prepare(`ALTER TABLE "${table}" ADD COLUMN "${col}" text`).run();
					} catch {
						/* column may already exist */
					}
				}
			}
			try {
				sqlite
					.prepare(
						`CREATE TABLE IF NOT EXISTS "duplicate_group_suppression" (
						"id" text PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
						"library_id" text REFERENCES "libraries"("id") ON DELETE CASCADE,
						"signature" text NOT NULL,
						"signature_type" text NOT NULL,
						"dismissed_at" text NOT NULL DEFAULT (datetime('now')),
						"created_at" text NOT NULL DEFAULT (datetime('now'))
					)`
					)
					.run();
			} catch {
				/* index/table may already exist — safe to ignore */
			}
			logger.info('[migration v116] Duplicate detection columns added');
		} catch (e) {
			logger.info(
				{ err: e instanceof Error ? e.message : String(e) },
				'[migration v116] Columns may already exist, skipping'
			);
		}
	}
};
