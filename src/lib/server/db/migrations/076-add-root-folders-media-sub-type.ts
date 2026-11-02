import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
export const migration_v076: MigrationDefinition = {
	version: 76,
	name: 'add_root_folders_media_sub_type',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'root_folders')) {
			logger.info('[SchemaSync] root_folders table not found, skipping media_sub_type migration');
			return;
		}

		if (!columnExists(sqlite, 'root_folders', 'media_sub_type')) {
			sqlite
				.prepare(
					`ALTER TABLE "root_folders" ADD COLUMN "media_sub_type" text DEFAULT 'standard' NOT NULL`
				)
				.run();
			logger.info('[SchemaSync] Added media_sub_type column to root_folders');
		}

		sqlite
			.prepare(
				`UPDATE "root_folders"
				SET "media_sub_type" = 'standard'
				WHERE "media_sub_type" IS NULL OR TRIM("media_sub_type") = ''`
			)
			.run();
	}
};
