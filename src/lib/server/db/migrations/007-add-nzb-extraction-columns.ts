import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 7: Add streamability and extraction columns for compressed archive support

export const migration_v007: MigrationDefinition = {
	version: 7,
	name: 'add_nzb_extraction_columns',
	apply: (sqlite) => {
		// Add new columns to nzb_stream_mounts (only if they don't exist)
		if (!columnExists(sqlite, 'nzb_stream_mounts', 'streamability')) {
			sqlite.prepare(`ALTER TABLE "nzb_stream_mounts" ADD COLUMN "streamability" text`).run();
		}
		if (!columnExists(sqlite, 'nzb_stream_mounts', 'extracted_file_path')) {
			sqlite.prepare(`ALTER TABLE "nzb_stream_mounts" ADD COLUMN "extracted_file_path" text`).run();
		}
		if (!columnExists(sqlite, 'nzb_stream_mounts', 'extraction_progress')) {
			sqlite
				.prepare(`ALTER TABLE "nzb_stream_mounts" ADD COLUMN "extraction_progress" integer`)
				.run();
		}

		logger.info('[SchemaSync] Added streamability and extraction columns to nzb_stream_mounts');
	}
};
